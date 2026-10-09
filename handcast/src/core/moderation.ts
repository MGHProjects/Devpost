/**
 * Community validation shared by the client and the Worker: offensive-gesture
 * detection, publishability limits, solve verification (re-trace), the hand
 * shape fingerprint used for "distinct hands" stats, and generated names
 * (players never type free text that gets published). Pure, no three.js.
 */
import { castToPose } from './codec';
import { computeOptic, type FeatureState } from './hand-features';
import { traceLevel } from './trace2d';
import type { CastData, HandPose, LevelDef, TraceResult, V2 } from './types';

// ------------------------------------------------------------------ gestures

/** Per-finger extension (thumb..pinky) exactly as hand-features decides it (enter thresholds). */
export function extendedFingers(pose: HandPose): boolean[] {
  const state: FeatureState = { extended: [false, false, false, false, false] };
  computeOptic(pose, { id: 'moderation', live: false, state });
  return state.extended;
}

/** The middle finger is the only extended long finger (thumb either way), in any orientation. */
export function isOffensiveCast(pose: HandPose): boolean {
  const e = extendedFingers(pose);
  return e[2] && !e[1] && !e[3] && !e[4];
}

// ------------------------------------------------------------------ limits

export const PUBLISH_LIMITS = {
  maxCasts: 12,
  maxCrystals: 24,
  maxHush: 24,
  maxLamps: 16,
  maxWells: 16,
  maxWalls: 32,
  maxMirrors: 32,
  maxInks: 8,
  bench: { minW: 0.2, maxW: 1.2, minD: 0.15, maxD: 0.9 },
  well: { minR: 0.008, maxR: 0.08 },
  /** Hands may overhang the bench edge by this much (m). */
  castMargin: 0.25,
  maxText: 48,
  /** Longest accepted share code (base64url chars). */
  maxCode: 6000,
} as const;

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

const fail = (reason: string): CheckResult => ({ ok: false, reason });
const finite = (...n: unknown[]): boolean => n.every((x) => typeof x === 'number' && Number.isFinite(x));
const isColor = (c: unknown): boolean => Number.isInteger(c) && (c as number) >= 1 && (c as number) <= 7;

function validCast(c: CastData, w: number, d: number): string | null {
  if (!c || (c.hand !== 'left' && c.hand !== 'right')) return 'cast handedness';
  if (!Array.isArray(c.pos) || c.pos.length !== 75 || !c.pos.every((x) => finite(x))) return 'cast positions';
  if (c.rot !== undefined && (!Array.isArray(c.rot) || c.rot.length !== 100 || !c.rot.every((x) => finite(x)))) {
    return 'cast rotations';
  }
  if (c.tints !== undefined && (!Array.isArray(c.tints) || c.tints.length !== 5 || !c.tints.every((t) => Number.isInteger(t) && t >= 0 && t <= 7))) {
    return 'cast tints';
  }
  const m = PUBLISH_LIMITS.castMargin * 1000;
  for (let j = 0; j < 25; j++) {
    const x = c.pos[j * 3];
    const y = c.pos[j * 3 + 1];
    const z = c.pos[j * 3 + 2];
    if (Math.abs(x) > w * 500 + m || Math.abs(z) > d * 500 + m || y < -60 || y > 400) return 'cast off the bench';
  }
  return null;
}

/** Structural and content checks for a community level (does not trace; see verifySolution). */
export function checkLevelPublishable(level: LevelDef): CheckResult {
  const L = PUBLISH_LIMITS;
  if (!level || level.v !== 1) return fail('unsupported level version');
  const b = level.bench;
  if (!b || !finite(b.w, b.d) || b.w < L.bench.minW || b.w > L.bench.maxW || b.d < L.bench.minD || b.d > L.bench.maxD) {
    return fail('bench size out of range');
  }
  if (!Number.isInteger(level.budget) || level.budget < 1 || level.budget > L.maxCasts) return fail('budget must be 1-12 hands');
  const lists: [unknown, number, string][] = [
    [level.lamps, L.maxLamps, 'lamps'],
    [level.wells, L.maxWells, 'wells'],
    [level.crystals, L.maxCrystals, 'crystals'],
    [level.hush, L.maxHush, 'hush stones'],
    [level.walls, L.maxWalls, 'walls'],
    [level.mirrors, L.maxMirrors, 'mirrors'],
  ];
  for (const [arr, max, name] of lists) {
    if (!Array.isArray(arr)) return fail(`missing ${name}`);
    if (arr.length > max) return fail(`too many ${name} (max ${max})`);
  }
  if (level.inks !== undefined && (!Array.isArray(level.inks) || level.inks.length > L.maxInks)) return fail('too many inks');
  if (level.crystals.length < 1) return fail('needs at least one crystal');
  if (level.lamps.length + level.wells.length < 1) return fail('needs a lamp or a well');

  const hw = b.w / 2 + 1e-6;
  const hd = b.d / 2 + 1e-6;
  const onBench = (p: V2): boolean => Array.isArray(p) && finite(p[0], p[1]) && Math.abs(p[0]) <= hw && Math.abs(p[1]) <= hd;
  for (const o of level.lamps) {
    if (!onBench(o.p) || !finite(o.a) || !isColor(o.color)) return fail('bad lamp');
  }
  for (const o of level.wells) {
    if (!onBench(o.p) || !isColor(o.color) || !finite(o.r) || o.r < L.well.minR || o.r > L.well.maxR) return fail('bad well');
  }
  for (const o of level.crystals) {
    if (!onBench(o.p) || !isColor(o.color)) return fail('bad crystal');
    if (o.note !== undefined && !(Number.isInteger(o.note) && o.note >= 0 && o.note <= 127)) return fail('bad crystal note');
  }
  for (const o of level.hush) if (!onBench(o.p)) return fail('bad hush stone');
  for (const o of [...level.walls, ...level.mirrors]) if (!onBench(o.a) || !onBench(o.b)) return fail('bad wall or mirror');
  for (const o of level.inks ?? []) if (!onBench(o.p) || !isColor(o.color)) return fail('bad ink');

  for (const s of [level.name, level.author, level.hint]) {
    if (s !== undefined && (typeof s !== 'string' || s.length > L.maxText)) return fail('text too long');
  }

  const sol = level.solution;
  if (!Array.isArray(sol) || sol.length < 1) return fail('needs a solution');
  if (sol.length > Math.min(level.budget, L.maxCasts)) return fail('solution uses more hands than the budget');
  for (const c of sol) {
    const bad = validCast(c, b.w, b.d);
    if (bad) return fail(`bad ${bad}`);
    if (isOffensiveCast(castToPose(c))) return fail('offensive hand shape');
  }
  return { ok: true };
}

/** Casts acceptable as a submitted solution to `level` (shape, count, moderation; no trace). */
export function checkCasts(level: LevelDef, casts: CastData[]): CheckResult {
  if (!Array.isArray(casts) || casts.length < 1) return fail('no hands');
  if (casts.length > Math.min(level.budget, PUBLISH_LIMITS.maxCasts)) return fail('over the hand budget');
  for (const c of casts) {
    const bad = validCast(c, level.bench.w, level.bench.d);
    if (bad) return fail(`bad ${bad}`);
    if (isOffensiveCast(castToPose(c))) return fail('offensive hand shape');
  }
  return { ok: true };
}

/** Re-traces `level` with `casts` as glass hands (default aim assist, like the game). */
export function verifySolution(level: LevelDef, casts: CastData[]): CheckResult & { result?: TraceResult } {
  const c = checkCasts(level, casts);
  if (!c.ok) return c;
  const optics = casts.map((cast, i) =>
    computeOptic(castToPose(cast), {
      id: `cast-${i}`,
      live: false,
      tints: cast.tints ? (cast.tints.slice(0, 5) as [number, number, number, number, number]) : undefined,
    }),
  );
  const result = traceLevel(level, optics);
  return result.solved ? { ok: true, result } : { ok: false, reason: 'does not solve the board', result };
}

// ------------------------------------------------------------------ fingerprint

const SECTORS = 12;
function sector(d: V2, half = false): number {
  const period = half ? Math.PI : 2 * Math.PI;
  let a = Math.atan2(d[1], d[0]) % period;
  if (a < 0) a += period;
  return Math.round((a / period) * SECTORS) % SECTORS;
}

/** One cast's optical shape: mode, open fingers and their quantised headings (position-free). */
export function castShapeKey(cast: CastData): string {
  const o = computeOptic(castToPose(cast), { id: 'fp', live: false });
  if (o.mode === 'blade' && o.mirror) {
    const d: V2 = [o.mirror.b[0] - o.mirror.a[0], o.mirror.b[1] - o.mirror.a[1]];
    return `b${sector(d, true)}`;
  }
  if (o.mode !== 'fan') return o.mode[0];
  let mask = 0;
  const dirs: string[] = [];
  for (let f = 0; f < 5; f++) {
    if (!o.ports[f].open) continue;
    mask |= 1 << f;
    dirs.push(sector(o.ports[f].dir).toString(36));
  }
  return `f${mask.toString(36)}${dirs.join('')}w${sector(o.ports[5].dir).toString(36)}`;
}

/** Hand-shape fingerprint of a whole solution: order-free, 8 hex chars. */
export function poseFingerprint(casts: CastData[]): string {
  return fnv1a(casts.map(castShapeKey).sort().join('|')).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ names

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const HANDLE_ADJ = [
  'Amber', 'Azure', 'Bright', 'Cedar', 'Cobalt', 'Copper', 'Coral', 'Crimson', 'Dawn', 'Dusk',
  'Ember', 'Fern', 'Frost', 'Gentle', 'Golden', 'Hazel', 'Indigo', 'Ivory', 'Jade', 'Lunar',
  'Maple', 'Misty', 'Nimble', 'Opal', 'Pearl', 'Quiet', 'Rapid', 'Rosy', 'Russet', 'Saffron',
  'Silver', 'Solar', 'Swift', 'Teal', 'Tidal', 'Velvet', 'Violet', 'Willow', 'Winter', 'Zephyr',
] as const;
const HANDLE_NOUN = [
  'Badger', 'Bear', 'Crane', 'Dolphin', 'Falcon', 'Finch', 'Fox', 'Gecko', 'Hare', 'Hawk',
  'Heron', 'Ibis', 'Koala', 'Lark', 'Lynx', 'Marten', 'Moth', 'Newt', 'Orca', 'Otter',
  'Owl', 'Panda', 'Puffin', 'Quail', 'Raven', 'Robin', 'Salmon', 'Seal', 'Sparrow', 'Stoat',
  'Swan', 'Tern', 'Tiger', 'Toucan', 'Turtle', 'Wren', 'Yak', 'Zebra', 'Kestrel', 'Plover',
] as const;
const TITLE_ADJ = [
  'Quiet', 'Bright', 'Hollow', 'Gentle', 'Silver', 'Golden', 'Hidden', 'Folded', 'Distant', 'Open',
  'Patient', 'Shining', 'Slow', 'Still', 'Velvet', 'Woven', 'Glass', 'Crystal', 'Morning', 'Evening',
] as const;
const TITLE_NOUN = [
  'Lantern', 'Prism', 'Chord', 'Garden', 'River', 'Harbor', 'Window', 'Meadow', 'Signal', 'Echo',
  'Bridge', 'Compass', 'Orchard', 'Canyon', 'Comet', 'Lagoon', 'Beacon', 'Hymn', 'Ribbon', 'Spiral',
] as const;

/** Stable pseudonymous player handle like 'Amber Heron' (two curated lists; never free text). */
export function generateHandle(seed: string | number): string {
  const h = fnv1a(`handle:${seed}`);
  return `${HANDLE_ADJ[h % HANDLE_ADJ.length]} ${HANDLE_NOUN[Math.floor(h / HANDLE_ADJ.length) % HANDLE_NOUN.length]}`;
}

/** Stable generated level title like 'Quiet Lantern'. */
export function generateLevelTitle(seed: string | number): string {
  const h = fnv1a(`title:${seed}`);
  return `${TITLE_ADJ[h % TITLE_ADJ.length]} ${TITLE_NOUN[Math.floor(h / TITLE_ADJ.length) % TITLE_NOUN.length]}`;
}

/** Content id of a level's board + solution (two 32-bit FNV-1a lanes, base36): 'u' + 13 chars. */
export function levelContentId(level: LevelDef): string {
  const { id: _id, name: _name, author: _author, hint: _hint, ...rest } = level;
  const s = JSON.stringify(rest);
  const a = fnv1a(s);
  const b = fnv1a(`${s.length}:${s}`);
  return `u${a.toString(36).padStart(7, '0')}${b.toString(36).padStart(7, '0')}`.slice(0, 14);
}

/**
 * The publishable form of a level: only known fields (no extras), generated
 * title and author, no hint or campaign placement, and a content-derived id.
 * `solution` replaces the level's own; casts should already be anonymised.
 */
export function sanitizeForPublish(level: LevelDef, solution: CastData[], authorSeed: string): LevelDef {
  const pts = (p: V2): V2 => [p[0], p[1]];
  const out: LevelDef = {
    v: 1,
    id: '',
    name: '',
    bench: { w: level.bench.w, d: level.bench.d },
    budget: level.budget,
    lamps: level.lamps.map((o) => ({ p: pts(o.p), a: o.a, color: o.color })),
    wells: level.wells.map((o) => ({ p: pts(o.p), r: o.r, color: o.color })),
    crystals: level.crystals.map((o) => (o.note !== undefined ? { p: pts(o.p), color: o.color, note: o.note } : { p: pts(o.p), color: o.color })),
    hush: level.hush.map((o) => ({ p: pts(o.p) })),
    walls: level.walls.map((o) => ({ a: pts(o.a), b: pts(o.b) })),
    mirrors: level.mirrors.map((o) => ({ a: pts(o.a), b: pts(o.b) })),
  };
  if (level.inks?.length) out.inks = level.inks.map((o) => ({ p: pts(o.p), color: o.color }));
  out.solution = solution.map((c) => {
    const k: CastData = { hand: c.hand, pos: c.pos.slice() };
    if (c.rot) k.rot = c.rot.slice();
    if (c.tints) k.tints = c.tints.slice();
    return k;
  });
  out.id = levelContentId(out);
  out.name = generateLevelTitle(out.id);
  out.author = generateHandle(authorSeed);
  return out;
}
