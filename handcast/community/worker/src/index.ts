/**
 * HANDCAST "Hall of Hands" backend: a Cloudflare Worker (module syntax) over
 * D1. Every level and solution is re-validated with the game's own pure core
 * modules (codec, privacy, moderation -> hand-features + trace2d), bundled by
 * wrangler from ../../../src/core: a level is accepted only if its author's
 * anonymised casts solve it within budget, a solution only if it re-traces.
 *
 * Routes (JSON in/out; writes need an `X-Handcast-Device` id header):
 *   GET  /levels?sort=new|top|featured&cursor=&limit=
 *   GET  /levels/:id
 *   POST /levels                  {code}
 *   POST /levels/:id/solutions    {casts: castCode[]}
 *   GET  /levels/:id/hands?limit=30   -> {hands: castCode[]}
 *   POST /levels/:id/like
 *   POST /levels/:id/report       {reason}
 *   GET  /daily/:YYYY-MM-DD
 * CORS is locked to ALLOWED_ORIGIN (+ localhost); writes are rate limited per
 * device and per IP (D1 counters) and reads per IP (per-isolate memory).
 */
import { CodecError, decodeCast, decodeLevel, encodeCast, encodeLevel } from '../../../src/core/codec';
import {
  checkLevelPublishable, fnv1a, PUBLISH_LIMITS, poseFingerprint, sanitizeForPublish, verifySolution,
} from '../../../src/core/moderation';
import { anonymizeCast } from '../../../src/core/privacy';
import type { CastData } from '../../../src/core/types';
import type { HallEntry } from '../../../src/community/client';

// ------------------------------------------------------------------ D1 (minimal typings)

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  HALL: D1Database;
  ALLOWED_ORIGIN?: string;
  /** Optional secret salting the device/IP hashes (`wrangler secret put HASH_SALT`). */
  HASH_SALT?: string;
}

interface Ctx {
  waitUntil?(p: Promise<unknown>): void;
}

// ------------------------------------------------------------------ limits

const MAX_BODY = 16 * 1024;
const REPORTS_TO_HIDE = 3;
const PAGE = 20;
const MAX_PAGE = 50;
const MAX_OFFSET = 5000;
const HOUR = 3_600_000;
/** Writes per hour: [per device, per IP]. */
const WRITE_LIMITS = {
  publish: [10, 30],
  solve: [120, 400],
  like: [200, 600],
  report: [30, 100],
} as const;
type WriteKind = keyof typeof WRITE_LIMITS;
/** Requests per minute per IP, per isolate. */
const READ_LIMIT = 240;
const REPORT_REASONS = new Set(['offensive', 'broken', 'spam', 'other']);
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ helpers

function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  if (origin === (env.ALLOWED_ORIGIN ?? 'https://mghprojects.github.io')) return origin;
  return DEV_ORIGIN_RE.test(origin) ? origin : null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Handcast-Device';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(data: unknown, status: number, origin: string | null, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(origin), ...extra },
  });
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('Content-Length') ?? '0');
  if (len > MAX_BODY) throw new HttpError(413, 'too_large', 'request body too large');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large', 'request body too large');
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'bad_json', 'body must be a JSON object');
  }
}

interface LevelRow {
  id: string;
  code: string;
  name: string;
  author: string;
  likes: number;
  solves: number;
  featured: number;
  hidden: number;
  created_at: number;
}

const ENTRY_COLS = 'id, code, name, author, likes, solves, featured, hidden, created_at';

function toEntry(r: LevelRow): HallEntry {
  return {
    id: r.id, code: r.code, name: r.name, author: r.author,
    likes: Number(r.likes), solves: Number(r.solves), featured: !!r.featured, createdAt: Number(r.created_at),
  };
}

/** Per-isolate read limiter (best effort; isolates are short-lived and many). */
const readHits = new Map<string, { win: number; n: number }>();
function readLimited(ipKey: string, now: number): boolean {
  const win = Math.floor(now / 60_000);
  const e = readHits.get(ipKey);
  if (!e || e.win !== win) {
    if (readHits.size > 5000) readHits.clear();
    readHits.set(ipKey, { win, n: 1 });
    return false;
  }
  e.n++;
  return e.n > READ_LIMIT;
}

async function writeLimited(env: Env, kind: WriteKind, deviceHash: string, ipHash: string, now: number, ctx?: Ctx): Promise<boolean> {
  const win = Math.floor(now / HOUR);
  const sql = 'INSERT INTO rate (key, win, n) VALUES (?1, ?2, 1) ON CONFLICT (key, win) DO UPDATE SET n = n + 1 RETURNING n';
  const [dev, ip] = await Promise.all([
    env.HALL.prepare(sql).bind(`${kind}:d:${deviceHash}`, win).first<{ n: number }>(),
    env.HALL.prepare(sql).bind(`${kind}:i:${ipHash}`, win).first<{ n: number }>(),
  ]);
  if (Math.random() < 0.02) {
    const prune = env.HALL.prepare('DELETE FROM rate WHERE win < ?1').bind(win - 2).run().catch(() => undefined);
    ctx?.waitUntil?.(prune);
  }
  const [maxDev, maxIp] = WRITE_LIMITS[kind];
  return (dev?.n ?? 0) > maxDev || (ip?.n ?? 0) > maxIp;
}

async function getLevelRow(env: Env, id: string): Promise<LevelRow> {
  if (!ID_RE.test(id)) throw new HttpError(404, 'not_found', 'no such level');
  const row = await env.HALL.prepare(`SELECT ${ENTRY_COLS} FROM levels WHERE id = ?1`).bind(id).first<LevelRow>();
  if (!row || row.hidden) throw new HttpError(404, 'not_found', 'no such level');
  return row;
}

async function decodeCasts(raw: unknown, max: number): Promise<CastData[]> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) throw new HttpError(400, 'bad_casts', `casts must be 1-${max} cast codes`);
  const out: CastData[] = [];
  for (const c of raw) {
    if (typeof c !== 'string' || c.length > 2000) throw new HttpError(400, 'bad_casts', 'casts must be cast codes');
    out.push(await decodeCast(c));
  }
  return out;
}

// ------------------------------------------------------------------ routes

interface Req {
  req: Request;
  env: Env;
  ctx?: Ctx;
  url: URL;
  origin: string | null;
  now: number;
  ipHash: string;
}

async function device(r: Req): Promise<{ id: string; hash: string }> {
  const id = r.req.headers.get('X-Handcast-Device') ?? '';
  if (!DEVICE_RE.test(id)) throw new HttpError(400, 'no_device', 'missing or bad X-Handcast-Device header');
  return { id, hash: await sha(`dev:${r.env.HASH_SALT ?? ''}:${id}`) };
}

async function guardWrite(r: Req, kind: WriteKind): Promise<{ id: string; hash: string }> {
  const dev = await device(r);
  if (await writeLimited(r.env, kind, dev.hash, r.ipHash, r.now, r.ctx)) {
    throw new HttpError(429, 'rate_limited', 'too many requests, try again later');
  }
  return dev;
}

async function listLevels(r: Req): Promise<Response> {
  const sort = r.url.searchParams.get('sort') ?? 'new';
  const limit = Math.max(1, Math.min(MAX_PAGE, Number(r.url.searchParams.get('limit')) || PAGE));
  const offset = Math.max(0, Math.min(MAX_OFFSET, Math.floor(Number(r.url.searchParams.get('cursor')) || 0)));
  let where = 'hidden = 0';
  let order = 'created_at DESC, id';
  if (sort === 'top') order = 'likes DESC, solves DESC, created_at DESC, id';
  else if (sort === 'featured') where = 'featured = 1 AND hidden = 0';
  else if (sort !== 'new') throw new HttpError(400, 'bad_sort', 'sort must be new, top or featured');
  const { results } = await r.env.HALL
    .prepare(`SELECT ${ENTRY_COLS} FROM levels WHERE ${where} ORDER BY ${order} LIMIT ?1 OFFSET ?2`)
    .bind(limit + 1, offset)
    .all<LevelRow>();
  const more = results.length > limit;
  return json(
    { entries: results.slice(0, limit).map(toEntry), cursor: more && offset + limit <= MAX_OFFSET ? String(offset + limit) : null },
    200, r.origin, { 'Cache-Control': 'public, max-age=30' },
  );
}

async function publishLevel(r: Req): Promise<Response> {
  const dev = await guardWrite(r, 'publish');
  const body = await readJson(r.req);
  const code = body.code;
  if (typeof code !== 'string' || code.length > PUBLISH_LIMITS.maxCode) throw new HttpError(400, 'bad_code', 'code must be a share code string');
  const level = await decodeLevel(code);
  if (!level.solution?.length) throw new HttpError(422, 'unsolved', 'a level needs its solution casts');
  const anon = level.solution.map(anonymizeCast);
  const pub = sanitizeForPublish(level, anon, dev.id);
  const chk = checkLevelPublishable(pub);
  if (!chk.ok) throw new HttpError(422, 'rejected', chk.reason ?? 'not publishable');
  const ver = verifySolution(pub, anon);
  if (!ver.ok) throw new HttpError(422, 'unsolved', ver.reason ?? 'the solution does not solve the board');
  const canonical = await encodeLevel(pub);

  const existing = await r.env.HALL.prepare(`SELECT ${ENTRY_COLS} FROM levels WHERE id = ?1`).bind(pub.id).first<LevelRow>();
  if (existing) {
    if (existing.hidden) throw new HttpError(409, 'hidden', 'this level was removed');
    return json({ entry: toEntry(existing), existing: true }, 200, r.origin);
  }
  const castCodes = JSON.stringify(await Promise.all(anon.map(encodeCast)));
  await r.env.HALL.batch([
    r.env.HALL
      .prepare('INSERT INTO levels (id, code, name, author, device_hash, crystals, budget, solves, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)')
      .bind(pub.id, canonical, pub.name, pub.author ?? '', dev.hash, pub.crystals.length, pub.budget, r.now),
    // The maker is the first solver: their hands open the Hall.
    r.env.HALL
      .prepare('INSERT OR IGNORE INTO solutions (level_id, device_hash, fingerprint, n_casts, casts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(pub.id, dev.hash, poseFingerprint(anon), anon.length, castCodes, r.now),
  ]);
  const row = await getLevelRow(r.env, pub.id);
  return json({ entry: toEntry(row) }, 201, r.origin);
}

async function submitSolution(r: Req, id: string): Promise<Response> {
  const dev = await guardWrite(r, 'solve');
  const row = await getLevelRow(r.env, id);
  const body = await readJson(r.req);
  const level = await decodeLevel(row.code);
  const casts = (await decodeCasts(body.casts, PUBLISH_LIMITS.maxCasts)).map(anonymizeCast);
  const ver = verifySolution(level, casts);
  if (!ver.ok) throw new HttpError(422, 'unsolved', ver.reason ?? 'does not solve the board');
  const fp = poseFingerprint(casts);
  const db = r.env.HALL;
  const before = await db.prepare('SELECT 1 AS x FROM solutions WHERE level_id = ?1 AND device_hash = ?2 LIMIT 1').bind(id, dev.hash).first();
  const codes = JSON.stringify(await Promise.all(casts.map(encodeCast)));
  const stmts = [
    db.prepare('INSERT OR IGNORE INTO solutions (level_id, device_hash, fingerprint, n_casts, casts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(id, dev.hash, fp, casts.length, codes, r.now),
  ];
  if (!before) stmts.push(db.prepare('UPDATE levels SET solves = solves + 1 WHERE id = ?1').bind(id));
  await db.batch(stmts);

  const [rank, hands, solvers, same] = await Promise.all([
    db.prepare(
      'SELECT COUNT(DISTINCT device_hash) AS n FROM solutions WHERE level_id = ?1 AND id <= (SELECT MIN(id) FROM solutions WHERE level_id = ?1 AND device_hash = ?2)',
    ).bind(id, dev.hash).first<{ n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT fingerprint) AS n FROM solutions WHERE level_id = ?1').bind(id).first<{ n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT device_hash) AS n FROM solutions WHERE level_id = ?1').bind(id).first<{ n: number }>(),
    db.prepare('SELECT COUNT(DISTINCT device_hash) AS n FROM solutions WHERE level_id = ?1 AND fingerprint = ?2').bind(id, fp).first<{ n: number }>(),
  ]);
  const total = Math.max(1, Number(solvers?.n ?? 1));
  return json({
    rank: Number(rank?.n ?? total),
    distinctHands: Number(hands?.n ?? 1),
    yourShare: Math.round((Number(same?.n ?? 1) / total) * 1000) / 1000,
    solves: total,
    fingerprint: fp,
  }, 200, r.origin);
}

async function listHands(r: Req, id: string): Promise<Response> {
  await getLevelRow(r.env, id);
  const limit = Math.max(1, Math.min(60, Number(r.url.searchParams.get('limit')) || 30));
  const { results } = await r.env.HALL
    .prepare('SELECT fingerprint, casts FROM solutions WHERE level_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 300')
    .bind(id)
    .all<{ fingerprint: string; casts: string }>();
  // One solution per hand shape first (variety), then the rest, newest first.
  const seen = new Set<string>();
  const firsts: string[][] = [];
  const rest: string[][] = [];
  for (const s of results) {
    let codes: string[];
    try {
      codes = (JSON.parse(s.casts) as unknown[]).filter((c): c is string => typeof c === 'string');
    } catch {
      continue;
    }
    (seen.has(s.fingerprint) ? rest : firsts).push(codes);
    seen.add(s.fingerprint);
  }
  const hands: string[] = [];
  for (const codes of [...firsts, ...rest]) {
    for (const c of codes) if (hands.length < limit) hands.push(c);
    if (hands.length >= limit) break;
  }
  return json({ hands }, 200, r.origin, { 'Cache-Control': 'public, max-age=30' });
}

async function like(r: Req, id: string): Promise<Response> {
  const dev = await guardWrite(r, 'like');
  await getLevelRow(r.env, id);
  const ins = await r.env.HALL
    .prepare('INSERT OR IGNORE INTO likes (level_id, device_hash, created_at) VALUES (?1, ?2, ?3)')
    .bind(id, dev.hash, r.now)
    .run();
  const changed = (ins.meta.changes ?? 0) > 0;
  if (changed) await r.env.HALL.prepare('UPDATE levels SET likes = likes + 1 WHERE id = ?1').bind(id).run();
  const row = await getLevelRow(r.env, id);
  return json({ liked: true, changed, likes: Number(row.likes) }, 200, r.origin);
}

async function report(r: Req, id: string): Promise<Response> {
  const dev = await guardWrite(r, 'report');
  await getLevelRow(r.env, id);
  const body = await readJson(r.req);
  const reason = typeof body.reason === 'string' && REPORT_REASONS.has(body.reason) ? body.reason : 'other';
  const ins = await r.env.HALL
    .prepare('INSERT OR IGNORE INTO reports (level_id, device_hash, reason, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, dev.hash, reason, r.now)
    .run();
  if ((ins.meta.changes ?? 0) > 0) {
    await r.env.HALL
      .prepare(`UPDATE levels SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ${REPORTS_TO_HIDE} THEN 1 ELSE hidden END WHERE id = ?1`)
      .bind(id)
      .run();
  }
  return json({ reported: true }, 200, r.origin);
}

async function daily(r: Req, date: string): Promise<Response> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const start = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, 'bad_date', 'date must be YYYY-MM-DD');
  }
  const end = start + 24 * HOUR;
  const db = r.env.HALL;
  const [pub, sol, lk, top, pool] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n FROM levels WHERE hidden = 0 AND created_at >= ?1 AND created_at < ?2').bind(start, end).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT device_hash) AS d FROM solutions WHERE created_at >= ?1 AND created_at < ?2').bind(start, end).first<{ n: number; d: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM likes WHERE created_at >= ?1 AND created_at < ?2').bind(start, end).first<{ n: number }>(),
    db.prepare(
      `SELECT ${ENTRY_COLS} FROM levels WHERE hidden = 0 AND id IN (SELECT level_id FROM solutions WHERE created_at >= ?1 AND created_at < ?2 GROUP BY level_id ORDER BY COUNT(*) DESC LIMIT 1)`,
    ).bind(start, end).first<LevelRow>(),
    db.prepare(`SELECT ${ENTRY_COLS} FROM levels WHERE hidden = 0 AND created_at < ?1 ORDER BY likes DESC, solves DESC, id LIMIT 50`).bind(end).all<LevelRow>(),
  ]);
  // The daily board: a stable pick among the 50 best-liked levels that existed that day.
  const pick = pool.results.length ? pool.results[fnv1a(`daily:${date}`) % pool.results.length] : null;
  return json({
    date,
    published: Number(pub?.n ?? 0),
    solutions: Number(sol?.n ?? 0),
    solvers: Number(sol?.d ?? 0),
    likes: Number(lk?.n ?? 0),
    mostSolved: top ? toEntry(top) : null,
    pick: pick ? toEntry(pick) : null,
  }, 200, r.origin, { 'Cache-Control': 'public, max-age=300' });
}

// ------------------------------------------------------------------ entry

export async function handle(req: Request, env: Env, ctx?: Ctx): Promise<Response> {
  const origin = req.headers.get('Origin');
  const allowed = allowedOrigin(origin, env);
  const url = new URL(req.url);
  try {
    if (origin && !allowed && req.method !== 'GET') throw new HttpError(403, 'origin', 'origin not allowed');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(allowed) });
    const now = Date.now();
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const ipHash = await sha(`ip:${env.HASH_SALT ?? ''}:${ip}`);
    if (readLimited(ipHash, now)) throw new HttpError(429, 'rate_limited', 'too many requests, slow down');
    const r: Req = { req, env, ctx, url, origin: allowed, now, ipHash };

    const parts = url.pathname.split('/').filter(Boolean);
    const [a, id, sub] = parts;
    const M = req.method;
    if (parts.length === 0 && M === 'GET') return json({ ok: true, service: 'handcast-hall' }, 200, allowed);
    if (a === 'levels') {
      if (parts.length === 1 && M === 'GET') return await listLevels(r);
      if (parts.length === 1 && M === 'POST') return await publishLevel(r);
      if (parts.length === 2 && M === 'GET') return json({ entry: toEntry(await getLevelRow(env, id)) }, 200, allowed);
      if (parts.length === 3 && sub === 'solutions' && M === 'POST') return await submitSolution(r, id);
      if (parts.length === 3 && sub === 'hands' && M === 'GET') return await listHands(r, id);
      if (parts.length === 3 && sub === 'like' && M === 'POST') return await like(r, id);
      if (parts.length === 3 && sub === 'report' && M === 'POST') return await report(r, id);
    }
    if (a === 'daily' && parts.length === 2 && M === 'GET') return await daily(r, id);
    throw new HttpError(404, 'not_found', 'no such route');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status, allowed);
    if (e instanceof CodecError) return json({ error: 'bad_code', message: e.message }, 400, allowed);
    console.error('handcast-hall error', e);
    return json({ error: 'internal', message: 'internal error' }, 500, allowed);
  }
}

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(req, env, ctx);
  },
};
