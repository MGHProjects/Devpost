/**
 * Studio editor model: the pure state behind the in-headset level editor
 * ("make a puzzle in 10 seconds by casting your hand").
 *
 * BoardEditor holds the level being made, the author's own glass hands (the
 * casts that prove it solvable), selection / hover for the UI and an
 * undo/redo history of whole-state snapshots. Every placement snaps (5 mm
 * positions, 5 deg lamp headings) and stays on the bench.
 *
 * CAST-FIRST authoring: the author casts a hand in the light, then
 * dropCrystals() puts a crystal of the right colour on every beam the casts
 * send off the bench, and suggestHush() guards the directions the author's
 * closed fingers (and gaps between their beams) would have lit, so a lazy
 * open hand at the same spot fails. sealCheck() is the publish gate.
 * Pure TS: no three.js, no DOM.
 */

import { computeOptic } from './hand-features.js';
import { FINGER_CHAINS, KNUCKLE, TIP } from './joints.js';
import { canonicalPose } from './pose-library.js';
import { CRYSTAL_R, HUSH_R, RAY_EPS, traceLevel } from './trace2d.js';
import type {
  BeamSeg, CastData, ColorMask, HandOptic, HandPose, LevelDef, Segment, TraceResult, V2,
} from './types.js';
import { DEG, pointSegDistSq, wrapAngle } from './vec2.js';

// ------------------------------------------------------------------ constants

export type ElementKind = 'lamp' | 'well' | 'crystal' | 'hush' | 'wall' | 'mirror';
export type PickKind = ElementKind | 'cast';

/** A picked thing: element kind (or an author cast) and its index. */
export interface Pick {
  kind: PickKind;
  i: number;
  /** Distance from the query point (m). */
  d: number;
}

export const EDITOR = {
  /** Position grid (m). */
  snap: 0.005,
  /** Lamp heading grid (rad). */
  angleSnap: 5 * DEG,
  /** Undo steps kept. */
  historyMax: 100,
  /** Max entries per element list (matches the share codec). */
  maxItems: 64,
  maxBudget: 6,
  minWellR: 0.015,
  maxWellR: 0.08,
  defaultWellR: 0.03,
  minSegment: 0.01,
  minBench: 0.2,
  maxBench: 1.0,
  maxName: 48,
  lampR: 0.008,
} as const;

/** Colour order for cycleColor(): R, G, B, Y, C, M, W. */
export const COLOR_CYCLE: readonly ColorMask[] = [1, 2, 4, 3, 6, 5, 7];

const SEGMENT_KINDS = ['wall', 'mirror'] as const;
const ALL_KINDS: readonly ElementKind[] = ['lamp', 'well', 'crystal', 'hush', 'wall', 'mirror'];

interface Snapshot {
  level: LevelDef;
  casts: HandPose[];
}

// ------------------------------------------------------------------ helpers

function snapV(v: number): number {
  return Math.round(v / EDITOR.snap) * EDITOR.snap + 0; // +0: no -0
}

/** Snaps a lamp heading to the 5 deg grid, wrapped to (-PI, PI]. */
export function snapAngle(a: number): number {
  const s = Math.round(a / EDITOR.angleSnap) * EDITOR.angleSnap;
  return wrapAngle(s) + 0;
}

function cloneLevel(l: LevelDef): LevelDef {
  return JSON.parse(JSON.stringify(l)) as LevelDef;
}

function copyPose(p: HandPose): HandPose {
  const out: HandPose = { hand: p.hand, pos: Float32Array.from(p.pos) };
  if (p.rot) out.rot = Float32Array.from(p.rot);
  if (p.radii) out.radii = Float32Array.from(p.radii);
  return out;
}

/** HandPose -> CastData (positions in mm ints, quaternions x 10000 ints with w >= 0). */
export function poseToCastData(pose: HandPose): CastData {
  const pos: number[] = Array.from(pose.pos, (v) => Math.round(v * 1000) + 0);
  const cast: CastData = { hand: pose.hand, pos };
  if (pose.rot && pose.rot.length >= 100) {
    const rot: number[] = new Array(100);
    for (let j = 0; j < 25; j++) {
      const s = pose.rot[j * 4 + 3] < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) rot[j * 4 + i] = Math.round(pose.rot[j * 4 + i] * s * 10000) + 0;
    }
    cast.rot = rot;
  }
  return cast;
}

/** CastData -> HandPose (metres, renormalized quaternions). */
export function castDataToPose(cast: CastData): HandPose {
  const pos = new Float32Array(75);
  for (let i = 0; i < 75; i++) pos[i] = (cast.pos[i] ?? 0) / 1000;
  const pose: HandPose = { hand: cast.hand, pos };
  if (cast.rot && cast.rot.length >= 100) {
    const rot = new Float32Array(100);
    for (let j = 0; j < 25; j++) {
      const o = j * 4;
      const l = Math.hypot(cast.rot[o], cast.rot[o + 1], cast.rot[o + 2], cast.rot[o + 3]);
      if (!(l > 1e-9)) rot[o + 3] = 1;
      else for (let i = 0; i < 4; i++) rot[o + i] = cast.rot[o + i] / l;
    }
    pose.rot = rot;
  }
  return pose;
}

/** Palm centre ((wrist + middle knuckle) / 2) of a pose on the bench. */
export function palmOf(pose: HandPose): V2 {
  const p = pose.pos;
  const k = KNUCKLE[2] * 3;
  return [(p[0] + p[k]) / 2, (p[2] + p[k + 2]) / 2];
}

/** Hand-axis heading (wrist -> middle knuckle), atan2(z, x). */
export function yawOf(pose: HandPose): number {
  const p = pose.pos;
  const k = KNUCKLE[2] * 3;
  return Math.atan2(p[k + 2] - p[2], p[k] - p[0]);
}

function freshId(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const b = new Uint8Array(6);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  let r = '';
  for (const x of b) r += x.toString(16).padStart(2, '0');
  return `studio-${Date.now().toString(36)}-${r}`;
}

function segLen(s: Segment): number {
  return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
}

// ------------------------------------------------------------------ editor

export class BoardEditor {
  private _level: LevelDef;
  private _casts: HandPose[];
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private depth = 0;
  private groupMarked = false;

  /** Picked element (fingertip pinch) and the element under the fingertip, for the UI. */
  selected: Pick | null = null;
  hovered: Pick | null = null;
  /** Bumped on every change (render diffing). */
  version = 0;
  /** Called after every change, undo and redo. */
  onChange?: () => void;

  constructor(base?: Partial<LevelDef>) {
    const b = base ? cloneLevel({ ...emptyLevel(), ...base } as LevelDef) : emptyLevel();
    this._level = {
      v: 1,
      id: b.id ?? '',
      name: b.name ?? 'Untitled',
      bench: b.bench ?? { w: 0.44, d: 0.3 },
      budget: b.budget ?? 1,
      lamps: b.lamps ?? [],
      wells: b.wells ?? [],
      crystals: b.crystals ?? [],
      hush: b.hush ?? [],
      walls: b.walls ?? [],
      mirrors: b.mirrors ?? [],
    };
    if (b.inks) this._level.inks = b.inks;
    if (b.hint) this._level.hint = b.hint;
    if (b.author) this._level.author = b.author;
    if (b.chapter !== undefined) this._level.chapter = b.chapter;
    if (b.index !== undefined) this._level.index = b.index;
    this._casts = (b.solution ?? []).map(castDataToPose);
  }

  /** The level being edited (no solution attached; see toLevel()). Treat as read-only. */
  get level(): LevelDef {
    return this._level;
  }

  /** The author's glass hands. Treat as read-only. */
  get casts(): readonly HandPose[] {
    return this._casts;
  }

  // ---------------------------------------------------------------- history

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  /**
   * Groups every change until the matching end() into one undo step (e.g. a
   * fingertip drag). Nestable. A group that changed nothing leaves no step.
   */
  begin(): void {
    if (this.depth++ === 0) this.groupMarked = false;
  }

  end(): void {
    if (this.depth === 0) return;
    if (--this.depth === 0 && this.groupMarked) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && this.sameAs(top)) this.undoStack.pop();
      this.groupMarked = false;
    }
  }

  /** Runs fn as one undo step. */
  transact<T>(fn: () => T): T {
    this.begin();
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  private snapshot(): Snapshot {
    return { level: cloneLevel(this._level), casts: this._casts.slice() };
  }

  private sameAs(s: Snapshot): boolean {
    if (s.casts.length !== this._casts.length || s.casts.some((c, i) => c !== this._casts[i])) return false;
    return JSON.stringify(s.level) === JSON.stringify(this._level);
  }

  private restore(s: Snapshot): void {
    this._level = s.level;
    this._casts = s.casts;
    this.selected = null;
    this.hovered = null;
    this.changed();
  }

  /** Records an undo point before a mutation. */
  private willChange(): void {
    this.redoStack.length = 0;
    if (this.depth > 0) {
      if (this.groupMarked) return;
      this.groupMarked = true;
    }
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > EDITOR.historyMax) this.undoStack.shift();
  }

  private changed(): void {
    this.version++;
    this.onChange?.();
  }

  private mutate<T>(fn: () => T): T {
    this.willChange();
    const r = fn();
    this.changed();
    return r;
  }

  // ---------------------------------------------------------------- geometry

  /** Clamps a point into the bench, `margin` metres inside the edge. */
  clampToBench(p: V2, margin = 0): V2 {
    const hw = Math.max(0, this._level.bench.w / 2 - margin);
    const hd = Math.max(0, this._level.bench.d / 2 - margin);
    return [Math.min(hw, Math.max(-hw, p[0])) + 0, Math.min(hd, Math.max(-hd, p[1])) + 0];
  }

  /** Snaps to the 5 mm grid and keeps the point `margin` inside the bench (on grid). */
  snapPoint(p: V2, margin = 0): V2 {
    const hw = Math.floor((this._level.bench.w / 2 - margin) / EDITOR.snap + 1e-9) * EDITOR.snap;
    const hd = Math.floor((this._level.bench.d / 2 - margin) / EDITOR.snap + 1e-9) * EDITOR.snap;
    const x = Math.min(hw, Math.max(-hw, snapV(p[0])));
    const z = Math.min(hd, Math.max(-hd, snapV(p[1])));
    return [x + 0, z + 0];
  }

  private margin(kind: ElementKind): number {
    switch (kind) {
      case 'lamp': return EDITOR.lampR;
      case 'crystal': return CRYSTAL_R;
      case 'hush': return HUSH_R;
      default: return 0;
    }
  }

  private count(kind: ElementKind): number {
    return this.list(kind).length;
  }

  private list(kind: ElementKind): unknown[] {
    const l = this._level;
    switch (kind) {
      case 'lamp': return l.lamps;
      case 'well': return l.wells;
      case 'crystal': return l.crystals;
      case 'hush': return l.hush;
      case 'wall': return l.walls;
      case 'mirror': return l.mirrors;
    }
  }

  // ---------------------------------------------------------------- elements
  // add* return the new index, or -1 when the list is full / the shape degenerate.

  addLamp(p: V2, a: number, color: ColorMask = 7): number {
    if (this.count('lamp') >= EDITOR.maxItems) return -1;
    return this.mutate(() => this._level.lamps.push({ p: this.snapPoint(p, EDITOR.lampR), a: snapAngle(a), color: color & 7 || 7 }) - 1);
  }

  addWell(p: V2, r: number = EDITOR.defaultWellR, color: ColorMask = 7): number {
    if (this.count('well') >= EDITOR.maxItems) return -1;
    return this.mutate(() => this._level.wells.push({ p: this.snapPoint(p), r: snapWellR(r), color: color & 7 || 7 }) - 1);
  }

  addCrystal(p: V2, color: ColorMask = 7): number {
    if (this.count('crystal') >= EDITOR.maxItems) return -1;
    return this.mutate(() => this._level.crystals.push({ p: this.snapPoint(p, CRYSTAL_R), color: color & 7 || 7 }) - 1);
  }

  addHush(p: V2): number {
    if (this.count('hush') >= EDITOR.maxItems) return -1;
    return this.mutate(() => this._level.hush.push({ p: this.snapPoint(p, HUSH_R) }) - 1);
  }

  addWall(a: V2, b: V2): number {
    return this.addSegment('wall', a, b);
  }

  addMirror(a: V2, b: V2): number {
    return this.addSegment('mirror', a, b);
  }

  private addSegment(kind: 'wall' | 'mirror', a: V2, b: V2): number {
    const s: Segment = { a: this.snapPoint(a), b: this.snapPoint(b) };
    if (segLen(s) < EDITOR.minSegment || this.count(kind) >= EDITOR.maxItems) return -1;
    const list = kind === 'wall' ? this._level.walls : this._level.mirrors;
    return this.mutate(() => list.push(s) - 1);
  }

  /**
   * Moves an element (segments: their midpoint; casts: their palm centre,
   * translating the whole hand) to `p`, snapped. Returns false for a bad index.
   */
  move(kind: PickKind, i: number, p: V2): boolean {
    if (kind === 'cast') {
      const pose = this._casts[i];
      if (!pose) return false;
      const c = palmOf(pose);
      const to = this.snapPoint(p);
      const dx = to[0] - c[0];
      const dz = to[1] - c[1];
      if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return true;
      return this.mutate(() => {
        const moved = copyPose(pose);
        for (let j = 0; j < 25; j++) {
          moved.pos[j * 3] += dx;
          moved.pos[j * 3 + 2] += dz;
        }
        this._casts[i] = moved;
        return true;
      });
    }
    const item = this.list(kind)[i] as { p?: V2; a?: V2; b?: V2 } | undefined;
    if (!item) return false;
    if (kind === 'wall' || kind === 'mirror') {
      const s = item as Segment;
      const mid: V2 = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
      const to = this.snapPoint(p);
      // Keep the whole segment on the bench.
      const hw = this._level.bench.w / 2;
      const hd = this._level.bench.d / 2;
      const onGrid = (v: number, lo: number, hi: number): number => {
        const g = EDITOR.snap;
        return Math.min(Math.floor(hi / g + 1e-9) * g, Math.max(Math.ceil(lo / g - 1e-9) * g, snapV(v))) + 0;
      };
      const dx = onGrid(to[0] - mid[0], -hw - Math.min(s.a[0], s.b[0]), hw - Math.max(s.a[0], s.b[0]));
      const dz = onGrid(to[1] - mid[1], -hd - Math.min(s.a[1], s.b[1]), hd - Math.max(s.a[1], s.b[1]));
      return this.mutate(() => {
        s.a = this.snapPoint([s.a[0] + dx, s.a[1] + dz]);
        s.b = this.snapPoint([s.b[0] + dx, s.b[1] + dz]);
        return true;
      });
    }
    const pt = item as { p: V2 };
    const to = this.snapPoint(p, this.margin(kind));
    return this.mutate(() => {
      pt.p = to;
      return true;
    });
  }

  /** Moves one end (0 = a, 1 = b) of a wall or mirror. Refuses degenerate segments. */
  moveEndpoint(kind: 'wall' | 'mirror', i: number, end: 0 | 1, p: V2): boolean {
    const s = (kind === 'wall' ? this._level.walls : this._level.mirrors)[i];
    if (!s) return false;
    const q = this.snapPoint(p);
    const other = end === 0 ? s.b : s.a;
    if (Math.hypot(q[0] - other[0], q[1] - other[1]) < EDITOR.minSegment) return false;
    return this.mutate(() => {
      if (end === 0) s.a = q;
      else s.b = q;
      return true;
    });
  }

  /** Turns a lamp by `delta` radians; the result snaps to 5 deg. */
  rotateLamp(i: number, delta: number): boolean {
    const lamp = this._level.lamps[i];
    if (!lamp) return false;
    return this.mutate(() => {
      lamp.a = snapAngle(lamp.a + delta);
      return true;
    });
  }

  /** Sets a lamp heading (snapped). */
  setLampAngle(i: number, a: number): boolean {
    const lamp = this._level.lamps[i];
    if (!lamp) return false;
    return this.mutate(() => {
      lamp.a = snapAngle(a);
      return true;
    });
  }

  /** Resizes a well (snapped, clamped to the allowed range). */
  setWellRadius(i: number, r: number): boolean {
    const w = this._level.wells[i];
    if (!w) return false;
    return this.mutate(() => {
      w.r = snapWellR(r);
      return true;
    });
  }

  /** Advances a lamp / well / crystal colour along COLOR_CYCLE. Returns the new colour (0 if n/a). */
  cycleColor(kind: ElementKind, i: number): ColorMask {
    if (kind !== 'lamp' && kind !== 'well' && kind !== 'crystal') return 0;
    const item = this.list(kind)[i] as { color: ColorMask } | undefined;
    if (!item) return 0;
    const k = COLOR_CYCLE.indexOf(item.color);
    const next = COLOR_CYCLE[(k + 1) % COLOR_CYCLE.length];
    return this.mutate(() => (item.color = next));
  }

  /** Sets an element's colour directly. */
  setColor(kind: ElementKind, i: number, color: ColorMask): boolean {
    if (kind !== 'lamp' && kind !== 'well' && kind !== 'crystal') return false;
    const item = this.list(kind)[i] as { color: ColorMask } | undefined;
    if (!item || !(color & 7)) return false;
    return this.mutate(() => {
      item.color = color & 7;
      return true;
    });
  }

  remove(kind: PickKind, i: number): boolean {
    const list = kind === 'cast' ? this._casts : this.list(kind);
    if (i < 0 || i >= list.length) return false;
    return this.mutate(() => {
      list.splice(i, 1);
      this.selected = shiftPick(this.selected, kind, i);
      this.hovered = shiftPick(this.hovered, kind, i);
      return true;
    });
  }

  /** Removes everything (elements and casts), keeping bench and budget. */
  clear(): void {
    this.mutate(() => {
      const l = this._level;
      l.lamps = [];
      l.wells = [];
      l.crystals = [];
      l.hush = [];
      l.walls = [];
      l.mirrors = [];
      delete l.inks;
      this._casts = [];
      this.selected = null;
      this.hovered = null;
    });
  }

  /**
   * The nearest element of `kind` ('any' = every kind including casts) within
   * `maxDist` of a fingertip point. Wells count from their rim, segments from
   * the line, casts from the palm centre.
   */
  nearest(kind: PickKind | 'any', point: V2, maxDist = 0.03): Pick | null {
    let best: Pick | null = null;
    const consider = (k: PickKind, i: number, d: number): void => {
      if (d <= maxDist && (!best || d < best.d)) best = { kind: k, i, d };
    };
    const kinds: PickKind[] = kind === 'any' ? [...ALL_KINDS, 'cast'] : [kind];
    const [x, z] = point;
    const l = this._level;
    for (const k of kinds) {
      switch (k) {
        case 'lamp':
        case 'crystal':
        case 'hush': {
          const arr = (k === 'lamp' ? l.lamps : k === 'crystal' ? l.crystals : l.hush) as { p: V2 }[];
          arr.forEach((e, i) => consider(k, i, Math.hypot(e.p[0] - x, e.p[1] - z)));
          break;
        }
        case 'well':
          l.wells.forEach((w, i) => consider(k, i, Math.max(0, Math.hypot(w.p[0] - x, w.p[1] - z) - w.r)));
          break;
        case 'wall':
        case 'mirror':
          (k === 'wall' ? l.walls : l.mirrors).forEach((s, i) =>
            consider(k, i, Math.sqrt(pointSegDistSq(x, z, s.a[0], s.a[1], s.b[0], s.b[1]))));
          break;
        case 'cast':
          this._casts.forEach((c, i) => {
            const p = palmOf(c);
            consider(k, i, Math.hypot(p[0] - x, p[1] - z));
          });
          break;
      }
    }
    return best;
  }

  select(pick: Pick | null): void {
    this.selected = pick;
  }

  hover(pick: Pick | null): void {
    this.hovered = pick;
  }

  // ---------------------------------------------------------------- casts

  /** Adds an author glass hand (copied). Returns its index, or -1 at the hard cap. */
  addCast(pose: HandPose): number {
    if (this._casts.length >= EDITOR.maxBudget) return -1;
    const c = copyPose(pose);
    return this.mutate(() => {
      this._casts.push(c);
      // A board always allows at least as many hands as its author used.
      if (this._level.budget < this._casts.length) this._level.budget = this._casts.length;
      return this._casts.length - 1;
    });
  }

  removeCast(i: number): boolean {
    return this.remove('cast', i);
  }

  /** Sets the cast budget (integer, 1..maxBudget). */
  setBudget(n: number): void {
    const b = Math.max(1, Math.min(EDITOR.maxBudget, Math.round(n)));
    if (b === this._level.budget) return;
    this.mutate(() => (this._level.budget = b));
  }

  setName(name: string): void {
    const n = cleanName(name);
    if (n === this._level.name) return;
    this.mutate(() => (this._level.name = n));
  }

  // ---------------------------------------------------------------- optics

  /** Glass-hand optics of the author's casts (ids 'cast-<i>'). */
  optics(): HandOptic[] {
    return this._casts.map((c, i) => computeOptic(c, { id: `cast-${i}`, live: false }));
  }

  /** Traces the level with the author's casts (no aim assist by default). */
  trace(assist = 0): TraceResult {
    return traceLevel(this._level, this.optics(), { assist });
  }

  // ---------------------------------------------------------------- serialization

  /** A publishable LevelDef: fresh id, author handle, the casts as solution CastData. */
  toLevel(name: string, authorHandle: string, id: string = freshId()): LevelDef {
    const l = cloneLevel(this._level);
    l.id = id;
    l.name = cleanName(name);
    const author = authorHandle.trim().slice(0, EDITOR.maxName);
    if (author) l.author = author;
    else delete l.author;
    l.solution = this._casts.map(poseToCastData);
    return l;
  }
}

function emptyLevel(): LevelDef {
  return {
    v: 1, id: '', name: 'Untitled', bench: { w: 0.44, d: 0.3 }, budget: 1,
    lamps: [], wells: [], crystals: [], hush: [], walls: [], mirrors: [],
  };
}

function snapWellR(r: number): number {
  return Math.min(EDITOR.maxWellR, Math.max(EDITOR.minWellR, snapV(r)));
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, EDITOR.maxName) || 'Untitled';
}

function shiftPick(p: Pick | null, kind: PickKind, i: number): Pick | null {
  if (!p || p.kind !== kind) return p;
  if (p.i === i) return null;
  return p.i > i ? { ...p, i: p.i - 1 } : p;
}

// ------------------------------------------------------------------ beams

/** A beam emitted by a cast: its polyline through any mirrors and where it ends. */
export interface CastBeam {
  cast: number;
  finger: number;
  color: ColorMask;
  points: V2[];
  length: number;
  /** 'edge' = leaves the bench, 'wall' = absorbed by a wall, 'other' = crystal / hush / hand. */
  end: 'edge' | 'wall' | 'other';
}

/** Recovers each cast finger's beam from a trace (the tracer does not tag segments by emitter). */
export function castBeams(level: LevelDef, optics: HandOptic[], tr: TraceResult): CastBeam[] {
  const segs = tr.segments;
  const beams: CastBeam[] = [];
  const hw = level.bench.w / 2;
  const hd = level.bench.d / 2;
  optics.forEach((o, h) => {
    const io = tr.hands[h];
    if (!io) return;
    for (let f = 0; f < 5; f++) {
      const color = io.outMask[f];
      if (!color) continue;
      const port = o.ports[f];
      const sx = port.p[0] + port.dir[0] * RAY_EPS;
      const sz = port.p[1] + port.dir[1] * RAY_EPS;
      let k = segs.findIndex((s) => s.color === color && Math.hypot(s.a[0] - sx, s.a[1] - sz) < 1e-6);
      if (k < 0) continue;
      const chain: BeamSeg[] = [segs[k]];
      while (k + 1 < segs.length) {
        const prev = segs[k];
        const next = segs[k + 1];
        if (next.color !== color || Math.hypot(next.a[0] - prev.b[0], next.a[1] - prev.b[1]) > 1e-3) break;
        chain.push(next);
        k++;
      }
      const points: V2[] = [[chain[0].a[0], chain[0].a[1]]];
      let length = 0;
      for (const s of chain) {
        points.push([s.b[0], s.b[1]]);
        length += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      }
      const b = points[points.length - 1];
      let end: CastBeam['end'] = 'other';
      if (Math.abs(b[0]) >= hw - 1e-6 || Math.abs(b[1]) >= hd - 1e-6) end = 'edge';
      else if (level.walls.some((w) => pointSegDistSq(b[0], b[1], w.a[0], w.a[1], w.b[0], w.b[1]) < 1e-8)) end = 'wall';
      beams.push({ cast: h, finger: f, color, points, length, end });
    }
  });
  return beams;
}

function pointAlong(points: V2[], d: number): V2 {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= l || i + 2 === points.length) {
      const t = l > 0 ? Math.min(1, d / l) : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    d -= l;
  }
  return points[points.length - 1];
}

/**
 * Whether a new round target of radius `r` at p keeps clear of everything on
 * the board: `spacing` from crystals / hush / lamps, outside wells, off walls,
 * mirrors and the casts' bodies.
 */
function clearSpot(ed: BoardEditor, optics: HandOptic[], p: V2, r: number, spacing: number): boolean {
  const l = ed.level;
  const far = (q: V2, d: number): boolean => Math.hypot(q[0] - p[0], q[1] - p[1]) >= d - 1e-9;
  if (!l.crystals.every((c) => far(c.p, spacing))) return false;
  if (!l.hush.every((c) => far(c.p, spacing))) return false;
  if (!l.lamps.every((c) => far(c.p, spacing))) return false;
  if (!l.wells.every((w) => far(w.p, w.r + r))) return false;
  const segClear = (s: Segment): boolean => pointSegDistSq(p[0], p[1], s.a[0], s.a[1], s.b[0], s.b[1]) >= (r + 0.004) ** 2;
  if (!l.walls.every(segClear) || !l.mirrors.every(segClear)) return false;
  for (const o of optics) {
    for (const c of o.body) {
      if (pointSegDistSq(p[0], p[1], c.a[0], c.a[1], c.b[0], c.b[1]) < (c.r + r + 0.003) ** 2) return false;
    }
    if (o.mirror && pointSegDistSq(p[0], p[1], o.mirror.a[0], o.mirror.a[1], o.mirror.b[0], o.mirror.b[1]) < (r + 0.004) ** 2) return false;
    if (Math.hypot(o.center[0] - p[0], o.center[1] - p[1]) < 0.03 + r) return false;
  }
  return true;
}

function litSet(tr: TraceResult): boolean[] {
  return tr.crystals.map((c) => c.state === 'lit');
}

function awakeCount(tr: TraceResult): number {
  return tr.hush.filter((h) => h.awake).length;
}

// ------------------------------------------------------------------ cast-first

export interface DropOptions {
  /** Preferred distance from the emitting port along the beam (m, default 0.16). */
  reach?: number;
  /** Minimum distance kept before the beam's end (m, default 0.025). */
  backoff?: number;
  /** Minimum spacing between targets (m, default 0.03). */
  spacing?: number;
  /** Never closer than this to the emitting port (m, default 0.04). */
  minDist?: number;
  /** Max crystals placed in one call (default 12). */
  max?: number;
}

/**
 * Places a crystal of the right colour on every beam that leaves an author
 * cast and runs off the bench or into a wall, at min(reach, end - backoff)
 * along the beam (stepping back toward the port when that spot is crowded).
 * One undo step. Returns the indices of the crystals added.
 */
export function dropCrystals(editor: BoardEditor, opts: DropOptions = {}): number[] {
  const reach = opts.reach ?? 0.16;
  const backoff = opts.backoff ?? 0.025;
  const spacing = opts.spacing ?? 0.03;
  const minDist = opts.minDist ?? 0.04;
  const max = opts.max ?? 12;
  const added: number[] = [];
  const skip = new Set<string>();
  editor.transact(() => {
    while (added.length < max && editor.level.crystals.length < EDITOR.maxItems) {
      const optics = editor.optics();
      const tr = traceLevel(editor.level, optics, { assist: 0 });
      const before = litSet(tr);
      const awake = awakeCount(tr);
      const beams = castBeams(editor.level, optics, tr).filter((b) => b.end !== 'other' && !skip.has(`${b.cast}:${b.finger}`));
      if (!beams.length) break;
      let placed = -1;
      for (const beam of beams) {
        const start = Math.min(reach, beam.length - backoff);
        for (let d = start; d >= minDist - 1e-9 && placed < 0; d -= 0.01) {
          const p = editor.snapPoint(pointAlong(beam.points, d), CRYSTAL_R + 0.002);
          if (!clearSpot(editor, optics, p, CRYSTAL_R, spacing)) continue;
          const i = editor.addCrystal(p, beam.color);
          if (i < 0) break;
          const after = traceLevel(editor.level, optics, { assist: 0 });
          const ok = after.crystals[i].state === 'lit' &&
            before.every((lit, j) => !lit || after.crystals[j].state === 'lit') &&
            awakeCount(after) <= awake;
          if (ok) placed = i;
          else editor.remove('crystal', i);
        }
        if (placed >= 0) break;
        skip.add(`${beam.cast}:${beam.finger}`);
      }
      if (placed < 0) break;
      added.push(placed);
    }
  });
  return added;
}

export interface HushOptions {
  /** Distance of a guard stone past the would-be fingertip (m, default 0.12). */
  reach?: number;
  /** Lit beams of one cast further apart than this get a stone in the gap (rad, default 25 deg). */
  gap?: number;
  /** Minimum spacing between targets (m, default 0.03). */
  spacing?: number;
  /** Clearance kept from every existing beam (m, default 0.006 beyond the stone). */
  clearance?: number;
}

/** Bench-plane direction a closed finger would point if it were extended, and where its tip would be. */
function wouldBeRay(pose: HandPose, f: number): { p: V2; dir: V2 } | null {
  const P = pose.pos;
  const chain = FINGER_CHAINS[f];
  const k = KNUCKLE[f];
  const kx = P[k * 3];
  const kz = P[k * 3 + 2];
  let dx = 0;
  let dz = 0;
  if (f > 0) {
    // Proximal phalanx heading (keeps the finger's spread) unless it points straight down.
    const n = chain[2];
    const ex = P[n * 3] - kx;
    const ey = P[n * 3 + 1] - P[k * 3 + 1];
    const ez = P[n * 3 + 2] - kz;
    const l3 = Math.hypot(ex, ey, ez);
    if (l3 > 1e-6 && Math.hypot(ex, ez) / l3 > 0.05) {
      dx = ex;
      dz = ez;
    }
  }
  if (dx === 0 && dz === 0) {
    const m = chain[0];
    dx = kx - P[m * 3];
    dz = kz - P[m * 3 + 2];
  }
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) return null;
  dx /= l;
  dz /= l;
  // Length of the finger from its knuckle to the tip.
  let len = 0;
  for (let i = chain.indexOf(k); i < chain.length - 1; i++) {
    const a = chain[i] * 3;
    const b = chain[i + 1] * 3;
    len += Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
  }
  len += 0.006;
  return { p: [kx + dx * len, kz + dz * len], dir: [dx, dz] };
}

/**
 * Places hush stones where a lazier hand would spill light: along the
 * would-be directions of each lit cast's closed fingers, and in angular gaps
 * wider than `gap` between one cast's lit beams. Stones never touch an
 * existing beam and never break the solve. One undo step. Returns the
 * indices of the stones added.
 */
export function suggestHush(editor: BoardEditor, opts: HushOptions = {}): number[] {
  const reach = opts.reach ?? 0.12;
  const gap = opts.gap ?? 25 * DEG;
  const spacing = opts.spacing ?? 0.03;
  const clearance = opts.clearance ?? 0.006;
  const added: number[] = [];
  editor.transact(() => {
    const optics = editor.optics();
    const tr0 = traceLevel(editor.level, optics, { assist: 0 });
    const rays: { p: V2; dir: V2 }[] = [];
    optics.forEach((o, h) => {
      const io = tr0.hands[h];
      if (o.mode !== 'fan' || !io || !io.carried) return;
      const pose = editor.casts[h];
      for (let f = 0; f < 5; f++) {
        if (o.ports[f].open) continue;
        const r = wouldBeRay(pose, f);
        if (r) rays.push(r);
      }
      const axis = yawOf(pose);
      const lit = [0, 1, 2, 3, 4]
        .filter((f) => io.outMask[f] !== 0)
        .map((f) => ({ port: o.ports[f], rel: wrapAngle(Math.atan2(o.ports[f].dir[1], o.ports[f].dir[0]) - axis) }))
        .sort((a, b) => a.rel - b.rel);
      for (let i = 0; i + 1 < lit.length; i++) {
        const A = lit[i];
        const B = lit[i + 1];
        if (B.rel - A.rel <= gap) continue;
        const mid = axis + (A.rel + B.rel) / 2;
        rays.push({
          p: [(A.port.p[0] + B.port.p[0]) / 2, (A.port.p[1] + B.port.p[1]) / 2],
          dir: [Math.cos(mid), Math.sin(mid)],
        });
      }
    });

    const ds = [0, -0.02, 0.02, -0.04, -0.06, 0.04, -0.08].map((x) => reach + x).filter((d) => d >= 0.03);
    for (const ray of rays) {
      if (editor.level.hush.length >= EDITOR.maxItems) break;
      for (const d of ds) {
        const raw: V2 = [ray.p[0] + ray.dir[0] * d, ray.p[1] + ray.dir[1] * d];
        const p = editor.snapPoint(raw, HUSH_R + 0.004);
        if (Math.hypot(p[0] - raw[0], p[1] - raw[1]) > 0.004) continue; // clamped: not on the ray
        if (!clearSpot(editor, optics, p, HUSH_R, spacing)) continue;
        const before = traceLevel(editor.level, optics, { assist: 0 });
        const minD2 = (HUSH_R + clearance) ** 2;
        if (before.segments.some((s) => pointSegDistSq(p[0], p[1], s.a[0], s.a[1], s.b[0], s.b[1]) < minD2)) continue;
        const lit = litSet(before);
        const i = editor.addHush(p);
        if (i < 0) break;
        const after = traceLevel(editor.level, optics, { assist: 0 });
        if (!after.hush[i].awake && lit.every((l, j) => !l || after.crystals[j].state === 'lit') && awakeCount(after) <= awakeCount(before)) {
          added.push(i);
          break;
        }
        editor.remove('hush', i);
      }
    }
  });
  return added;
}

// ------------------------------------------------------------------ seal

export interface SealResult {
  /** True when the board can be published. */
  ok: boolean;
  /** Blocking problems. */
  reasons: string[];
  /** Non-blocking warnings (e.g. a lazy open hand also solves it). */
  warnings: string[];
}

/**
 * Publish gate: solved by the author's casts within budget, not solved with
 * no hands, at least one crystal, everything on the bench and within size
 * limits. A 'spread' or 'flat' hand placed where an author cast is that also
 * solves the board only warns.
 */
export function sealCheck(editor: BoardEditor): SealResult {
  const l = editor.level;
  const casts = editor.casts;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const hw = l.bench.w / 2 + 1e-6;
  const hd = l.bench.d / 2 + 1e-6;
  const on = (p: V2): boolean => Math.abs(p[0]) <= hw && Math.abs(p[1]) <= hd;

  // Sizes.
  if (!(l.bench.w >= EDITOR.minBench && l.bench.w <= EDITOR.maxBench && l.bench.d >= EDITOR.minBench && l.bench.d <= EDITOR.maxBench)) {
    reasons.push('bench size out of range');
  }
  if (!(Number.isInteger(l.budget) && l.budget >= 1 && l.budget <= EDITOR.maxBudget)) reasons.push(`budget must be 1..${EDITOR.maxBudget}`);
  for (const k of ALL_KINDS) {
    const n = (k === 'lamp' ? l.lamps : k === 'well' ? l.wells : k === 'crystal' ? l.crystals : k === 'hush' ? l.hush : k === 'wall' ? l.walls : l.mirrors).length;
    if (n > EDITOR.maxItems) reasons.push(`too many ${k}s (${n} > ${EDITOR.maxItems})`);
  }
  l.wells.forEach((w, i) => {
    if (!(w.r >= EDITOR.minWellR - 1e-9 && w.r <= EDITOR.maxWellR + 1e-9)) reasons.push(`well ${i}: radius out of range`);
  });
  for (const k of SEGMENT_KINDS) {
    (k === 'wall' ? l.walls : l.mirrors).forEach((s, i) => {
      if (segLen(s) < EDITOR.minSegment - 1e-9) reasons.push(`${k} ${i}: too short`);
    });
  }
  if (!l.crystals.length) reasons.push('needs at least one crystal');
  for (const c of l.crystals) if (!(c.color >= 1 && c.color <= 7)) { reasons.push('crystal colour invalid'); break; }

  // On the bench.
  const off: string[] = [];
  l.lamps.forEach((e, i) => !on(e.p) && off.push(`lamp ${i}`));
  l.wells.forEach((e, i) => !on(e.p) && off.push(`well ${i}`));
  l.crystals.forEach((e, i) => !on(e.p) && off.push(`crystal ${i}`));
  l.hush.forEach((e, i) => !on(e.p) && off.push(`hush ${i}`));
  l.walls.forEach((s, i) => (!on(s.a) || !on(s.b)) && off.push(`wall ${i}`));
  l.mirrors.forEach((s, i) => (!on(s.a) || !on(s.b)) && off.push(`mirror ${i}`));
  casts.forEach((c, i) => {
    if (!on(palmOf(c)) || TIP.some((t) => !on([c.pos[t * 3], c.pos[t * 3 + 2]]))) off.push(`cast ${i}`);
  });
  if (off.length) reasons.push(`off the bench: ${off.join(', ')}`);

  // Solvability.
  if (!casts.length) reasons.push('cast your solution first');
  else if (casts.length > l.budget) reasons.push(`solution uses ${casts.length} hands, budget is ${l.budget}`);
  if (casts.length && l.crystals.length) {
    const tr = editor.trace(0);
    if (!tr.solved) {
      const dark = tr.crystals.filter((c) => c.state !== 'lit').length;
      const awake = tr.hush.filter((h) => h.awake).length;
      reasons.push(`your hands do not solve it (${dark} crystal${dark === 1 ? '' : 's'} unlit, ${awake} hush awake)`);
    }
  }
  if (l.crystals.length && traceLevel(l, [], { assist: 0 }).solved) reasons.push('already solved with no hands');

  // Anti-trivial (warn only): an open hand at each author cast's spot.
  if (casts.length && l.crystals.length) {
    for (const name of ['spread', 'flat'] as const) {
      const lazy = casts.map((c) => canonicalPose(name, c.hand, palmOf(c), yawOf(c)));
      const variants: HandPose[][] = casts.map((_, i) => casts.map((c, j) => (j === i ? lazy[j] : c)));
      if (casts.length > 1) variants.push(lazy);
      const solves = variants.some((v) =>
        traceLevel(l, v.map((p, i) => computeOptic(p, { id: `cast-${i}`, live: false })), { assist: 0 }).solved);
      if (solves) warnings.push(`a '${name}' hand where you cast also solves it`);
    }
  }
  return { ok: reasons.length === 0, reasons, warnings };
}
