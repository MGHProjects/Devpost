/**
 * Board validation for HANDCAST content (campaign, Daily, Kiln, Studio).
 *
 * validateBoard() checks that a level's reference solution really solves it
 * with glass hands, that the bench is not already solved, that the solution
 * survives small hand wobbles (robustness: every crystal stays lit and every
 * hush dark in >= 80% of wobbled re-casts), that trivial open hands do not
 * also solve a one-hand board (anti-trivial), that every cast is a pose a
 * real hand can rest on a real table (plausibility), and estimates the
 * board's difficulty. Also hosts the CastData <-> HandPose codec and the
 * hand-footprint geometry the generator shares. Pure TS, no three.js / DOM.
 */

import { fkPose, type PoseParams } from './fk-hand.js';
import { computeOptic } from './hand-features.js';
import { BONES, KNUCKLE, TIP } from './joints.js';
import { canonicalPose, POSE_NAMES } from './pose-library.js';
import { CRYSTAL_R, HUSH_R, traceLevel } from './trace2d.js';
import type { CastData, Handedness, HandOptic, HandPose, LevelDef, TraceResult, V2 } from './types.js';
import { convexHull, pointSegDistSq } from './vec2.js';

// ------------------------------------------------------------------ types

/** Content-only fields carried by generated boards (ignored by the runtime). */
export interface BoardMeta {
  /**
   * 'allowAnySpread': any open hand may solve (no anti-trivial check);
   * 'spreadSolution': the intended hand IS the 'spread' pose (only 'flat' must fail).
   */
  tags?: string[];
  /** FK parameters of each solution cast (same order as `solution`), for perturbation. */
  solutionParams?: PoseParams[];
  /** One line describing the intended solution (designer notes / hints). */
  intent?: string;
  /** Generator bookkeeping: seed used and the validation scores at generation time. */
  gen?: { spec?: string; seed: number; difficulty: number; robustness: number; solveRate: number };
}

export type ContentLevel = LevelDef & BoardMeta;

export interface ValidateOptions {
  /** Robustness perturbations (default 40; 0 skips). */
  robustSamples?: number;
  /** Required per-element share of wobbles (see ValidationResult.robustness; default 0.8). */
  robustMin?: number;
  /** Run the coarse difficulty search (default true). */
  difficulty?: boolean;
  /** Cap on difficulty-search trials (default 3000). */
  difficultyTrials?: number;
  /** Check physical plausibility (default true). */
  plausibility?: boolean;
  /** Check the anti-trivial rule on one-cast boards (default true). */
  antiTrivial?: boolean;
  /** Seed for the perturbations (default: hash of the solution casts). */
  seed?: number;
}

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
  /** 0..1 for one-cast boards (1 = nothing nearby solves); > 1 for multi-cast boards. */
  difficulty: number;
  /**
   * Worst per-element share over the wobbles: for each crystal the share in
   * which it is still lit with its exact colour, for each hush the share in
   * which it stays dark; the minimum over all of them.
   */
  robustness: number;
  /** Share of wobbles in which the whole board still solves. */
  solveRate: number;
}

// ------------------------------------------------------------- constants

export const BENCH = { w: 0.44, d: 0.3 } as const;
/** Allowed hand-axis heading around "pointing away" (-PI/2), radians. */
export const YAW_RANGE = 1.2;
/** Palm-centre x limits for each hand ("right hand favours the right half"). */
export const SIDE_LIMIT = 0.06;
/** Min surface gap between a hand and any prop (m). */
export const PROP_CLEAR = 0.012;
/** Min palm-centre distance between two casts (m). */
export const CAST_SPACING = 0.09;
/** Min surface gap between two casts' footprints (m). */
export const CAST_GAP = 0.004;
/** Crystal distance from the port (or mirror) feeding it (m). */
export const FEED_MIN = 0.06;
export const FEED_MAX = 0.22;
/** Lamp body radius for clearance checks (m). */
export const LAMP_R = 0.008;
const BONE_R = 0.0085;
const THUMB_BONE_R = 0.009;
const METACARPALS = [1, 5, 10, 15, 20] as const;

// ----------------------------------------------------------------- codec

/** HandPose -> compact CastData (mm ints, quaternions * 10000). */
export function encodeCast(pose: HandPose): CastData {
  const cast: CastData = { hand: pose.hand, pos: Array.from(pose.pos, (v) => Math.round(v * 1000)) };
  if (pose.rot) cast.rot = Array.from(pose.rot, (v) => Math.round(v * 10000));
  return cast;
}

/** CastData -> HandPose (positions in metres, renormalized quaternions). */
export function decodeCast(cast: CastData): HandPose {
  const pos = new Float32Array(75);
  for (let i = 0; i < 75; i++) pos[i] = (cast.pos[i] ?? 0) / 1000;
  let rot: Float32Array | undefined;
  if (cast.rot && cast.rot.length === 100) {
    rot = new Float32Array(100);
    for (let j = 0; j < 25; j++) {
      const q = cast.rot.slice(j * 4, j * 4 + 4);
      const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      for (let i = 0; i < 4; i++) rot[j * 4 + i] = q[i] / l;
    }
  }
  return { hand: cast.hand, pos, rot };
}

/** Glass-hand optics of every solution cast. */
export function solutionOptics(level: LevelDef): HandOptic[] {
  return (level.solution ?? []).map((c, i) => computeOptic(decodeCast(c), { id: `cast-${i}`, live: false }));
}

// --------------------------------------------------------------- geometry

/** Hand-axis heading (wrist -> middle knuckle) on the bench, atan2(z, x). */
export function poseYaw(pose: HandPose): number {
  const p = pose.pos;
  return Math.atan2(p[KNUCKLE[2] * 3 + 2] - p[2], p[KNUCKLE[2] * 3] - p[0]);
}

/** Palm centre ((wrist + middle knuckle) / 2) on the bench. */
export function posePalm(pose: HandPose): V2 {
  const p = pose.pos;
  return [(p[0] + p[KNUCKLE[2] * 3]) / 2, (p[2] + p[KNUCKLE[2] * 3 + 2]) / 2];
}

/** A hand's shadow on the bench: bone capsules plus the palm polygon. */
export interface Footprint {
  caps: { a: V2; b: V2; r: number }[];
  palm: V2[];
}

export function footprint(pose: HandPose): Footprint {
  const p = pose.pos;
  const xz = (j: number): V2 => [p[j * 3], p[j * 3 + 2]];
  const caps = BONES.map(([a, b]) => ({ a: xz(a), b: xz(b), r: b >= 1 && b <= 4 ? THUMB_BONE_R : BONE_R }));
  const pts: V2[] = [xz(0)];
  for (const j of METACARPALS) pts.push(xz(j));
  for (const j of KNUCKLE) pts.push(xz(j));
  return { caps, palm: convexHull(pts) };
}

function pointInPoly(x: number, z: number, poly: V2[]): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function segSegDist(a: V2, b: V2, c: V2, d: V2): number {
  // Proper intersection -> 0; else min of the four endpoint distances.
  const o = (p: V2, q: V2, r: V2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.sqrt(Math.min(
    pointSegDistSq(a[0], a[1], c[0], c[1], d[0], d[1]),
    pointSegDistSq(b[0], b[1], c[0], c[1], d[0], d[1]),
    pointSegDistSq(c[0], c[1], a[0], a[1], b[0], b[1]),
    pointSegDistSq(d[0], d[1], a[0], a[1], b[0], b[1]),
  ));
}

/** Surface gap from a circle (centre, radius) to a footprint (negative = overlap). */
export function circleGap(fp: Footprint, c: V2, r: number): number {
  if (pointInPoly(c[0], c[1], fp.palm)) return -r;
  let best = Infinity;
  for (const k of fp.caps) {
    const g = Math.sqrt(pointSegDistSq(c[0], c[1], k.a[0], k.a[1], k.b[0], k.b[1])) - k.r;
    if (g < best) best = g;
  }
  const n = fp.palm.length;
  for (let i = 0; i < n; i++) {
    const a = fp.palm[i];
    const b = fp.palm[(i + 1) % n];
    const g = Math.sqrt(pointSegDistSq(c[0], c[1], a[0], a[1], b[0], b[1]));
    if (g < best) best = g;
  }
  return best - r;
}

/** Surface gap from a segment (wall, mirror) to a footprint. */
export function segmentGap(fp: Footprint, a: V2, b: V2): number {
  if (pointInPoly(a[0], a[1], fp.palm) || pointInPoly(b[0], b[1], fp.palm)) return 0;
  let best = Infinity;
  for (const k of fp.caps) best = Math.min(best, segSegDist(a, b, k.a, k.b) - k.r);
  const n = fp.palm.length;
  for (let i = 0; i < n; i++) best = Math.min(best, segSegDist(a, b, fp.palm[i], fp.palm[(i + 1) % n]));
  return best;
}

/** Surface gap between two footprints. */
export function footprintGap(f: Footprint, g: Footprint): number {
  let best = Infinity;
  for (const k of f.caps) {
    if (pointInPoly(k.a[0], k.a[1], g.palm) || pointInPoly(k.b[0], k.b[1], g.palm)) return -k.r;
    for (const m of g.caps) best = Math.min(best, segSegDist(k.a, k.b, m.a, m.b) - k.r - m.r);
    const n = g.palm.length;
    for (let i = 0; i < n; i++) best = Math.min(best, segSegDist(k.a, k.b, g.palm[i], g.palm[(i + 1) % n]) - k.r);
  }
  for (const m of g.caps) {
    if (pointInPoly(m.a[0], m.a[1], f.palm) || pointInPoly(m.b[0], m.b[1], f.palm)) return -m.r;
  }
  return best;
}

/** True when a well actually feeds this optic (an open port or the fan palm sits in it). */
export function wellFeeds(o: HandOptic, w: { p: V2; r: number }): boolean {
  if (o.mode !== 'fan') return false;
  const inside = (p: V2): boolean => (p[0] - w.p[0]) ** 2 + (p[1] - w.p[1]) ** 2 < w.r * w.r;
  return inside(o.center) || o.ports.some((p) => p.open && inside(p.p));
}

// ----------------------------------------------------------- plausibility

/** Physical checks on one cast against the bench (not other casts / props). */
export function castShapeReasons(pose: HandPose, bench: { w: number; d: number }, tag = 'cast'): string[] {
  const reasons: string[] = [];
  const hw = bench.w / 2 + 1e-4;
  const hd = bench.d / 2 + 1e-4;
  const palm = posePalm(pose);
  if (Math.abs(palm[0]) > hw || Math.abs(palm[1]) > hd) reasons.push(`${tag}: palm centre off the bench`);
  for (const t of TIP) {
    const x = pose.pos[t * 3];
    const z = pose.pos[t * 3 + 2];
    if (Math.abs(x) > hw || Math.abs(z) > hd) {
      reasons.push(`${tag}: fingertip off the bench`);
      break;
    }
  }
  const yaw = poseYaw(pose);
  let dy = yaw + Math.PI / 2;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  if (Math.abs(dy) > YAW_RANGE + 0.02) reasons.push(`${tag}: hand turned ${Math.round((dy * 180) / Math.PI)} deg from forward`);
  if (pose.hand === 'right' && palm[0] < -SIDE_LIMIT) reasons.push(`${tag}: right hand too far left`);
  if (pose.hand === 'left' && palm[0] > SIDE_LIMIT) reasons.push(`${tag}: left hand too far right`);
  return reasons;
}

/** Full plausibility of a solution: casts vs bench, each other and every prop. */
export function plausibilityReasons(level: LevelDef, poses: HandPose[], optics: HandOptic[], trace?: TraceResult): string[] {
  const reasons: string[] = [];
  const fps = poses.map(footprint);
  poses.forEach((p, i) => reasons.push(...castShapeReasons(p, level.bench, `cast ${i}`)));
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const a = posePalm(poses[i]);
      const b = posePalm(poses[j]);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < CAST_SPACING) reasons.push(`casts ${i}/${j}: palms closer than 9 cm`);
      if (footprintGap(fps[i], fps[j]) < CAST_GAP) reasons.push(`casts ${i}/${j}: hands overlap`);
    }
  }
  fps.forEach((fp, i) => {
    level.crystals.forEach((c, k) => {
      if (circleGap(fp, c.p, CRYSTAL_R) < PROP_CLEAR) reasons.push(`cast ${i}: touches crystal ${k}`);
    });
    level.hush.forEach((h, k) => {
      if (circleGap(fp, h.p, HUSH_R) < PROP_CLEAR) reasons.push(`cast ${i}: touches hush ${k}`);
    });
    level.lamps.forEach((l, k) => {
      if (circleGap(fp, l.p, LAMP_R) < PROP_CLEAR) reasons.push(`cast ${i}: touches lamp ${k}`);
    });
    level.walls.forEach((w, k) => {
      if (segmentGap(fp, w.a, w.b) < PROP_CLEAR) reasons.push(`cast ${i}: touches wall ${k}`);
    });
    level.mirrors.forEach((m, k) => {
      if (segmentGap(fp, m.a, m.b) < PROP_CLEAR) reasons.push(`cast ${i}: touches mirror ${k}`);
    });
    level.wells.forEach((w, k) => {
      if (wellFeeds(optics[i], w)) return;
      if (circleGap(fp, w.p, w.r) < PROP_CLEAR) reasons.push(`cast ${i}: rests on well ${k} without drinking from it`);
    });
  });
  if (trace) reasons.push(...feedDistanceReasons(level, optics, trace));
  return reasons;
}

/** Each lit crystal must be fed by a hand port or blade 6-22 cm away, never straight from a lamp. */
export function feedDistanceReasons(level: LevelDef, optics: HandOptic[], trace: TraceResult): string[] {
  const reasons: string[] = [];
  level.crystals.forEach((c, k) => {
    for (const s of trace.segments) {
      const db = Math.hypot(s.b[0] - c.p[0], s.b[1] - c.p[1]);
      if (Math.abs(db - CRYSTAL_R) > 2e-3) continue;
      if (level.lamps.some((l) => Math.hypot(l.p[0] - s.a[0], l.p[1] - s.a[1]) < 2e-3)) {
        reasons.push(`crystal ${k}: lit straight from a lamp`);
        continue;
      }
      const fromHand = optics.some((o) =>
        o.ports.some((p) => Math.hypot(p.p[0] - s.a[0], p.p[1] - s.a[1]) < 2e-3) ||
        (o.mirror && pointSegDistSq(s.a[0], s.a[1], o.mirror.a[0], o.mirror.a[1], o.mirror.b[0], o.mirror.b[1]) < 4e-6));
      if (!fromHand) continue;
      const d = Math.hypot(c.p[0] - s.a[0], c.p[1] - s.a[1]);
      if (d < FEED_MIN - 0.004 || d > FEED_MAX + 0.004) {
        reasons.push(`crystal ${k}: ${Math.round(d * 100)} cm from the hand feeding it`);
      }
    }
  });
  return reasons;
}

// ---------------------------------------------------------- perturbation

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    let t = (s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default wobble seed: derived from the solution itself, so renaming a board never changes its score. */
export function solutionSeed(level: LevelDef): number {
  return hashString((level.solution ?? []).map((c) => c.pos.join(',')).join('|'));
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const DEG = Math.PI / 180;

/** One random wobble of a cast: yaw +-4 deg, position +-6 mm, curls +-0.08, spread +-0.1. */
export function perturbParams(p: PoseParams, rnd: () => number): PoseParams {
  const u = (a: number): number => (rnd() * 2 - 1) * a;
  const curl = p.curl.map((c) => Math.min(1, Math.max(0, c + u(0.08)))) as PoseParams['curl'];
  return {
    ...p,
    curl,
    spread: Math.min(1, Math.max(0, (p.spread ?? 0) + u(0.1))),
    at: [p.at[0] + u(0.006), p.at[1] + u(0.006)],
    yaw: (p.yaw ?? -Math.PI / 2) + u(4 * DEG),
  };
}

/** Rigid wobble of a pose (when no FK parameters are known): yaw +-4 deg about the palm, +-6 mm. */
function perturbRigid(pose: HandPose, rnd: () => number): HandPose {
  const u = (a: number): number => (rnd() * 2 - 1) * a;
  const c = posePalm(pose);
  const th = u(4 * DEG);
  const dx = u(0.006);
  const dz = u(0.006);
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const pos = new Float32Array(75);
  for (let j = 0; j < 25; j++) {
    const x = pose.pos[j * 3] - c[0];
    const z = pose.pos[j * 3 + 2] - c[1];
    pos[j * 3] = c[0] + x * cs - z * sn + dx;
    pos[j * 3 + 1] = pose.pos[j * 3 + 1];
    pos[j * 3 + 2] = c[1] + x * sn + z * cs + dz;
  }
  return { hand: pose.hand, pos };
}

export interface Robustness {
  /** Minimum over crystals (lit) and hush stones (dark) of the share of wobbles that keep them so. */
  min: number;
  /** Share of wobbles in which the whole board solves. */
  joint: number;
  /** Per crystal, then per hush. */
  perElement: number[];
}

/**
 * Traces `samples` wobbled copies of the solution (default assist). Sample s
 * wobbles cast s % n only: casts are frozen one after another in play, so a
 * later hand is always placed against the earlier glass hands' real beams
 * (for one-cast boards this is simply every sample wobbling the cast).
 */
export function robustness(level: ContentLevel, samples = 40, seed = solutionSeed(level)): Robustness {
  const casts = level.solution ?? [];
  if (!casts.length || samples <= 0) return { min: 0, joint: 0, perElement: [] };
  const params = level.solutionParams && level.solutionParams.length === casts.length ? level.solutionParams : undefined;
  const base = casts.map(decodeCast);
  const rnd = mulberry32(seed);
  const nc = level.crystals.length;
  const good = new Array<number>(nc + level.hush.length).fill(0);
  let joint = 0;
  for (let s = 0; s < samples; s++) {
    const w = s % casts.length;
    const optics = casts.map((_, i) => {
      const pose = i !== w ? base[i] : params ? fkPose(perturbParams(params[i], rnd)) : perturbRigid(base[i], rnd);
      return computeOptic(pose, { id: `cast-${i}`, live: false });
    });
    const tr = traceLevel(level, optics);
    if (tr.solved) joint++;
    tr.crystals.forEach((c, k) => { if (c.state === 'lit') good[k]++; });
    tr.hush.forEach((h, k) => { if (!h.awake) good[nc + k]++; });
  }
  const perElement = good.map((g) => g / samples);
  return { min: perElement.length ? Math.min(...perElement) : 0, joint: joint / samples, perElement };
}

// ------------------------------------------------------------- difficulty

/** Placement (palm centre + heading) of a cast: from its FK params when known. */
export function castPlacement(level: ContentLevel, i: number): { hand: Handedness; at: V2; yaw: number } {
  const p = level.solutionParams?.[i];
  if (p) return { hand: p.hand, at: [p.at[0], p.at[1]], yaw: p.yaw ?? -Math.PI / 2 };
  const pose = decodeCast(level.solution![i]);
  return { hand: pose.hand, at: posePalm(pose), yaw: poseYaw(pose) };
}

const SEARCH_OFFS = [-0.0375, -0.0225, -0.0075, 0.0075, 0.0225, 0.0375];
const SEARCH_YAWS = [-20, -10, 0, 10, 20].map((d) => d * DEG);

/**
 * Share of a coarse one-hand search that solves: every library pose x a
 * 6 x 6 grid (1.5 cm steps) around the palm of solution cast `cast` x 5
 * headings (+-20 deg), with that cast's hand: 2880 trials (capped by `cap`).
 * The other solution casts (`others`, if any) stay in place.
 */
export function searchSolveShare(level: ContentLevel, cap = 3000, hand?: Handedness, cast = 0, others: HandOptic[] = []): number {
  const pl = castPlacement(level, cast);
  const h = hand ?? pl.hand;
  const hands = others.slice();
  hands.splice(cast, 0, null as unknown as HandOptic);
  let trials = 0;
  let solved = 0;
  outer: for (const name of POSE_NAMES) {
    for (const dx of SEARCH_OFFS) {
      for (const dz of SEARCH_OFFS) {
        for (const dy of SEARCH_YAWS) {
          if (trials >= cap) break outer;
          trials++;
          const pose = canonicalPose(name, h, [pl.at[0] + dx, pl.at[1] + dz], pl.yaw + dy);
          hands[cast] = computeOptic(pose, { id: 'probe', live: false });
          if (traceLevel(level, hands).solved) solved++;
        }
      }
    }
  }
  return trials ? solved / trials : 0;
}

/** Number of casts that only receive light through another cast (relay depth proxy). */
export function relayCount(level: LevelDef, optics: HandOptic[]): number {
  if (optics.length < 2) return 0;
  let n = 0;
  for (let i = 0; i < optics.length; i++) {
    const alone = traceLevel(level, [optics[i]]);
    const lit = optics[i].mode === 'blade'
      ? alone.segments.some((s) => optics[i].mirror && pointSegDistSq(s.a[0], s.a[1], optics[i].mirror!.a[0], optics[i].mirror!.a[1], optics[i].mirror!.b[0], optics[i].mirror!.b[1]) < 4e-6)
      : alone.hands[0].carried !== 0;
    if (!lit) n++;
  }
  return n;
}

/**
 * Difficulty. One cast: 1 - share of the coarse search that solves (0..1).
 * Several casts: (casts - 1) + 0.25 per relayed cast + the mean over casts of
 * (1 - search share with the other casts in place) + 0.01 per crystal, so any
 * multi-cast board ranks above every one-cast board.
 */
export function estimateDifficulty(level: ContentLevel, optics: HandOptic[], cap = 3000): number {
  const n = level.solution?.length ?? 0;
  if (n <= 1) return 1 - searchSolveShare(level, cap);
  const relays = relayCount(level, optics);
  let hard = 0;
  for (let i = 0; i < n; i++) {
    const others = optics.filter((_, j) => j !== i);
    hard += 1 - searchSolveShare(level, Math.floor(cap / n), undefined, i, others);
  }
  return n - 1 + 0.25 * relays + hard / n + 0.01 * level.crystals.length;
}

// ---------------------------------------------------------------- main

export function hasTag(level: ContentLevel, tag: string): boolean {
  return !!level.tags?.includes(tag);
}

/** Validates a board and its reference solution (see the module comment). */
export function validateBoard(level: ContentLevel, opts: ValidateOptions = {}): ValidationResult {
  const reasons: string[] = [];
  const casts = level.solution ?? [];
  if (!casts.length) return { ok: false, reasons: ['no reference solution'], difficulty: 0, robustness: 0, solveRate: 0 };
  if (casts.length > level.budget) reasons.push(`solution uses ${casts.length} casts, budget ${level.budget}`);
  if (!level.crystals.length) reasons.push('no crystals');

  const poses = casts.map(decodeCast);
  const optics = poses.map((p, i) => computeOptic(p, { id: `cast-${i}`, live: false }));
  const sol = traceLevel(level, optics);
  if (!sol.solved) {
    const dark = sol.crystals.filter((c) => c.state !== 'lit').length;
    const awake = sol.hush.filter((h) => h.awake).length;
    reasons.push(`reference solution fails (${dark} crystals not lit, ${awake} hush awake)`);
  }
  const empty = traceLevel(level, []);
  if (empty.solved) reasons.push('solved with no casts');
  if (empty.crystals.some((c) => c.received)) reasons.push('a crystal is lit with no casts');

  const params = level.solutionParams;
  if (params) {
    if (params.length !== casts.length) reasons.push('solutionParams / solution length mismatch');
    else {
      params.forEach((p, i) => {
        const fk = fkPose(p).pos;
        let err = 0;
        for (let k = 0; k < 75; k++) err = Math.max(err, Math.abs(fk[k] - poses[i].pos[k]));
        if (err > 0.0015) reasons.push(`cast ${i}: params do not reproduce the cast (${(err * 1000).toFixed(1)} mm)`);
      });
    }
  }

  if (opts.plausibility ?? true) reasons.push(...plausibilityReasons(level, poses, optics, sol));

  if ((opts.antiTrivial ?? true) && casts.length === 1 && !hasTag(level, 'allowAnySpread')) {
    const pl = castPlacement(level, 0);
    const rivals = hasTag(level, 'spreadSolution') ? (['flat'] as const) : (['spread', 'flat'] as const);
    for (const name of rivals) {
      const pose = canonicalPose(name, pl.hand, pl.at, pl.yaw);
      if (traceLevel(level, [computeOptic(pose, { id: 'rival', live: false })]).solved) {
        reasons.push(`a '${name}' hand at the same spot also solves`);
      }
    }
  }

  const samples = opts.robustSamples ?? 40;
  const rob = samples > 0 ? robustness(level, samples, opts.seed ?? solutionSeed(level)) : { min: 1, joint: 1, perElement: [] };
  if (samples > 0 && rob.min < (opts.robustMin ?? 0.8)) {
    const k = rob.perElement.indexOf(rob.min);
    const what = k < level.crystals.length ? `crystal ${k} lit` : `hush ${k - level.crystals.length} dark`;
    reasons.push(`fragile: ${what} in only ${Math.round(rob.min * 100)}% of wobbles`);
  }

  const difficulty = opts.difficulty ?? true ? estimateDifficulty(level, optics, opts.difficultyTrials ?? 3000) : 0;
  return { ok: reasons.length === 0, reasons, difficulty, robustness: rob.min, solveRate: rob.joint };
}
