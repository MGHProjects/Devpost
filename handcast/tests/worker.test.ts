/**
 * Hall of Hands Worker (community/worker) run in Node against a fake D1 built
 * on node:sqlite with the real schema.sql: publishing re-validates with the
 * shared core (unsolvable / offensive levels rejected), solutions are
 * re-traced and ranked, likes are one per device, reports hide a level,
 * CORS and payload limits hold. Also drives HallClient end to end through it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type D1Database, type D1PreparedStatement, type D1Result, type Env } from '../community/worker/src/index';
import { HallClient, MemoryStorage, type HallEntry } from '../src/community/client';
import { buildFeaturedLevels } from '../src/community/featured';
import { decodeCast, decodeLevel, encodeCast, encodeLevel, poseToCast } from '../src/core/codec';
import { computeOptic } from '../src/core/hand-features';
import { anonymizeCast } from '../src/core/privacy';
import { canonicalPose } from '../src/core/pose-library';
import { Color, type LevelDef } from '../src/core/types';

// ------------------------------------------------------------------ fake D1

type Sqlite = {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  };
};
let sqlite: Sqlite | null = null;
try {
  sqlite = createRequire(import.meta.url)('node:sqlite') as Sqlite;
} catch {
  sqlite = null;
}

function fakeD1(): D1Database {
  const db = new sqlite!.DatabaseSync(':memory:');
  db.exec(readFileSync(resolve(__dirname, '../community/worker/schema.sql'), 'utf8'));
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async <T>() => ((db.prepare(sql).get(...params) as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[], success: true, meta: {} }),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out: D1Result[] = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

// ------------------------------------------------------------------ helpers

const ORIGIN = 'https://mghprojects.github.io';
let env: Env;
let ipSeq = 0;

function call(method: string, path: string, opts: { body?: unknown; device?: string | null; origin?: string | null; raw?: string; ip?: string } = {}) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': opts.ip ?? `10.0.0.${ipSeq}` };
  if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
  if (opts.device !== null) headers['X-Handcast-Device'] = opts.device ?? 'device-aaaa-0001';
  if (opts.body !== undefined || opts.raw !== undefined) headers['Content-Type'] = 'application/json';
  const req = new Request(`https://hall.test${path}`, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  return worker.fetch(req, env, {});
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const first = (): LevelDef => buildFeaturedLevels()[0];

/** A board whose only solution is the middle-finger gesture. */
function rudeBoard(): LevelDef {
  const pose = canonicalPose('middle', 'right', [0, 0.07]);
  const o = computeOptic(pose, { id: 'c', live: false });
  const w = o.ports[5];
  const m = o.ports[2];
  return {
    ...first(), id: 'rude', crystals: [{ p: [m.p[0] + m.dir[0] * 0.06, m.p[1] + m.dir[1] * 0.06], color: Color.W }],
    lamps: [{ p: [w.p[0] + w.dir[0] * 0.035, w.p[1] + w.dir[1] * 0.035], a: Math.atan2(-w.dir[1], -w.dir[0]), color: Color.W }],
    solution: [poseToCast(pose)],
  };
}

async function publish(level: LevelDef, device = 'device-aaaa-0001') {
  return call('POST', '/levels', { body: { code: await encodeLevel(level) }, device });
}

const d = sqlite ? describe : describe.skip;

d('Hall Worker', () => {
  beforeEach(() => {
    env = { HALL: fakeD1(), ALLOWED_ORIGIN: ORIGIN };
    ipSeq++;
  });

  it('publishes a valid level with generated names and anonymised casts', async () => {
    const res = await publish({ ...first(), name: 'Free text!', hint: 'secret' });
    expect(res.status).toBe(201);
    const { entry } = await body<{ entry: HallEntry }>(res);
    expect(entry.id).toMatch(/^u[0-9a-z]{13}$/);
    expect(entry.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(entry.author).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(entry).toMatchObject({ likes: 0, solves: 1, featured: false });
    const lv = await decodeLevel(entry.code);
    expect(lv.hint).toBeUndefined();
    expect(lv.name).toBe(entry.name);
    expect(lv.solution![0].pos).toEqual(anonymizeCast(first().solution![0]).pos);

    const got = await body<{ entry: HallEntry }>(await call('GET', `/levels/${entry.id}`));
    expect(got.entry).toEqual(entry);
    const list = await body<{ entries: HallEntry[]; cursor: string | null }>(await call('GET', '/levels?sort=new'));
    expect(list.entries.map((e) => e.id)).toEqual([entry.id]);
    expect(list.cursor).toBeNull();
    expect((await body<{ entries: HallEntry[] }>(await call('GET', '/levels?sort=featured'))).entries).toEqual([]);

    // Same board again (any device): idempotent.
    const again = await publish(first(), 'device-bbbb-0002');
    expect(again.status).toBe(200);
    expect((await body<{ entry: HallEntry }>(again)).entry.id).toBe(entry.id);
  });

  it('rejects unsolvable levels, offensive casts and garbage', async () => {
    const fist = poseToCast(canonicalPose('fist', 'right', [0, 0.07]));
    const r1 = await publish({ ...first(), solution: [fist] });
    expect(r1.status).toBe(422);
    expect(await body(r1)).toMatchObject({ error: 'unsolved' });
    const r2 = await publish({ ...first(), solution: [] });
    expect(r2.status).toBe(422);
    const r3 = await publish(rudeBoard());
    expect(r3.status).toBe(422);
    expect((await body<{ message: string }>(r3)).message).toMatch(/offensive/);
    const r4 = await call('POST', '/levels', { body: { code: 'not-a-code' } });
    expect(r4.status).toBe(400);
    expect(await body(r4)).toMatchObject({ error: 'bad_code' });
    const r5 = await call('POST', '/levels', { raw: '{nope' });
    expect(r5.status).toBe(400);
    const r6 = await call('POST', '/levels', { body: { code: 'x' }, device: null });
    expect(r6.status).toBe(400);
    expect(await body(r6)).toMatchObject({ error: 'no_device' });
    expect((await call('GET', '/levels?sort=new').then(body<{ entries: unknown[] }>)).entries).toEqual([]);
  });

  it('re-traces solutions and ranks distinct hands', async () => {
    const { entry } = await body<{ entry: HallEntry }>(await publish(first()));
    const point = await encodeCast(first().solution![0]);
    const L = await encodeCast(poseToCast(canonicalPose('L', 'right', [0, 0.07])));
    const fist = await encodeCast(poseToCast(canonicalPose('fist', 'right', [0, 0.07])));

    const s1 = await body(await call('POST', `/levels/${entry.id}/solutions`, { body: { casts: [point] }, device: 'solver-0000-0001' }));
    expect(s1).toMatchObject({ rank: 2, distinctHands: 1, yourShare: 1, solves: 2 });
    const s2 = await body(await call('POST', `/levels/${entry.id}/solutions`, { body: { casts: [L] }, device: 'solver-0000-0002' }));
    expect(s2).toMatchObject({ rank: 3, distinctHands: 2, solves: 3 });
    expect(s2.yourShare).toBeCloseTo(1 / 3, 3);
    // Re-submitting keeps your rank and does not double count.
    const s3 = await body(await call('POST', `/levels/${entry.id}/solutions`, { body: { casts: [point] }, device: 'solver-0000-0001' }));
    expect(s3).toMatchObject({ rank: 2, solves: 3 });
    const bad = await call('POST', `/levels/${entry.id}/solutions`, { body: { casts: [fist] }, device: 'solver-0000-0003' });
    expect(bad.status).toBe(422);
    const over = await call('POST', `/levels/${entry.id}/solutions`, { body: { casts: [point, L] }, device: 'solver-0000-0003' });
    expect(over.status).toBe(422);
    expect((await call('POST', '/levels/nope/solutions', { body: { casts: [point] } })).status).toBe(404);

    const got = await body<{ entry: HallEntry }>(await call('GET', `/levels/${entry.id}`));
    expect(got.entry.solves).toBe(3);
    const hands = await body<{ hands: string[] }>(await call('GET', `/levels/${entry.id}/hands?limit=30`));
    expect(hands.hands.length).toBe(3);
    const casts = await Promise.all(hands.hands.map(decodeCast));
    expect(casts.every((c) => c.pos.length === 75)).toBe(true);
    expect((await body<{ hands: string[] }>(await call('GET', `/levels/${entry.id}/hands?limit=1`))).hands).toHaveLength(1);
  });

  it('likes are idempotent per device; top sorts by likes', async () => {
    const a = (await body<{ entry: HallEntry }>(await publish(first()))).entry;
    const b = (await body<{ entry: HallEntry }>(await publish(buildFeaturedLevels()[1]))).entry;
    expect(await body(await call('POST', `/levels/${a.id}/like`, { device: 'liker-0000-0001' }))).toMatchObject({ likes: 1, changed: true });
    expect(await body(await call('POST', `/levels/${a.id}/like`, { device: 'liker-0000-0001' }))).toMatchObject({ likes: 1, changed: false });
    expect(await body(await call('POST', `/levels/${a.id}/like`, { device: 'liker-0000-0002' }))).toMatchObject({ likes: 2 });
    expect((await call('POST', '/levels/nope/like')).status).toBe(404);
    const top = await body<{ entries: HallEntry[] }>(await call('GET', '/levels?sort=top'));
    expect(top.entries.map((e) => e.id)).toEqual([a.id, b.id]);
    const page = await body<{ entries: HallEntry[]; cursor: string }>(await call('GET', '/levels?sort=top&limit=1'));
    expect(page.entries).toHaveLength(1);
    expect(page.cursor).toBe('1');
    const next = await body<{ entries: HallEntry[]; cursor: string | null }>(await call('GET', `/levels?sort=top&limit=1&cursor=${page.cursor}`));
    expect(next.entries[0].id).toBe(b.id);
    expect(next.cursor).toBeNull();
  });

  it('hides a level after 3 reports from different devices', async () => {
    const { entry } = await body<{ entry: HallEntry }>(await publish(first()));
    for (let i = 0; i < 2; i++) {
      await call('POST', `/levels/${entry.id}/report`, { body: { reason: 'spam' }, device: `report-0000-000${i}` });
    }
    await call('POST', `/levels/${entry.id}/report`, { body: { reason: 'spam' }, device: 'report-0000-0000' }); // duplicate
    expect((await call('GET', `/levels/${entry.id}`)).status).toBe(200);
    await call('POST', `/levels/${entry.id}/report`, { body: { reason: 'offensive' }, device: 'report-0000-0009' });
    expect((await call('GET', `/levels/${entry.id}`)).status).toBe(404);
    expect((await body<{ entries: unknown[] }>(await call('GET', '/levels?sort=new'))).entries).toEqual([]);
  });

  it('CORS: allowed origin and localhost get headers; other origins cannot write', async () => {
    const pre = await call('OPTIONS', '/levels');
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toMatch(/X-Handcast-Device/);
    const dev = await call('GET', '/levels', { origin: 'http://localhost:8081' });
    expect(dev.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8081');
    const evilGet = await call('GET', '/levels', { origin: 'https://evil.example' });
    expect(evilGet.status).toBe(200);
    expect(evilGet.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const evilPost = await call('POST', '/levels', { body: { code: 'x' }, origin: 'https://evil.example' });
    expect(evilPost.status).toBe(403);
    expect(evilPost.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const evilPre = await call('OPTIONS', '/levels', { origin: 'https://mghprojects.github.io.evil.example' });
    expect(evilPre.status).toBe(403);
    expect((await call('GET', '/levels', { origin: null })).status).toBe(200);
  });

  it('caps payloads, rate limits writes and returns JSON errors', async () => {
    const big = await call('POST', '/levels', { raw: JSON.stringify({ code: 'A'.repeat(20000) }) });
    expect(big.status).toBe(413);
    expect(big.headers.get('Content-Type')).toMatch(/application\/json/);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await call('POST', '/levels', { body: { code: 'zz' }, device: 'spammer-0000-0001' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(await body(await call('GET', '/nope'))).toMatchObject({ error: 'not_found' });
    expect((await call('GET', '/levels?sort=weird')).status).toBe(400);
  });

  it('daily stats', async () => {
    const { entry } = await body<{ entry: HallEntry }>(await publish(first()));
    const today = new Date().toISOString().slice(0, 10);
    const s = await body(await call('GET', `/daily/${today}`));
    expect(s).toMatchObject({ date: today, published: 1, solutions: 1, solvers: 1, likes: 0 });
    expect((s.pick as HallEntry).id).toBe(entry.id);
    expect((s.mostSolved as HallEntry).id).toBe(entry.id);
    expect((await call('GET', '/daily/2026-02-30')).status).toBe(400);
    expect(await body(await call('GET', '/daily/2001-01-01'))).toMatchObject({ published: 0, pick: null });
  });

  it('HallClient end to end through the Worker', async () => {
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://hall.test')) throw new Error('offline');
      const headers = new Headers(init?.headers);
      headers.set('Origin', ORIGIN);
      headers.set('CF-Connecting-IP', '10.9.9.9');
      return worker.fetch(new Request(url, { ...init, headers }), env, {});
    }) as typeof fetch;
    const mk = () => new HallClient({ apiBase: 'https://hall.test', storage: new MemoryStorage(), fetch: fetchFn, shareBase: 'https://x.test/' });
    const maker = mk();
    const level = first();
    const pub = await maker.publishLevel(level, level.solution!);
    expect(pub).toMatchObject({ ok: true, online: true });
    expect(pub.entry!.author).toBe(maker.handle);
    expect(maker.listMine()[0].id).toBe(pub.entry!.id);

    const player = mk();
    expect((await player.listNew()).map((e) => e.id)).toEqual([pub.entry!.id]);
    const lv = await player.getLevel(pub.entry!.id);
    expect(lv?.crystals).toHaveLength(level.crystals.length);
    const stats = await player.submitSolution(pub.entry!.id, [poseToCast(canonicalPose('L', 'right', [0, 0.07]))]);
    expect(stats).toEqual({ rank: 2, distinctHands: 2, yourShare: 0.5, solves: 2, online: true });
    expect(await player.like(pub.entry!.id)).toMatchObject({ liked: true, likes: 1 });
    expect(await player.like(pub.entry!.id)).toMatchObject({ already: true });
    const hands = await player.listHands(pub.entry!.id, 10);
    expect(hands).toHaveLength(2);
    expect((await player.listTop())[0].likes).toBe(1);
    expect(await player.report(pub.entry!.id, 'broken')).toBe(true);

    const rude = await maker.publishLevel(rudeBoard(), rudeBoard().solution!);
    expect(rude.ok).toBe(false);
  });
});
