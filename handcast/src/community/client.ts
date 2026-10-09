/**
 * Hall of Hands client: the game's only door to the community backend
 * (community/worker). Offline-first: the curated shelf always loads (JSON or
 * built in code), publishing works without a backend ("My creations" in
 * localStorage + a share URL), and every network call times out after 4 s and
 * falls back, so the game never blocks on the network. After a network failure
 * the backend is skipped for 30 s.
 *
 * Privacy: casts are anonymised (canonical bone lengths) before they leave the
 * device; players are identified by a random device id and a generated handle.
 */
import { anonymizeCast } from '../core/privacy';
import { decodeCast, decodeLevel, encodeCast, encodeLevel, levelShareUrl } from '../core/codec';
import {
  checkLevelPublishable, generateHandle, poseFingerprint, PUBLISH_LIMITS, sanitizeForPublish, verifySolution,
} from '../core/moderation';
import type { CastData, LevelDef } from '../core/types';
import { loadFeatured } from './featured';

export interface HallEntry {
  id: string;
  code: string;
  name: string;
  author: string;
  likes: number;
  solves: number;
  featured: boolean;
  /** Epoch ms. */
  createdAt: number;
}

/** A page of entries; `cursor` (when present) fetches the next page. */
export type HallList = HallEntry[] & { cursor?: string | null };

export interface SolveStats {
  /** You are the N-th distinct player to solve it (1 = first). */
  rank: number;
  /** Distinct hand-shape solutions seen. */
  distinctHands: number;
  /** Fraction of solvers (0..1) who used the same hand shape as you. */
  yourShare: number;
  solves: number;
  /** False when this is a local estimate. */
  online: boolean;
}

export interface PublishResult {
  ok: boolean;
  reason?: string;
  entry?: HallEntry;
  url?: string;
  /** True when the backend accepted (or rejected) it; false = stored locally only. */
  online: boolean;
}

export interface HallClientOptions {
  /** Worker base URL, e.g. import.meta.env.VITE_HANDCAST_API; null = offline only. */
  apiBase?: string | null;
  storage?: Storage;
  fetch?: typeof fetch;
  /** Where public/ is served (featured.json); default Vite's BASE_URL. */
  assetBase?: string;
  /** Page URL share links point at; default the current page. */
  shareBase?: string;
  timeoutMs?: number;
}

const KEY_DEVICE = 'handcast.deviceId';
const KEY_MINE = 'handcast.myCreations';
const KEY_LIKES = 'handcast.likes';
const KEY_SOLVES = 'handcast.solves';
const DEVICE_HEADER = 'X-Handcast-Device';
const MAX_MINE = 50;
const BACKOFF_MS = 30_000;
const PAGES_URL = 'https://mghprojects.github.io/Devpost/';

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** In-memory Storage for private windows / tests / no-DOM hosts. */
export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

function env(name: string): string | undefined {
  try {
    const e = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return e?.[name] || undefined;
  } catch {
    return undefined;
  }
}

/** VITE_HANDCAST_API from the build, or null. */
export function defaultApiBase(): string | null {
  return env('VITE_HANDCAST_API') ?? null;
}

function defaultStorage(): Storage {
  try {
    const s = globalThis.localStorage;
    if (s) {
      s.getItem(KEY_DEVICE);
      return s;
    }
  } catch {
    // Blocked storage (private mode, sandboxed iframe).
  }
  return new MemoryStorage();
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function isEntry(e: unknown): e is HallEntry {
  const o = e as HallEntry;
  return !!o && typeof o.id === 'string' && typeof o.code === 'string' && typeof o.name === 'string';
}

function normEntry(e: HallEntry): HallEntry {
  return {
    id: e.id,
    code: e.code,
    name: String(e.name),
    author: String(e.author ?? ''),
    likes: Number(e.likes) || 0,
    solves: Number(e.solves) || 0,
    featured: !!e.featured,
    createdAt: Number(e.createdAt) || 0,
  };
}

function isCast(c: unknown): c is CastData {
  const o = c as CastData;
  return !!o && (o.hand === 'left' || o.hand === 'right') && Array.isArray(o.pos) && o.pos.length === 75 &&
    o.pos.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    (o.rot === undefined || (Array.isArray(o.rot) && o.rot.length === 100));
}

export class HallClient {
  readonly deviceId: string;
  /** This device's generated public name. */
  readonly handle: string;
  readonly apiBase: string | null;
  private storage: Storage;
  private fetchFn: typeof fetch | undefined;
  private assetBase: string;
  private shareBase: string;
  private timeoutMs: number;
  private downUntil = 0;
  private levels = new Map<string, LevelDef>();
  private featured: HallEntry[] | null = null;

  constructor(opts: HallClientOptions = {}) {
    const api = opts.apiBase === undefined ? defaultApiBase() : opts.apiBase;
    this.apiBase = api ? api.replace(/\/+$/, '') : null;
    this.storage = opts.storage ?? defaultStorage();
    this.fetchFn = opts.fetch ?? globalThis.fetch?.bind(globalThis);
    this.assetBase = opts.assetBase ?? env('BASE_URL') ?? './';
    const loc = (globalThis as { location?: { origin?: string; pathname?: string } }).location;
    this.shareBase = opts.shareBase ?? (loc?.origin && loc.origin !== 'null' ? `${loc.origin}${loc.pathname ?? '/'}` : PAGES_URL);
    this.timeoutMs = opts.timeoutMs ?? 4000;
    let id = this.read<string | null>(KEY_DEVICE, null);
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = randomId();
      this.write(KEY_DEVICE, id);
    }
    this.deviceId = id;
    this.handle = generateHandle(id);
  }

  /** True when a backend is configured and not in back-off. */
  get online(): boolean {
    return !!this.apiBase && !!this.fetchFn && Date.now() >= this.downUntil;
  }

  shareUrl(code: string): string {
    return levelShareUrl(code, this.shareBase);
  }

  // -------------------------------------------------------------- shelves

  /** The curated shelf (always available). */
  async listFeatured(): Promise<HallEntry[]> {
    if (!this.featured) this.featured = await loadFeatured(this.assetBase, this.fetchFn, this.timeoutMs);
    return this.featured.map((e) => ({ ...e }));
  }

  listNew(cursor?: string | null): Promise<HallList> {
    return this.list('new', cursor);
  }

  listTop(cursor?: string | null): Promise<HallList> {
    return this.list('top', cursor);
  }

  /** Levels published from this device (including local-only ones). */
  listMine(): HallEntry[] {
    const a = this.read<unknown[]>(KEY_MINE, []);
    return Array.isArray(a) ? a.filter(isEntry).map(normEntry) : [];
  }

  private async list(sort: 'new' | 'top', cursor?: string | null): Promise<HallList> {
    const q = `sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await this.api<{ entries?: unknown[]; cursor?: string | null }>('GET', `/levels?${q}`);
    const out: HallList = r.ok && Array.isArray(r.data.entries) ? r.data.entries.filter(isEntry).map(normEntry) : [];
    // Non-enumerable, so the list still compares / serialises as a plain array.
    Object.defineProperty(out, 'cursor', { value: r.ok ? r.data.cursor ?? null : null, enumerable: false });
    return out;
  }

  // -------------------------------------------------------------- levels

  /** A level by share code or by id (cache, shelf, my creations, then backend). Null if unknown or invalid. */
  async getLevel(codeOrId: string): Promise<LevelDef | null> {
    if (!codeOrId) return null;
    const hit = this.levels.get(codeOrId);
    if (hit) return hit;
    const entry = (this.featured ?? []).concat(this.listMine()).find((e) => e.id === codeOrId);
    let code: string | null = entry?.code ?? null;
    if (!code && codeOrId.length > 40) code = codeOrId;
    if (!code && this.featured === null && /^f-/.test(codeOrId)) {
      code = (await this.listFeatured()).find((e) => e.id === codeOrId)?.code ?? null;
    }
    if (!code && /^[A-Za-z0-9_-]{1,40}$/.test(codeOrId)) {
      const r = await this.api<{ entry?: unknown }>('GET', `/levels/${encodeURIComponent(codeOrId)}`);
      if (r.ok && isEntry(r.data.entry)) code = r.data.entry.code;
    }
    if (!code) return null;
    try {
      const level = await decodeLevel(code);
      this.levels.set(codeOrId, level);
      if (level.id) this.levels.set(level.id, level);
      return level;
    } catch {
      return null;
    }
  }

  /**
   * Publishes a level the player made, with the casts that solve it:
   * anonymise, moderate, verify by re-tracing, encode; then POST it (or keep
   * it locally when there is no backend / it is unreachable).
   */
  async publishLevel(level: LevelDef, solutionCasts: CastData[]): Promise<PublishResult> {
    let pub: LevelDef;
    let code: string;
    try {
      const anon = solutionCasts.map(anonymizeCast);
      pub = sanitizeForPublish(level, anon, this.deviceId);
      const chk = checkLevelPublishable(pub);
      if (!chk.ok) return { ok: false, reason: chk.reason, online: false };
      const ver = verifySolution(pub, anon);
      if (!ver.ok) return { ok: false, reason: ver.reason, online: false };
      code = await encodeLevel(pub);
    } catch (e) {
      return { ok: false, reason: `invalid level: ${(e as Error).message}`, online: false };
    }
    if (code.length > PUBLISH_LIMITS.maxCode) return { ok: false, reason: 'level too large to share', online: false };

    let entry: HallEntry = {
      id: pub.id, code, name: pub.name, author: pub.author ?? this.handle,
      likes: 0, solves: 0, featured: false, createdAt: Date.now(),
    };
    let online = false;
    const r = await this.api<{ entry?: unknown }>('POST', '/levels', { code });
    if (r.ok && isEntry(r.data.entry)) {
      entry = normEntry(r.data.entry);
      online = true;
    } else if (!r.ok && r.status >= 400 && r.status < 500 && r.status !== 429) {
      return { ok: false, reason: r.error, online: true };
    }
    try {
      this.levels.set(entry.id, await decodeLevel(entry.code));
    } catch {
      // Server sent an unreadable code: getLevel() will retry from the entry.
    }
    this.saveMine(entry);
    return { ok: true, entry, url: this.shareUrl(entry.code), online };
  }

  private saveMine(entry: HallEntry): void {
    const mine = this.listMine().filter((e) => e.id !== entry.id);
    mine.unshift(entry);
    this.write(KEY_MINE, mine.slice(0, MAX_MINE));
  }

  // -------------------------------------------------------------- solves & hands

  /** Reports a solve; returns how your hand compares (server stats, or a local estimate). */
  async submitSolution(levelId: string, casts: CastData[]): Promise<SolveStats> {
    const anon = casts.map(anonymizeCast);
    const fp = poseFingerprint(anon);
    const local = this.read<Record<string, string[]>>(KEY_SOLVES, {});
    const mineFps = Array.isArray(local[levelId]) ? local[levelId] : [];
    if (!mineFps.includes(fp)) {
      local[levelId] = [...mineFps, fp].slice(-8);
      this.write(KEY_SOLVES, local);
    }

    if (this.online) {
      try {
        const codes = await Promise.all(anon.map(encodeCast));
        const r = await this.api<Partial<SolveStats>>('POST', `/levels/${encodeURIComponent(levelId)}/solutions`, { casts: codes });
        if (r.ok && typeof r.data.rank === 'number') {
          return {
            rank: r.data.rank,
            distinctHands: Number(r.data.distinctHands) || 1,
            yourShare: Number(r.data.yourShare) || 0,
            solves: Number(r.data.solves) || r.data.rank,
            online: true,
          };
        }
      } catch {
        // Local estimate below.
      }
    }
    // Offline: you and the maker's solution.
    const level = await this.getLevel(levelId);
    const pool = [fp];
    if (level?.solution?.length) pool.unshift(poseFingerprint(level.solution));
    const same = pool.filter((f) => f === fp).length;
    return { rank: pool.length, distinctHands: new Set(pool).size, yourShare: same / pool.length, solves: pool.length, online: false };
  }

  /** Other players' glass hands for a level (backend), else the level's own solution casts. */
  async listHands(levelId: string, limit = 30): Promise<CastData[]> {
    const n = Math.max(1, Math.min(60, Math.floor(limit)));
    const r = await this.api<{ hands?: unknown[] }>('GET', `/levels/${encodeURIComponent(levelId)}/hands?limit=${n}`);
    if (r.ok && Array.isArray(r.data.hands)) {
      const out: CastData[] = [];
      for (const h of r.data.hands) {
        if (isCast(h)) out.push(h);
        else if (typeof h === 'string') {
          try {
            out.push(await decodeCast(h));
          } catch {
            // Skip malformed entries.
          }
        }
        if (out.length >= n) break;
      }
      return out;
    }
    const level = await this.getLevel(levelId);
    return (level?.solution ?? []).slice(0, n);
  }

  hasLiked(levelId: string): boolean {
    return this.read<string[]>(KEY_LIKES, []).includes(levelId);
  }

  /** One like per device per level. `likes` is the server count when known. */
  async like(levelId: string): Promise<{ liked: boolean; likes: number | null; already: boolean }> {
    if (this.hasLiked(levelId)) return { liked: true, likes: null, already: true };
    let likes: number | null = null;
    if (this.apiBase) {
      const r = await this.api<{ likes?: number }>('POST', `/levels/${encodeURIComponent(levelId)}/like`, {});
      if (!r.ok) return { liked: false, likes: null, already: false };
      likes = typeof r.data.likes === 'number' ? r.data.likes : null;
    }
    const liked = this.read<string[]>(KEY_LIKES, []);
    liked.push(levelId);
    this.write(KEY_LIKES, liked.slice(-500));
    return { liked: true, likes, already: false };
  }

  /** Flags a level for review (hidden after several reports). False when offline. */
  async report(levelId: string, reason: 'offensive' | 'broken' | 'spam' | 'other' = 'other'): Promise<boolean> {
    const r = await this.api('POST', `/levels/${encodeURIComponent(levelId)}/report`, { reason });
    return r.ok;
  }

  // -------------------------------------------------------------- plumbing

  private read<T>(key: string, fallback: T): T {
    try {
      const s = this.storage.getItem(key);
      return s === null ? fallback : (JSON.parse(s) as T);
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota / blocked storage: the session still works.
    }
  }

  /** JSON request with timeout; never throws. status 0 = network failure / no backend. */
  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
    if (!this.online) return { ok: false, status: 0, error: 'offline' };
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        rej(new Error('timeout'));
      }, this.timeoutMs);
    });
    try {
      const headers: Record<string, string> = { [DEVICE_HEADER]: this.deviceId };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await Promise.race([
        this.fetchFn!(`${this.apiBase}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl?.signal,
        }),
        timeout,
      ]);
      const data = (await Promise.race([res.json().catch(() => ({})), timeout])) as Record<string, unknown>;
      if (!res.ok) {
        if (res.status >= 500) this.downUntil = Date.now() + BACKOFF_MS;
        return { ok: false, status: res.status, error: typeof data.message === 'string' ? data.message : `HTTP ${res.status}` };
      }
      return { ok: true, data: data as T };
    } catch {
      this.downUntil = Date.now() + BACKOFF_MS;
      return { ok: false, status: 0, error: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}
