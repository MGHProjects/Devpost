/**
 * Solution-first board generator (seeded, deterministic).
 *
 * A BoardSpec names the casts (pose + how each one receives light: palm in a
 * well, fingertip in a well, a fingertip pointing at a lamp, a lamp into the
 * wrist, another cast's ray into a fingertip / wrist, a lamp or ray off a
 * blade). The generator places each cast as a real FK hand resting on the
 * bench, adds the light sources that feed it, traces, then puts crystals
 * (colour = what arrives) 6-22 cm along the free output rays. Hush stones go
 * on the rays rival poses at the same spot would add (the would-be rays of
 * the curled fingers, and the angular gaps a wider / narrower spread would
 * hit), optional decoy wells / lamps and shortcut-blocking walls follow, and
 * validateBoard() has the last word; failed attempts retry with the same RNG
 * stream, so a (spec, seed) pair always yields the same board.
 *
 * Pure TS (no three.js / DOM). Uses trace2d, which is not re-entrant.
 */

import { fkPose, type PoseParams } from './fk-hand.js';
import { computeOptic } from './hand-features.js';
import { EXTENDED, POSES, canonicalPose, type PoseName, type PoseShape } from './pose-library.js';
import { TIP } from './joints.js';
import { CRYSTAL_R, HUSH_R, traceLevel } from './trace2d.js';
import type { CastData, ColorMask, Handedness, HandOptic, HandPose, Lamp, TraceResult, V2, Well } from './types.js';
import {
  BENCH, CAST_GAP, CAST_SPACING, FEED_MAX, FEED_MIN, LAMP_R, PROP_CLEAR, SIDE_LIMIT,
  castShapeReasons, circleGap, decodeCast, encodeCast, footprint, footprintGap, mulberry32, perturbParams, segmentGap,
  validateBoard, wellFeeds,
  type ContentLevel, type Footprint, type ValidateOptions, type ValidationResult,
} from './validate.js';
import { pointSegDistSq, rayBoxExit } from './vec2.js';

// ------------------------------------------------------------------- rng

/** Seeded PRNG (mulberry32) with the helpers the generator needs. */
export class Rng {
  private readonly f: () => number;
  constructor(seed: number) {
    this.f = mulberry32(seed);
  }
  next(): number {
    return this.f();
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.f();
  }
  int(n: number): number {
    return Math.floor(this.f() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

// ----------------------------------------------------------------- specs

export type Edge = 'far' | 'near' | 'left' | 'right';

export type FeedKind =
  | 'well-palm' // palm centre rests in a pool (feeds the wrist port)
  | 'well-tip' // one fingertip rests in a pool
  | 'lamp-tip' // a fingertip points at a lamp and catches its beam
  | 'lamp-wrist' // a lamp beam runs into the wrist
  | 'relay-tip' // another cast's ray into a fingertip
  | 'relay-wrist' // another cast's ray into the wrist
  | 'lamp-blade' // a blade hand mirrors a lamp beam
  | 'relay-blade'; // a blade hand mirrors another cast's ray

export interface FeedSpec {
  kind: FeedKind;
  /** Source colour for wells / lamps (default white). */
  color?: ColorMask;
  /** Receiving finger for *-tip feeds (default 1, the index). */
  finger?: number;
  /** relay-*: the source cast (default: the previous cast). */
  from?: number;
  /** relay-*: the source's output finger (-1 = its blade ray; default: any free output). */
  fromFinger?: number;
  /** Bench edges a lamp may sit on. */
  edges?: Edge[];
  /** Max angle (deg) between the arriving beam and the port's facing. */
  slack?: number;
  /** relay-*: distance range (m) from the source port to the receiving port / mirror. */
  dist?: [number, number];
}

export interface CastSpec {
  pose: PoseName;
  overrides?: Partial<PoseShape>;
  hand?: Handedness;
  feeds: FeedSpec[];
  /** How many output rays get crystals (default: all but the `free` ones). */
  crystals?: number;
  /**
   * Output fingers whose rays stay crystal-free (default [0]: a thumb's ray
   * swings ~20 deg over the validator's curl wobble, too much to aim at).
   */
  free?: number[];
  /** Heading range in degrees from "pointing away" (+ = turned toward the player's right). */
  yaw?: [number, number];
  /** Palm-centre region [xmin, xmax, zmin, zmax] (default: the hand's half of the bench). */
  region?: [number, number, number, number];
}

export interface BoardSpec {
  id: string;
  name?: string;
  hint?: string;
  intent?: string;
  chapter?: number;
  index?: number;
  casts: CastSpec[];
  /** Cast budget (default: number of casts). */
  budget?: number;
  tags?: string[];
  /** Rival poses forbidden with hush stones: 'all' fan poses (default), a list, or 'none'. */
  rivals?: 'all' | 'none' | PoseName[];
  /** Max hush stones the rival pass may add (default 6). */
  maxHush?: number;
  /**
   * Hush stones to show even when no rival needs them, on rays a rival pose
   * would add (default 1 on one-cast boards unless 'allowAnySpread', else 0).
   */
  minHush?: number;
  minCrystals?: number;
  decoyWells?: ColorMask[];
  decoyLamps?: ColorMask[];
  /** Multi-cast boards: wall off one-hand shortcuts found by a local search. */
  blockShortcuts?: boolean;
  /** Walls to place across rival rays even when no shortcut needs them. */
  minWalls?: number;
  /** Fixed palm region (overrides the hand's default half), [xmin, xmax, zmin, zmax]. */
  region?: [number, number, number, number];
  validate?: ValidateOptions;
}

export interface GenResult {
  level: ContentLevel;
  result: ValidationResult;
  attempts: number;
}

export interface GenOptions {
  /** Board attempts before giving up (default 40). */
  attempts?: number;
  validate?: ValidateOptions;
  /** Scales the placement search per attempt (default 1; the Kiln uses less for speed). */
  effort?: number;
  /** Debug hook: called with the failing stage of each rejected attempt. */
  onFail?: (stage: string, reasons?: string[]) => void;
}

// ---------------------------------------------------------------- helpers

/** Optional rejection counters for tuning specs (null = off). */
let stats: Record<string, number> | null = null;
export function collectGenStats(on: boolean): Record<string, number> | null {
  const prev = stats;
  stats = on ? {} : null;
  return prev;
}
const note = (k: string): false => {
  if (stats) stats[k] = (stats[k] ?? 0) + 1;
  return false;
};

const HW = BENCH.w / 2;
const HD = BENCH.d / 2;
const DEG = Math.PI / 180;
const WRIST = 5;
/** Generation keeps hands and props this far inside the bench edges. */
const EDGE_MARGIN = 0.008;
const PROP_MARGIN = 0.016;
const YAW_SAMPLE = 1.15;
/** Wobble samples used to pick robust crystal / hush spots. */
const WOBBLE_N = 64;
const COS_ASSIST = Math.cos(6 * DEG);
const FAN_RIVALS: PoseName[] = ['flat', 'spread', 'point', 'peace', 'three', 'four', 'L', 'shaka', 'rock', 'thumb', 'middle', 'pinky', 'relaxed'];

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const rot = (v: V2, a: number): V2 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};
const add = (a: V2, b: V2, k = 1): V2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const ang = (v: V2): number => Math.atan2(v[1], v[0]);
const dist = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const yawOk = (yaw: number): boolean => Math.abs(wrap(yaw + Math.PI / 2)) <= YAW_SAMPLE + 1e-9;

interface Template {
  shape: PoseShape;
  ports: { p: V2; d: V2; open: boolean }[];
  mirror?: { a: V2; b: V2 };
  /** Fingertips (xz) relative to the palm centre, for cheap bench-fit checks. */
  tips: V2[];
}

const templates = new Map<string, Template>();

/** Optic of a pose at the origin pointing away; ports rotate rigidly with yaw. */
function template(pose: PoseName, hand: Handedness, overrides?: Partial<PoseShape>): Template {
  const key = `${pose}|${hand}|${JSON.stringify(overrides ?? {})}`;
  let t = templates.get(key);
  if (!t) {
    const shape: PoseShape = { ...POSES[pose], ...overrides };
    const hp = canonicalPose(pose, hand, [0, 0], -Math.PI / 2, overrides);
    const o = computeOptic(hp, { id: 't', live: false });
    t = {
      tips: TIP.map((j) => [hp.pos[j * 3], hp.pos[j * 3 + 2]] as V2),
      shape,
      ports: o.ports.map((p) => ({ p: [p.p[0], p.p[1]] as V2, d: [p.dir[0], p.dir[1]] as V2, open: p.open || p.finger < 0 })),
      mirror: o.mirror ? { a: [...o.mirror.a] as V2, b: [...o.mirror.b] as V2 } : undefined,
    };
    templates.set(key, t);
  }
  return t;
}

/** Bench-edge point a ray from P along L leaves through, inset slightly; null when unsuitable. */
function lampOnEdge(P: V2, L: V2, edges: Edge[]): { p: V2; a: number; edge: Edge } | null {
  const t = rayBoxExit(P[0], P[1], L[0], L[1], HW, HD);
  if (!Number.isFinite(t)) return null;
  const E = add(P, L, t);
  let edge: Edge;
  let n: number;
  if (Math.abs(Math.abs(E[0]) - HW) < 1e-6) {
    edge = E[0] > 0 ? 'right' : 'left';
    n = Math.abs(L[0]);
  } else {
    edge = E[1] < 0 ? 'far' : 'near';
    n = Math.abs(L[1]);
  }
  if (!edges.includes(edge) || n < 0.35) return null;
  const p = add(P, L, t - 0.006 / n);
  if (Math.abs(p[0]) > HW - 0.02 && Math.abs(p[1]) > HD - 0.02) return null; // corner
  if (dist(p, P) < 0.05) return null;
  return { p: [r4(p[0]), r4(p[1])], a: r4(ang([-L[0], -L[1]])), edge };
}

function insideBench(p: V2, m: number): boolean {
  return Math.abs(p[0]) <= HW - m && Math.abs(p[1]) <= HD - m;
}

function segDist(p: V2, a: V2, b: V2): number {
  return Math.sqrt(pointSegDistSq(p[0], p[1], a[0], a[1], b[0], b[1]));
}

// ------------------------------------------------------------- the board

interface Placed {
  spec: CastSpec;
  params: PoseParams;
  cast: CastData;
  pose: HandPose;
  optic: HandOptic;
  fp: Footprint;
  /** Ports that receive light by design (0..4 fingers, 5 wrist). */
  feedPorts: number[];
  /** Colour this cast should carry. */
  color: ColorMask;
  /** Blade casts: the beams that strike the mirror (lamps or a source ray). */
  incoming: { o: V2; d: V2 }[];
  /** Lazily computed wobbled optics (see Builder.wobble). */
  wob?: HandOptic[];
}

interface Ray {
  o: V2;
  d: V2;
  cast: number;
  finger: number;
  len: number;
}

class Builder {
  level: ContentLevel;
  casts: Placed[] = [];
  consumed = new Set<string>();
  readonly wobSeed: number;

  constructor(readonly spec: BoardSpec, readonly rng: Rng, readonly effort = 1) {
    this.wobSeed = rng.int(0x7fffffff);
    this.level = {
      v: 1,
      id: spec.id,
      name: spec.name ?? spec.id,
      bench: { w: BENCH.w, d: BENCH.d },
      budget: spec.budget ?? spec.casts.length,
      lamps: [],
      wells: [],
      crystals: [],
      hush: [],
      walls: [],
      mirrors: [],
    };
  }

  optics(): HandOptic[] {
    return this.casts.map((c) => c.optic);
  }

  trace(optics = this.optics(), assist?: number): TraceResult {
    return traceLevel(this.level, optics, assist === undefined ? undefined : { assist });
  }

  // ---------------------------------------------------------- placement

  region(hand: Handedness, cast?: CastSpec): [number, number, number, number] {
    if (cast?.region) return cast.region;
    if (this.spec.region) return this.spec.region;
    return hand === 'right' ? [-0.04, 0.17, -0.03, 0.12] : [-0.17, 0.04, -0.03, 0.12];
  }

  sampleAt(hand: Handedness, cast?: CastSpec): V2 {
    const [x0, x1, z0, z1] = this.region(hand, cast);
    return [this.rng.range(x0, x1), this.rng.range(z0, z1)];
  }

  sampleYaw(cast?: CastSpec): number {
    if (cast?.yaw) return -Math.PI / 2 + this.rng.range(cast.yaw[0], cast.yaw[1]) * DEG;
    return -Math.PI / 2 + this.rng.range(-YAW_SAMPLE, YAW_SAMPLE);
  }

  /** A lamp on a bench edge whose beam strikes the blade at 25-65 deg, 35-80% along it. */
  bladeLamp(tpl: Template, at: V2, delta: number, f: FeedSpec): { p: V2; a: number } | null {
    const m = tpl.mirror!;
    const A = add(at, rot(m.a, delta));
    const B = add(at, rot(m.b, delta));
    const M = add(A, [B[0] - A[0], B[1] - A[1]], this.rng.range(0.35, 0.8));
    const md = rot([1, 0], ang([B[0] - A[0], B[1] - A[1]]));
    const beta = this.rng.range(25, 65) * DEG;
    const I = rot(md, (this.rng.chance(0.5) ? 1 : -1) * beta + (this.rng.chance(0.5) ? 0 : Math.PI));
    return lampOnEdge(M, [-I[0], -I[1]], f.edges ?? ['far', 'left', 'right']);
  }

  /** True when a later cast takes its light from cast idx. */
  feedsLater(idx: number): boolean {
    return this.spec.casts.some((c, j) => j > idx && c.feeds[0].kind.startsWith('relay') && (c.feeds[0].from ?? j - 1) === idx);
  }

  /** Cheap pre-check from the template: palm and tips on the bench, side rule, palm spacing. */
  templateFits(tpl: Template, hand: Handedness, at: V2, delta: number, feedPorts: number[] = [], free: number[] = [0]): boolean {
    const m = EDGE_MARGIN + 0.004;
    if (!insideBench(at, m)) return false;
    if (hand === 'right' ? at[0] < -SIDE_LIMIT : at[0] > SIDE_LIMIT) return false;
    for (const t of tpl.tips) if (!insideBench(add(at, rot(t, delta)), m)) return false;
    for (const c of this.casts) if (dist(c.optic.center, at) < CAST_SPACING + 0.005) return false;
    // Every output finger needs bench room for a crystal (or the next hand) ahead of it.
    for (let f = 0; f < 5; f++) {
      if (!tpl.ports[f].open || feedPorts.includes(f) || free.includes(f)) continue;
      const P = add(at, rot(tpl.ports[f].p, delta));
      const D = rot(tpl.ports[f].d, delta);
      if (!insideBench(P, 0) || rayBoxExit(P[0], P[1], D[0], D[1], HW, HD) < FEED_MIN + 0.03) return false;
    }
    return true;
  }

  /** Relay-derived placements must still honour the cast's own heading / region limits. */
  castLimitsOk(cast: CastSpec, at: V2, yaw: number): boolean {
    if (cast.yaw) {
      const off = wrap(yaw + Math.PI / 2) / DEG;
      if (off < cast.yaw[0] - 1e-6 || off > cast.yaw[1] + 1e-6) return false;
    }
    if (cast.region) {
      const [x0, x1, z0, z1] = cast.region;
      if (at[0] < x0 || at[0] > x1 || at[1] < z0 || at[1] > z1) return false;
    }
    return true;
  }

  /** Free output rays of cast i in trace tr. */
  outputs(i: number, tr: TraceResult): Ray[] {
    const c = this.casts[i];
    const o = c.optic;
    const rays: Ray[] = [];
    const firstSeg = (p: V2): number => {
      for (const s of tr.segments) if (dist(s.a, p) < 1.5e-3) return dist(s.a, s.b);
      return 0;
    };
    if (o.mode === 'fan') {
      for (let f = 0; f < 5; f++) {
        const port = o.ports[f];
        if (!port.open || c.feedPorts.includes(f) || !tr.hands[i].outMask[f]) continue;
        rays.push({ o: port.p, d: port.dir, cast: i, finger: f, len: firstSeg(port.p) });
      }
    } else if (o.mode === 'blade' && o.mirror) {
      const m = o.mirror;
      for (const s of tr.segments) {
        if (pointSegDistSq(s.a[0], s.a[1], m.a[0], m.a[1], m.b[0], m.b[1]) > 1e-6) continue;
        const l = dist(s.a, s.b);
        if (l < 1e-6) continue;
        rays.push({ o: s.a, d: [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l], cast: i, finger: -1 - rays.length, len: l });
      }
    }
    return rays;
  }

  /** Builds a cast from FK params (rounded, encoded and decoded like a stored level). */
  makeCast(spec: CastSpec, hand: Handedness, at: V2, yaw: number): Omit<Placed, 'feedPorts' | 'color' | 'incoming'> {
    const shape = template(spec.pose, hand, spec.overrides).shape;
    // Shapes stay canonical: at curl / spread limits half of the validator's
    // wobbles clamp back to the stored value, which keeps rays steadiest.
    const params: PoseParams = { ...shape, curl: [...shape.curl] as PoseParams['curl'], hand, at: [r4(at[0]), r4(at[1])], yaw: r4(yaw) };
    const cast = encodeCast(fkPose(params));
    const pose = decodeCast(cast);
    const optic = computeOptic(pose, { id: `cast-${this.casts.length}`, live: false });
    return { spec, params, cast, pose, optic, fp: footprint(pose) };
  }

  /** Cast vs bench, earlier casts and existing props. */
  castFits(c: Omit<Placed, 'feedPorts' | 'color' | 'incoming'>): boolean {
    const shrunk = { w: BENCH.w - 2 * EDGE_MARGIN, d: BENCH.d - 2 * EDGE_MARGIN };
    if (castShapeReasons(c.pose, shrunk).length) return note('fit: bench/yaw/side');
    for (const p of this.casts) {
      if (dist(p.optic.center, c.optic.center) < CAST_SPACING + 0.005) return note('fit: palms close');
      if (footprintGap(p.fp, c.fp) < CAST_GAP + 0.003) return note('fit: hands overlap');
    }
    const L = this.level;
    for (const l of L.lamps) if (circleGap(c.fp, l.p, LAMP_R) < PROP_CLEAR + 0.003) return false;
    for (const w of L.walls) if (segmentGap(c.fp, w.a, w.b) < PROP_CLEAR + 0.003) return false;
    for (const w of L.wells) if (!wellFeeds(c.optic, w) && circleGap(c.fp, w.p, w.r) < PROP_CLEAR + 0.003) return false;
    return true;
  }

  /** New props vs every cast (existing + the candidate). */
  propsFit(lamps: Lamp[], wells: Well[], all: Omit<Placed, 'feedPorts' | 'color' | 'incoming'>[]): boolean {
    for (const c of all) {
      for (const l of lamps) if (circleGap(c.fp, l.p, LAMP_R) < PROP_CLEAR + 0.003) return false;
      for (const w of wells) if (!wellFeeds(c.optic, w) && circleGap(c.fp, w.p, w.r) < PROP_CLEAR + 0.003) return false;
    }
    for (const w of wells) {
      if (!insideBench(w.p, w.r + 0.004)) return false;
      for (const v of this.level.wells) if (dist(v.p, w.p) < v.r + w.r + 0.01) return false;
    }
    for (const l of lamps) for (const k of this.level.lamps) if (dist(k.p, l.p) < 0.03) return false;
    if (wells.length === 2 && dist(wells[0].p, wells[1].p) < wells[0].r + wells[1].r + 0.01) return false;
    return true;
  }

  /** Places cast `idx` (spec.casts[idx]); returns false after too many tries. */
  placeCast(idx: number, tries = Math.ceil(120 * this.effort)): boolean {
    const spec = this.spec.casts[idx];
    const before = this.trace();
    const expected = this.casts.map((c, i) => before.hands[i].carried);
    for (let t = 0; t < tries; t++) {
      const hand: Handedness = spec.hand ?? this.rng.pick(['left', 'right'] as const);
      const tpl = template(spec.pose, hand, spec.overrides);
      const lamps: Lamp[] = [];
      const wells: Well[] = [];
      const feedPorts: number[] = [];
      let color = 0;
      let at: V2 | null = null;
      let yaw = 0;
      const primary = spec.feeds[0];
      const pk = primary.kind;

      let rayKey: string | null = null;
      const incoming: { o: V2; d: V2 }[] = [];
      if (pk === 'relay-tip' || pk === 'relay-wrist' || pk === 'relay-blade') {
        const from = primary.from ?? idx - 1;
        const src = this.casts[from];
        if (!src) return false;
        const rays = this.outputs(from, before).filter((r) =>
          !this.consumed.has(`${r.cast}:${r.finger}`) && (primary.fromFinger === undefined || r.finger === primary.fromFinger));
        if (!rays.length) return false;
        const ray = this.rng.pick(rays);
        const [tMin, tCap] = primary.dist ?? [0.04, 0.17];
        const tMax = Math.min(tCap, ray.len - 0.03);
        if (tMax < tMin) { note('relay: ray too short'); continue; }
        color = src.color;
        const port = pk === 'relay-tip' ? primary.finger ?? 1 : WRIST;
        const slack = (primary.slack ?? (pk === 'relay-tip' ? 30 : 45)) * DEG;
        // Cheap search over (distance along the ray, heading) with template geometry.
        let found = false;
        for (let k = 0, n = Math.ceil(400 * this.effort); k < n && !found; k++) {
          const P = add(ray.o, ray.d, this.rng.range(tMin, tMax));
          let delta: number;
          let aAt: V2;
          if (pk === 'relay-blade') {
            // Mirror line at 25-65 deg to the incoming ray, hit point 35-80% along it.
            const m = tpl.mirror!;
            const lam = ang(ray.d) + this.rng.range(25, 65) * DEG * (this.rng.chance(0.5) ? 1 : -1);
            delta = wrap(lam - ang([m.b[0] - m.a[0], m.b[1] - m.a[1]]));
            if (!yawOk(delta - Math.PI / 2)) delta = wrap(delta + Math.PI);
            aAt = add(P, rot(add(m.a, [m.b[0] - m.a[0], m.b[1] - m.a[1]], this.rng.range(0.35, 0.8)), delta), -1);
          } else {
            // Port facing within `slack` of the reversed ray, heading within the yaw limits.
            const face0 = ang([-ray.d[0], -ray.d[1]]) - ang(tpl.ports[port].d);
            const lo = Math.max(-slack, -YAW_SAMPLE - wrap(face0));
            const hi = Math.min(slack, YAW_SAMPLE - wrap(face0));
            if (lo > hi) { note('relay: yaw'); break; }
            delta = wrap(face0) + this.rng.range(lo, hi);
            aAt = add(P, rot(tpl.ports[port].p, delta), -1);
          }
          const y = wrap(delta - Math.PI / 2);
          if (!yawOk(y) || !this.castLimitsOk(spec, aAt, y)) continue;
          if (!this.templateFits(tpl, hand, aAt, delta, pk === 'relay-blade' ? [] : [port], spec.free)) continue;
          yaw = y;
          at = aAt;
          found = true;
          if (pk === 'relay-blade') incoming.push({ o: ray.o, d: ray.d });
          else feedPorts.push(port);
        }
        if (!found) { note('relay: no fit'); continue; }
        rayKey = `${ray.cast}:${ray.finger}`;
      } else {
        yaw = this.sampleYaw(spec);
      }
      const delta = yaw + Math.PI / 2;
      if (pk === 'well-palm') {
        const r = r4(this.rng.range(0.03, 0.04));
        const C = this.sampleAt(hand, spec);
        at = add(C, rot([this.rng.range(-1, 1), this.rng.range(-1, 1)], 0), 0.25 * r);
        wells.push({ p: [r4(C[0]), r4(C[1])], r, color: primary.color ?? 7 });
        feedPorts.push(WRIST);
        color |= primary.color ?? 7;
      } else if (pk === 'lamp-blade') {
        at = this.sampleAt(hand, spec);
        const lamp = this.bladeLamp(tpl, at, delta, primary);
        if (!lamp) { note('blade lamp edge'); continue; }
        lamps.push({ p: lamp.p, a: lamp.a, color: primary.color ?? 7 });
        incoming.push({ o: lamp.p, d: [Math.cos(lamp.a), Math.sin(lamp.a)] });
        color |= primary.color ?? 7;
      } else if (!rayKey) {
        at = this.sampleAt(hand, spec);
      }

      if (!at) continue;
      const base: V2 = at;
      if (!rayKey && tpl.mirror === undefined) {
        const fp = spec.feeds.map((f) => (f.kind === 'well-palm' || f.kind === 'lamp-wrist' ? WRIST : f.finger ?? 1));
        if (!this.templateFits(tpl, hand, base, delta, fp, spec.free)) { note('fit: template'); continue; }
      }
      // Feeds that hang off the placed hand (primary tip / wrist feeds and every secondary feed).
      let bad = false;
      for (let k = 0; k < spec.feeds.length && !bad; k++) {
        const f = spec.feeds[k];
        if (k === 0 && (f.kind === 'well-palm' || f.kind === 'lamp-blade' || rayKey)) continue;
        const c = f.color ?? 7;
        if (f.kind === 'lamp-blade' && tpl.mirror) {
          const lamp = this.bladeLamp(tpl, base, delta, f);
          if (!lamp) { bad = true; break; }
          lamps.push({ p: lamp.p, a: lamp.a, color: c });
          incoming.push({ o: lamp.p, d: [Math.cos(lamp.a), Math.sin(lamp.a)] });
          color |= c;
          continue;
        }
        if (f.kind === 'well-tip' || f.kind === 'lamp-tip' || f.kind === 'lamp-wrist') {
          const port = f.kind === 'lamp-wrist' ? WRIST : f.finger ?? 1;
          if (port !== WRIST && !tpl.ports[port].open) { bad = true; break; }
          const P = add(base, rot(tpl.ports[port].p, delta));
          const D = rot(tpl.ports[port].d, delta);
          if (f.kind === 'well-tip') {
            const r = r4(this.rng.range(0.022, 0.028));
            const C = add(add(P, D, 0.3 * r), [this.rng.range(-1, 1), this.rng.range(-1, 1)], 0.15 * r);
            wells.push({ p: [r4(C[0]), r4(C[1])], r, color: c });
          } else {
            const slack = (f.slack ?? (f.kind === 'lamp-tip' ? 3 : 45)) * DEG;
            const L = rot(D, this.rng.range(-slack, slack));
            const lamp = lampOnEdge(P, L, f.edges ?? (f.kind === 'lamp-tip' ? ['far', 'left', 'right'] : ['left', 'right', 'near']));
            if (!lamp) { bad = !!note(`${f.kind} edge`) || true; break; }
            lamps.push({ p: lamp.p, a: lamp.a, color: c });
          }
          feedPorts.push(port);
          color |= c;
        } else {
          bad = true; // relay / blade feeds must be primary
        }
      }
      if (bad) continue;
      if (rayKey) this.consumed.add(rayKey);
      if (this.tryCommit(spec, hand, base, yaw, feedPorts, color, lamps, wells, idx, expected, incoming)) return true;
      if (rayKey) this.consumed.delete(rayKey);
    }
    return false;
  }

  tryCommit(
    spec: CastSpec, hand: Handedness, at: V2, yaw: number, feedPorts: number[], color: ColorMask,
    lamps: Lamp[], wells: Well[], idx: number, expected: number[], incoming: { o: V2; d: V2 }[] = [],
  ): boolean {
    const c = this.makeCast(spec, hand, at, yaw);
    if (!this.castFits(c)) return false;
    if (!this.propsFit(lamps, wells, [...this.casts, c])) return note('props fit');
    const L = this.level;
    const nl = L.lamps.length;
    const nw = L.wells.length;
    L.lamps.push(...lamps);
    L.wells.push(...wells);
    const placed: Placed = { ...c, feedPorts, color, incoming };
    this.casts.push(placed);
    const tr = this.trace();
    let ok = true;
    for (let i = 0; i < idx && ok; i++) if (tr.hands[i].carried !== expected[i]) ok = note('trace: disturbs an earlier hand');
    const io = tr.hands[idx];
    if (ok && c.optic.mode === 'fan') {
      if (!feedPorts.every((p) => io.inMask[p] !== 0)) ok = note('trace: feed port dark');
      else if (io.carried !== color) ok = note('trace: wrong colour');
      else if (!io.outMask.some((m) => m !== 0)) ok = note('trace: no output');
      // Designed outputs must emit: no open, non-feed finger may be lit by accident.
      for (let f = 0; f < 5 && ok; f++) if (c.optic.ports[f].open && !feedPorts.includes(f) && io.inMask[f]) ok = note('trace: output finger lit');
    } else if (ok && c.optic.mode === 'blade') {
      ok = this.outputs(idx, tr).length > 0 || note('trace: blade dark');
    } else if (ok) ok = note('trace: hand is neither fan nor blade');
    if (ok && spec.feeds[0].kind.startsWith('relay') && c.optic.mode === 'fan') {
      // The relayed light must arrive where designed.
      const src = this.casts[spec.feeds[0].from ?? idx - 1].color;
      if ((io.inMask[feedPorts[0]] & src) !== src) ok = note('trace: relay missed');
    }
    if (ok && this.feedsLater(idx) && !this.outputs(idx, tr).some((r) => r.len >= 0.12)) ok = note('source: rays too short');
    if (!ok) {
      this.casts.pop();
      L.lamps.length = nl;
      L.wells.length = nw;
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------ crystals

  /** Distance from p to every trace segment except those starting at `skip`. */
  beamClear(p: V2, tr: TraceResult, skip?: V2): number {
    let best = Infinity;
    for (const s of tr.segments) {
      if (skip && dist(s.a, skip) < 1.5e-3) continue;
      best = Math.min(best, segDist(p, s.a, s.b));
    }
    return best;
  }

  propClear(p: V2, r: number): boolean {
    const L = this.level;
    if (!insideBench(p, PROP_MARGIN)) return false;
    for (const c of this.casts) if (circleGap(c.fp, p, r) < PROP_CLEAR + 0.003) return false;
    for (const c of L.crystals) if (dist(c.p, p) < 0.035) return false;
    for (const h of L.hush) if (dist(h.p, p) < 0.034) return false;
    for (const l of L.lamps) if (dist(l.p, p) < 0.03) return false;
    for (const w of L.wells) if (dist(w.p, p) < w.r + r + 0.006) return false;
    for (const w of L.walls) if (segDist(p, w.a, w.b) < r + 0.008) return false;
    return true;
  }

  /** WOBBLE_N perturbed optics of cast i (the validator's wobble model, own seed). */
  wobble(i: number): HandOptic[] {
    const c = this.casts[i];
    if (!c.wob) {
      const rnd = mulberry32(this.wobSeed + i * 7919);
      c.wob = [];
      for (let k = 0; k < WOBBLE_N; k++) c.wob.push(computeOptic(fkPose(perturbParams(c.params, rnd)), { id: 'w', live: false }));
    }
    return c.wob;
  }

  /** Output rays of cast i / finger f in wobble sample k (blade: reflections of every incoming beam). */
  wobbleRays(i: number, f: number, k: number): { o: V2; d: V2 }[] {
    const o = this.wobble(i)[k];
    if (f >= 0) {
      const p = o.ports[f];
      return p.open ? [{ o: p.p, d: p.dir }] : [];
    }
    const out: { o: V2; d: V2 }[] = [];
    if (!o.mirror) return out;
    const m = o.mirror;
    const ex = m.b[0] - m.a[0];
    const ez = m.b[1] - m.a[1];
    const l = Math.hypot(ex, ez);
    for (const inc of this.casts[i].incoming) {
      const den = inc.d[0] * ez - inc.d[1] * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = m.a[0] - inc.o[0];
      const wz = m.a[1] - inc.o[1];
      const t = (wx * ez - wz * ex) / den;
      const u = (wx * inc.d[1] - wz * inc.d[0]) / den;
      if (t <= 0 || u < 0 || u > 1) continue;
      const nx = -ez / l;
      const nz = ex / l;
      const k2 = 2 * (inc.d[0] * nx + inc.d[1] * nz);
      out.push({ o: add(inc.o, inc.d, t), d: [inc.d[0] - k2 * nx, inc.d[1] - k2 * nz] });
    }
    return out;
  }

  /** Share of wobble samples whose ray (natural or assisted) reaches a crystal at c. */
  hitRate(ray: Ray, c: V2): number {
    let hit = 0;
    for (let k = 0; k < WOBBLE_N; k++) {
      const ok = this.wobbleRays(ray.cast, ray.finger, k).some((w) => {
        const vx = c[0] - w.o[0];
        const vz = c[1] - w.o[1];
        const t = vx * w.d[0] + vz * w.d[1];
        return t > 0 && (Math.abs(vx * w.d[1] - vz * w.d[0]) < CRYSTAL_R - 0.001 || t / Math.hypot(vx, vz) > COS_ASSIST);
      });
      if (ok) hit++;
    }
    return hit / WOBBLE_N;
  }

  /** Share of wobble samples in which some output beam (up to its nominal length) grazes a hush at c. */
  wakeRate(c: V2, outs: { ray: Ray; len: number }[]): number {
    let wake = 0;
    for (let k = 0; k < WOBBLE_N; k++) {
      const hit = outs.some(({ ray, len }) =>
        this.wobbleRays(ray.cast, ray.finger, k).some((w) => segDist(c, w.o, add(w.o, w.d, len + 0.01)) < HUSH_R + 0.002));
      if (hit) wake++;
    }
    return wake / WOBBLE_N;
  }

  /** Every output ray of the solution with its lit length (to its crystal, port or edge). */
  solutionOutputs(tr: TraceResult): { ray: Ray; len: number }[] {
    const out: { ray: Ray; len: number }[] = [];
    for (let i = 0; i < this.casts.length; i++) for (const ray of this.outputs(i, tr)) out.push({ ray, len: ray.len });
    return out;
  }

  placeCrystals(): boolean {
    const tr = this.trace();
    for (let i = 0; i < this.casts.length; i++) {
      const spec = this.casts[i].spec;
      const free = spec.free ?? [0];
      let rays = this.outputs(i, tr).filter((r) => !this.consumed.has(`${r.cast}:${r.finger}`) && !free.includes(r.finger));
      if (spec.crystals !== undefined) {
        if (rays.length < spec.crystals) return false;
        rays = this.rng.shuffle(rays).slice(0, spec.crystals).sort((a, b) => a.finger - b.finger);
      }
      for (const ray of rays) {
        const opts: { p: V2; score: number }[] = [];
        const dMax = Math.min(FEED_MAX - 0.005, ray.len - 0.022);
        const side: V2 = [-ray.d[1], ray.d[0]];
        for (let d = FEED_MIN + 0.005; d <= dMax; d += 0.005) {
          for (const lat of [-0.008, -0.004, 0, 0.004, 0.008]) {
            const p = add(add(ray.o, ray.d, d), side, lat);
            if (!this.propClear(p, CRYSTAL_R)) continue;
            if (this.beamClear(p, tr, ray.o) < CRYSTAL_R + 0.007) continue;
            opts.push({ p, score: this.hitRate(ray, p) + this.rng.next() * 0.01 });
          }
        }
        if (!opts.length) return note('crystal: no spot');
        let best = opts[0];
        for (const o of opts) if (o.score > best.score) best = o;
        // Among near-best spots, take a random one so boards don't all look alike.
        const good = opts.filter((o) => o.score >= best.score - 0.026);
        const pick = this.rng.pick(good);
        this.level.crystals.push({ p: [r4(pick.p[0]), r4(pick.p[1])], color: 7 });
      }
    }
    if (this.level.crystals.length < (this.spec.minCrystals ?? 1)) return false;
    const lit = this.trace();
    for (let k = 0; k < this.level.crystals.length; k++) {
      const got = lit.crystals[k].received;
      if (!got) return false;
      this.level.crystals[k].color = got;
    }
    return this.trace().solved;
  }

  // ------------------------------------------------------------- rivals

  /** Rival hands for cast i (same hand, palm and heading). */
  rivalPoses(i: number): { name: string; pose: HandPose; mandatory: boolean }[] {
    const c = this.casts[i];
    const p = c.params;
    const tags = this.spec.tags ?? [];
    const single = this.spec.casts.length === 1;
    const out: { name: string; pose: HandPose; mandatory: boolean }[] = [];
    const yaw = p.yaw ?? -Math.PI / 2;
    const mandatory = single && !tags.includes('allowAnySpread')
      ? tags.includes('spreadSolution') ? ['flat'] : ['spread', 'flat']
      : [];
    for (const m of mandatory) out.push({ name: m, pose: canonicalPose(m as PoseName, p.hand, p.at, yaw), mandatory: true });
    if (this.spec.rivals === 'none' || tags.includes('allowAnySpread')) return out;
    const names = this.spec.rivals && this.spec.rivals !== 'all' ? this.spec.rivals : FAN_RIVALS;
    const solExt = EXTENDED[c.spec.pose].join();
    for (const n of names) {
      if (mandatory.includes(n) || (n === c.spec.pose && !c.spec.overrides)) continue;
      if (c.optic.mode === 'blade' && n !== 'flat' && n !== 'spread') continue;
      if (EXTENDED[n].join() === solExt && !c.spec.overrides) continue;
      out.push({ name: n, pose: canonicalPose(n, p.hand, p.at, yaw), mandatory: false });
    }
    if (c.optic.mode === 'fan' && c.spec.pose !== 'flat' && c.spec.pose !== 'spread') {
      out.push({ name: 'open', pose: fkPose({ ...p, curl: [0, 0, 0, 0, 0] }), mandatory: false });
    }
    return out;
  }

  /** Puts one hush stone on a ray the rival emits but the solution does not. */
  forbid(rivalOptics: HandOptic[], i: number, sol: TraceResult, empty: TraceResult): boolean {
    const nat = this.trace(rivalOptics, 0);
    const ro = rivalOptics[i];
    const solSegs = sol.segments;
    const outs = this.solutionOutputs(sol);
    let best: { p: V2; score: number } | null = null;
    for (const s of nat.segments) {
      if (!ro.ports.some((p, k) => k < 5 && p.open && dist(p.p, s.a) < 1.5e-3)) continue;
      const l = dist(s.a, s.b);
      if (l < 0.04) continue;
      const d: V2 = [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
      // Same ray as the solution's (same finger left open)? Nothing to forbid there.
      if (solSegs.some((q) => {
        if (dist(q.a, s.a) > 3e-3) return false;
        const ql = dist(q.a, q.b);
        return ql > 1e-6 && ((q.b[0] - q.a[0]) * d[0] + (q.b[1] - q.a[1]) * d[1]) / ql > Math.cos(1.5 * DEG);
      })) continue;
      for (let t = 0.035; t <= Math.min(l - 0.018, 0.2); t += 0.006) {
        const p = add(s.a, d, t);
        if (!this.propClear(p, HUSH_R)) continue;
        const clear = this.beamClear(p, sol);
        if (clear < HUSH_R + 0.012) continue;
        if (this.beamClear(p, empty) < HUSH_R + 0.004) continue;
        if (this.wakeRate(p, outs) > 0.02) continue;
        const score = Math.min(clear - HUSH_R - 0.012, 0.02) * 3 - Math.abs(t - 0.07) + this.rng.next() * 0.005;
        if (!best || score > best.score) best = { p, score };
      }
    }
    if (!best) return false;
    this.level.hush.push({ p: [r4(best.p[0]), r4(best.p[1])] });
    if (!this.trace().solved) {
      this.level.hush.pop();
      return false;
    }
    return true;
  }

  forbidRivals(): boolean {
    const maxHush = this.spec.maxHush ?? 6;
    for (let i = 0; i < this.casts.length; i++) {
      for (const rival of this.rivalPoses(i)) {
        for (let k = 0; k < 4; k++) {
          const optics = this.optics().slice();
          optics[i] = computeOptic(rival.pose, { id: `cast-${i}`, live: false });
          if (!this.trace(optics).solved) break;
          const sol = this.trace();
          const empty = this.trace([]);
          if (this.level.hush.length >= maxHush || !this.forbid(optics, i, sol, empty)) {
            if (rival.mandatory) return false;
            break;
          }
        }
      }
    }
    // Teaching hush: mark where the would-be rays of closed fingers (or a wrong spread) would go.
    const single = this.spec.casts.length === 1 && !(this.spec.tags ?? []).includes('allowAnySpread');
    const minHush = this.spec.minHush ?? (single ? 1 : 0);
    for (let i = 0; i < this.casts.length && this.level.hush.length < minHush; i++) {
      const rivals = this.rivalPoses(i).sort((a, b) => Number(b.name === 'open') - Number(a.name === 'open'));
      for (const rival of rivals) {
        if (this.level.hush.length >= minHush) break;
        const optics = this.optics().slice();
        optics[i] = computeOptic(rival.pose, { id: `cast-${i}`, live: false });
        this.forbid(optics, i, this.trace(), this.trace([]));
      }
    }
    return this.level.hush.length >= minHush;
  }

  // ------------------------------------------------------------- extras

  addDecoys(): boolean {
    const L = this.level;
    for (const color of this.spec.decoyWells ?? []) {
      let done = false;
      for (let t = 0; t < 80 && !done; t++) {
        const r = r4(this.rng.range(0.028, 0.035));
        const p: V2 = [r4(this.rng.range(-HW + r + 0.01, HW - r - 0.01)), r4(this.rng.range(-HD + r + 0.01, HD - r - 0.01))];
        if (!this.propClear(p, r)) continue;
        if (!this.propsFit([], [{ p, r, color }], this.casts)) continue;
        L.wells.push({ p, r, color });
        if (this.trace().solved) done = true;
        else L.wells.pop();
      }
      if (!done) return false;
    }
    for (const color of this.spec.decoyLamps ?? []) {
      let done = false;
      for (let t = 0; t < 200 && !done; t++) {
        const edge = this.rng.pick(['far', 'left', 'right'] as const);
        let p: V2;
        let a: number;
        if (edge === 'far') {
          p = [this.rng.range(-HW + 0.03, HW - 0.03), -HD + 0.006];
          a = Math.PI / 2 + this.rng.range(-0.6, 0.6);
        } else {
          const s = edge === 'right' ? 1 : -1;
          p = [s * (HW - 0.006), this.rng.range(-HD + 0.03, HD - 0.03)];
          a = (s > 0 ? Math.PI : 0) + this.rng.range(-0.6, 0.6);
        }
        const lamp: Lamp = { p: [r4(p[0]), r4(p[1])], a: r4(a), color };
        if (!this.propClear(lamp.p, LAMP_R) || !this.propsFit([lamp], [], this.casts)) continue;
        const before = this.trace();
        L.lamps.push(lamp);
        const tr = this.trace();
        const empty = this.trace([]);
        const same = tr.solved && tr.hands.every((h, i) => h.carried === before.hands[i].carried) &&
          !empty.crystals.some((c) => c.received) && !empty.hush.some((h) => h.awake);
        if (same) done = true;
        else L.lamps.pop();
      }
      if (!done) return false;
    }
    return true;
  }

  /** Multi-cast boards: walls across the beams of one-hand shortcuts found near the casts. */
  blockShortcuts(): boolean {
    const offs = [-0.03, -0.015, 0, 0.015, 0.03];
    const yaws = [-15, 0, 15].map((d) => d * DEG);
    for (let wall = 0; wall < 4; wall++) {
      let shortcut: HandOptic | null = null;
      search: for (const c of this.casts) {
        for (const name of FAN_RIVALS) {
          for (const dx of offs) for (const dz of offs) for (const dy of yaws) {
            const pose = canonicalPose(name, c.params.hand, [c.params.at[0] + dx, c.params.at[1] + dz], (c.params.yaw ?? -Math.PI / 2) + dy);
            const o = computeOptic(pose, { id: 'probe', live: false });
            if (this.trace([o]).solved) { shortcut = o; break search; }
          }
        }
      }
      if (!shortcut) return true;
      if (!this.wallAcross(shortcut)) return false;
    }
    return false;
  }

  /** Walls across the rays rival poses would add, until there are `n`. */
  addWalls(n: number): boolean {
    for (let i = 0; i < this.casts.length && this.level.walls.length < n; i++) {
      for (const rival of this.rivalPoses(i)) {
        if (this.level.walls.length >= n) break;
        this.wallAcross(computeOptic(rival.pose, { id: 'rival', live: false }));
      }
    }
    return this.level.walls.length >= n;
  }

  wallAcross(o: HandOptic): boolean {
    const tr = this.trace([o], 0);
    const sol = this.trace();
    const empty = this.trace([]);
    for (const s of this.rng.shuffle(tr.segments.slice())) {
      if (!o.ports.some((p) => dist(p.p, s.a) < 1.5e-3)) continue;
      const l = dist(s.a, s.b);
      if (l < 0.05) continue;
      const d: V2 = [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
      for (let t = 0.03; t < l - 0.02; t += 0.008) {
        const c = add(s.a, d, t);
        const half = r4(this.rng.range(0.02, 0.03));
        const n: V2 = [-d[1], d[0]];
        const a: V2 = [r4(c[0] + n[0] * half), r4(c[1] + n[1] * half)];
        const b: V2 = [r4(c[0] - n[0] * half), r4(c[1] - n[1] * half)];
        if (!insideBench(a, 0.01) || !insideBench(b, 0.01)) continue;
        if (this.casts.some((k) => segmentGap(k.fp, a, b) < PROP_CLEAR + 0.004)) continue;
        const L = this.level;
        if (L.crystals.some((k) => segDist(k.p, a, b) < CRYSTAL_R + 0.012)) continue;
        if (L.hush.some((k) => segDist(k.p, a, b) < HUSH_R + 0.012)) continue;
        if (L.lamps.some((k) => segDist(k.p, a, b) < 0.02)) continue;
        if ([...sol.segments, ...empty.segments].some((q) => segSegClear(q.a, q.b, a, b) < 0.012)) continue;
        L.walls.push({ a, b });
        if (this.trace().solved) return true;
        L.walls.pop();
      }
    }
    return false;
  }

  finish(): ContentLevel {
    const L = this.level;
    const s = this.spec;
    L.solution = this.casts.map((c) => c.cast);
    L.solutionParams = this.casts.map((c) => c.params);
    if (s.hint) L.hint = s.hint;
    if (s.chapter !== undefined) L.chapter = s.chapter;
    if (s.index !== undefined) L.index = s.index;
    if (s.tags?.length) L.tags = [...s.tags];
    if (s.intent) L.intent = s.intent;
    return L;
  }
}

function segSegClear(a: V2, b: V2, c: V2, d: V2): number {
  const o = (p: V2, q: V2, r: V2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b));
}

// ------------------------------------------------------------------- API

/** One attempt with the given RNG; null when any stage fails. */
function attempt(spec: BoardSpec, rng: Rng, vopts: ValidateOptions, effort: number, onFail?: (stage: string, reasons?: string[]) => void): GenResult | null {
  const b = new Builder(spec, rng, effort);
  const fail = (stage: string, reasons?: string[]): null => {
    onFail?.(stage, reasons);
    return null;
  };
  for (let i = 0; i < spec.casts.length; i++) if (!b.placeCast(i)) return fail(`place cast ${i}`);
  if (!b.placeCrystals()) return fail('crystals');
  if (!b.forbidRivals()) return fail('rivals');
  if (!b.addDecoys()) return fail('decoys');
  if (spec.blockShortcuts && spec.casts.length > 1 && !b.blockShortcuts()) return fail('shortcuts');
  if (!b.addWalls(spec.minWalls ?? 0)) return fail('walls');
  const level = b.finish();
  const result = validateBoard(level, vopts);
  return result.ok ? { level, result, attempts: 0 } : fail('validate', result.reasons);
}

/** Generates a validated board for `spec`; deterministic for a given seed. Null if every attempt fails. */
export function generateBoard(spec: BoardSpec, seed: number, opts: GenOptions = {}): GenResult | null {
  const rng = new Rng(seed);
  const vopts = { ...spec.validate, ...opts.validate };
  const n = opts.attempts ?? 40;
  for (let a = 1; a <= n; a++) {
    const r = attempt(spec, rng, vopts, opts.effort ?? 1, opts.onFail);
    if (r) return { ...r, attempts: a };
  }
  return null;
}

// --------------------------------------------------------- random specs

const PRIMARY: ColorMask[] = [1, 2, 4];
const ANY_COLOR: ColorMask[] = [7, 7, 1, 2, 4, 3, 5, 6];

/**
 * A random board recipe ("chapter vocabulary") for the Daily and the Kiln,
 * drawn only from patterns the generator places reliably:
 * tier 1 = one hand fed by a pool, a pointed-at lamp, a wrist lamp or a
 * fingertip pool; tier 2 = one hand mixing two coloured sources, or a blade
 * with one or two lamps; tier 3 = two casts (fingertip relay, mirror then
 * catch, or pointing into a blade).
 */
export function randomSpec(rng: Rng, tier: 1 | 2 | 3, id: string): BoardSpec {
  const hand: Handedness = rng.chance(0.5) ? 'right' : 'left';
  const other: Handedness = hand === 'right' ? 'left' : 'right';
  if (tier === 1) {
    const color = rng.pick(ANY_COLOR);
    const recipes: (() => CastSpec)[] = [
      () => ({ pose: rng.pick(['point', 'peace', 'three', 'four', 'rock', 'pinky'] as const), hand, feeds: [{ kind: 'well-palm', color }] }),
      () => ({ pose: rng.pick(['peace', 'three', 'four'] as const), hand, feeds: [{ kind: 'lamp-tip', finger: 1, color }] }),
      () => ({ pose: 'rock', hand, feeds: [{ kind: 'lamp-tip', finger: rng.pick([1, 4]), color }] }),
      () => ({ pose: rng.pick(['point', 'peace', 'rock'] as const), hand, feeds: [{ kind: 'lamp-wrist', color }] }),
      () => ({ pose: rng.pick(['L', 'shaka'] as const), hand, feeds: [{ kind: 'well-tip', finger: 0, color }] }),
      () => ({ pose: 'peace', hand, feeds: [{ kind: 'well-tip', finger: 1, color }] }),
    ];
    return { id, casts: [rng.pick(recipes)()] };
  }
  if (tier === 2) {
    const [c1, c2] = rng.shuffle(PRIMARY.slice());
    const recipes: (() => BoardSpec)[] = [
      () => ({ id, casts: [{ pose: 'blade', hand, feeds: [{ kind: 'lamp-blade', color: rng.pick(ANY_COLOR) }] }] }),
      () => ({ id, casts: [{ pose: 'blade', hand, feeds: [{ kind: 'lamp-blade', color: c1 }, { kind: 'lamp-blade', color: c2 }] }] }),
      () => ({ id, casts: [{ pose: rng.pick(['peace', 'three'] as const), hand, feeds: [{ kind: 'lamp-tip', finger: 1, color: c1 }, { kind: 'lamp-wrist', color: c2 }] }] }),
      () => ({ id, casts: [{ pose: rng.pick(['three', 'four'] as const), hand, feeds: [{ kind: 'well-palm', color: c1 }, { kind: 'well-tip', finger: 1, color: c2 }] }] }),
      () => ({ id, casts: [{ pose: 'peace', hand, feeds: [{ kind: 'well-palm', color: c1 }, { kind: 'lamp-tip', finger: 1, color: c2 }] }] }),
      () => ({ id, casts: [{ pose: rng.pick(['point', 'peace', 'rock'] as const), hand, feeds: [{ kind: 'well-palm', color: rng.pick(ANY_COLOR) }] }], decoyWells: [rng.pick(PRIMARY)] }),
    ];
    return rng.pick(recipes)();
  }
  // Tier 3: two casts. The source hand turns toward the other half so its ray has room.
  const side = hand === 'left' ? 1 : -1;
  const region: [number, number, number, number] = hand === 'left' ? [-0.17, 0, -0.03, 0.13] : [0, 0.17, -0.03, 0.13];
  const yaw: [number, number] = side > 0 ? [25, 66] : [-66, -25];
  const color = rng.pick(ANY_COLOR);
  const recipes: (() => CastSpec[])[] = [
    () => [
      { pose: rng.pick(['point', 'peace'] as const), hand, region, yaw, feeds: [{ kind: 'well-palm', color }] },
      { pose: rng.pick(['peace', 'rock', 'three'] as const), hand: other, feeds: [{ kind: 'relay-tip', finger: 1, slack: 60 }] },
    ],
    () => [
      { pose: 'blade', feeds: [{ kind: 'lamp-blade', color }] },
      { pose: 'peace', feeds: [{ kind: 'relay-tip', finger: 1, slack: 40 }] },
    ],
    () => [
      { pose: 'point', feeds: [{ kind: 'well-palm', color }] },
      { pose: 'blade', feeds: [{ kind: 'relay-blade', fromFinger: 1 }] },
    ],
  ];
  return { id, casts: rng.pick(recipes)(), maxHush: 4 };
}
