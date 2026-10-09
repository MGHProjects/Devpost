import { describe, expect, it } from 'vitest';
import { computeOptic } from '../src/core/hand-features.js';
import { traceLevel } from '../src/core/trace2d.js';
import { Color } from '../src/core/types.js';
import { convexHull, pointSegDistSq, rayCapsule, rayCircle, rayConvexPolygon, raySegment, signedArea } from '../src/core/vec2.js';
import type { BeamSeg, FingerTints, Handedness, HandOptic, HandPose, Lamp, LevelDef, Port, TraceResult, V2 } from '../src/core/types.js';

// ------------------------------------------------------------ synthetic hand
// Canonical frame: right hand palm down, wrist at the origin, fingers along -Z,
// thumb toward -X. Left = mirror image. (Kept local so tests don't depend on fk-hand.)

interface HandSpec {
  hand?: Handedness;
  /** Per-finger curl at the PIP and DIP joints (thumb: IP joints), bending toward the palm. */
  curl?: number[];
  /** Per-finger MCP (knuckle) flexion (rad). */
  mcp?: number[];
  /** Yaw between adjacent long fingers (rad). */
  spread?: number;
  /** Extra per-finger pitch at the knuckle (rad, positive = down). */
  pitch?: number[];
  /** Whole-hand pitch (rad, positive = fingers down). */
  handPitch?: number;
  /** Roll about the hand axis (rad); PI/2 stands the hand on its pinky edge. */
  roll?: number;
  /** Heading of the hand axis in the light sheet (atan2(z, x)); default -PI/2 (forward). */
  heading?: number;
  /** Wrist position in bench space. */
  at?: [number, number, number];
}

const META: number[][] = [
  [-0.022, -0.012, -0.025],
  [-0.012, 0, -0.02],
  [-0.002, 0, -0.02],
  [0.009, 0, -0.02],
  [0.018, 0, -0.018],
];
const KNUCK: number[][] = [
  [0, 0, 0], // thumb: computed
  [-0.024, 0, -0.084],
  [-0.004, 0, -0.088],
  [0.015, 0, -0.083],
  [0.032, 0, -0.074],
];
const PHAL: number[][] = [
  [0.04, 0.032, 0.025], // thumb: metacarpal bone, proximal, distal
  [0.04, 0.024, 0.02],
  [0.044, 0.028, 0.022],
  [0.041, 0.027, 0.021],
  [0.032, 0.019, 0.019],
];

function fdir(yaw: number, pitch: number): number[] {
  return [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}
function add(p: number[], d: number[], l: number): number[] {
  return [p[0] + d[0] * l, p[1] + d[1] * l, p[2] + d[2] * l];
}

function makeHand(spec: HandSpec = {}): HandPose {
  const curl = spec.curl ?? [0, 0, 0, 0, 0];
  const spread = spec.spread ?? 0.17;
  const pitch = spec.pitch ?? [0, 0, 0, 0, 0];
  const mcp = spec.mcp ?? [0, 0, 0, 0, 0];
  const J: number[][] = new Array(25);
  J[0] = [0, 0, 0];
  // Thumb.
  const ty = -0.8;
  J[1] = META[0];
  J[2] = add(J[1], fdir(ty, pitch[0]), PHAL[0][0]);
  J[3] = add(J[2], fdir(ty, pitch[0] + curl[0]), PHAL[0][1]);
  J[4] = add(J[3], fdir(ty, pitch[0] + 2 * curl[0]), PHAL[0][2]);
  for (let f = 1; f < 5; f++) {
    const base = 5 * f;
    const yaw = (f - 2) * spread;
    J[base] = META[f];
    J[base + 1] = KNUCK[f];
    let p = pitch[f] + mcp[f];
    let q = KNUCK[f];
    for (let k = 0; k < 3; k++) {
      q = add(q, fdir(yaw, p), PHAL[f][k]);
      p += curl[f];
      J[base + 2 + k] = q;
    }
  }
  const hp = -(spec.handPitch ?? 0);
  const roll = -(spec.roll ?? 0);
  const delta = (spec.heading ?? -Math.PI / 2) + Math.PI / 2;
  const at = spec.at ?? [0, 0.03, 0];
  const pos: number[] = [];
  for (const j of J) {
    let [x, y, z] = j;
    // Pitch about X.
    [y, z] = [y * Math.cos(hp) - z * Math.sin(hp), y * Math.sin(hp) + z * Math.cos(hp)];
    // Roll about Z.
    [x, y] = [x * Math.cos(roll) - y * Math.sin(roll), x * Math.sin(roll) + y * Math.cos(roll)];
    if (spec.hand === 'left') x = -x;
    // Heading: rotation in the (x, z) plane.
    [x, z] = [x * Math.cos(delta) - z * Math.sin(delta), x * Math.sin(delta) + z * Math.cos(delta)];
    pos.push(x + at[0], y + at[1], z + at[2]);
  }
  return { hand: spec.hand ?? 'right', pos };
}

// ------------------------------------------------------------ helpers

const DEG = Math.PI / 180;
const POINT: HandSpec = { curl: [1.4, 0, 1.4, 1.4, 1.4], mcp: [0.3, 0, 1.2, 1.2, 1.2] };
const FIST: HandSpec = { curl: [1.4, 1.4, 1.4, 1.4, 1.4], mcp: [0.3, 1.2, 1.2, 1.2, 1.2] };

function level(p: Partial<LevelDef> = {}): LevelDef {
  return {
    v: 1, id: 't', name: 't', bench: { w: 1.0, d: 0.8 }, budget: 3,
    lamps: [], wells: [], crystals: [], hush: [], walls: [], mirrors: [],
    ...p,
  };
}

function optic(spec: HandSpec = {}, id = 'h', live = false, tints?: FingerTints): HandOptic {
  return computeOptic(makeHand(spec), { id, live, tints });
}

/** Builds a hand translated so that port `port` sits at `target`. */
function placed(spec: HandSpec, port: number, target: V2, id = 'h', live = false): HandOptic {
  const o = optic({ ...spec, at: [0, 0.03, 0] });
  const p = o.ports[port].p;
  return optic({ ...spec, at: [target[0] - p[0], 0.03, target[1] - p[1]] }, id, live);
}

const along = (p: V2, d: V2, t: number): V2 => [p[0] + d[0] * t, p[1] + d[1] * t];
const rot = (d: V2, a: number): V2 => [d[0] * Math.cos(a) - d[1] * Math.sin(a), d[0] * Math.sin(a) + d[1] * Math.cos(a)];

/** A lamp `dist` in front of a port, shining straight into it. */
function lampInto(port: Port, color: number, dist = 0.12): Lamp {
  return { p: along(port.p, port.dir, dist), a: Math.atan2(-port.dir[1], -port.dir[0]), color };
}

const near = (a: V2, b: V2, tol = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;
const segsFrom = (r: TraceResult, p: V2) => r.segments.filter((s) => near(s.a, p));
const segLen = (s: BeamSeg) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
const segDir = (s: BeamSeg): V2 => {
  const l = segLen(s);
  return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
};

// ------------------------------------------------------------ tests

describe('traceLevel: fan hands', () => {
  it('lamp into the wrist of a spread fan hand leaves through all 5 fingertips', () => {
    const h = optic();
    const r = traceLevel(level({ lamps: [lampInto(h.ports[5], Color.R)] }), [h]);
    expect(r.hands[0].inMask).toEqual([0, 0, 0, 0, 0, Color.R]);
    expect(r.hands[0].outMask).toEqual([1, 1, 1, 1, 1, 0]);
    expect(r.hands[0].carried).toBe(Color.R);
    expect(r.hands[0].id).toBe('h');
    expect(r.segments).toHaveLength(6);
    for (let f = 0; f < 5; f++) {
      const s = segsFrom(r, h.ports[f].p);
      expect(s).toHaveLength(1);
      expect(s[0].color).toBe(Color.R);
      const d = segDir(s[0]);
      expect(d[0] * h.ports[f].dir[0] + d[1] * h.ports[f].dir[1]).toBeGreaterThan(0.9999);
    }
  });

  it('lamp into a fingertip leaves through the other 4 fingers, never the wrist', () => {
    const h = optic();
    const r = traceLevel(level({ lamps: [lampInto(h.ports[1], Color.B)] }), [h]);
    expect(r.hands[0].inMask).toEqual([0, Color.B, 0, 0, 0, 0]);
    expect(r.hands[0].outMask).toEqual([4, 0, 4, 4, 4, 0]);
    expect(segsFrom(r, h.ports[5].p)).toHaveLength(0);
    expect(r.segments).toHaveLength(5);
  });

  it('only catches light arriving within 80 deg of a port axis', () => {
    const h = optic(POINT);
    const tip = h.ports[1];
    // Crossing the index port sideways: not caught, absorbed by the body (or passes).
    const side = rot(tip.dir, Math.PI / 2);
    const lamp: Lamp = { p: along(tip.p, side, 0.1), a: Math.atan2(-side[1], -side[0]), color: Color.R };
    const r = traceLevel(level({ lamps: [lamp] }), [h], { assist: 0 });
    expect(r.hands[0].inMask[1]).toBe(0);
    expect(r.hands[0].carried).toBe(0);
  });

  it('closed fingers and fists absorb', () => {
    const fist = optic({ ...FIST, at: [0, 0.03, 0] });
    expect(fist.mode).toBe('stone');
    const lamp: Lamp = { p: [-0.3, -0.06], a: 0, color: Color.R };
    const lv = level({ lamps: [lamp], crystals: [{ p: [0.3, -0.06], color: Color.R }] });
    expect(traceLevel(lv, []).crystals[0].state).toBe('lit');
    const r = traceLevel(lv, [fist]);
    expect(r.crystals[0].state).toBe('off');
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].b[0]).toBeLessThan(0.05);
  });

  it('relays through a chain of 2 hands into a crystal', () => {
    const A = optic({ ...POINT, heading: 0, at: [-0.25, 0.03, 0] }, 'A');
    const B = placed({ ...POINT, heading: 0 }, 5, along(A.ports[1].p, A.ports[1].dir, 0.1), 'B');
    const cp = along(B.ports[1].p, B.ports[1].dir, 0.1);
    const lv = level({ lamps: [lampInto(A.ports[5], Color.G)], crystals: [{ p: cp, color: Color.G }] });
    const r = traceLevel(lv, [A, B], { assist: 0 });
    expect(r.hands[0].outMask).toEqual([0, 2, 0, 0, 0, 0]);
    expect(r.hands[1].inMask).toEqual([0, 0, 0, 0, 0, 2]);
    expect(r.hands[1].outMask).toEqual([0, 2, 0, 0, 0, 0]);
    expect(r.crystals[0]).toEqual({ received: Color.G, state: 'lit' });
    expect(r.solved).toBe(true);
    expect(r.segments).toHaveLength(3);
  });

  it('d0 increases monotonically along a relay path and live propagates downstream', () => {
    const build = (liveA: boolean, liveB: boolean) => {
      const A = optic({ ...POINT, heading: 0, at: [-0.25, 0.03, 0] }, 'A', liveA);
      const B = placed({ ...POINT, heading: 0 }, 5, along(A.ports[1].p, A.ports[1].dir, 0.1), 'B', liveB);
      const cp = along(B.ports[1].p, B.ports[1].dir, 0.1);
      const lv = level({ lamps: [lampInto(A.ports[5], Color.R)], crystals: [{ p: cp, color: Color.R }] });
      const r = traceLevel(lv, [A, B]);
      return { r, A, B };
    };
    const { r, A, B } = build(false, false);
    const s0 = r.segments[0];
    const s1 = segsFrom(r, A.ports[1].p)[0];
    const s2 = segsFrom(r, B.ports[1].p)[0];
    expect(s0.d0).toBe(0);
    expect(s1.d0).toBeGreaterThanOrEqual(s0.d0 + segLen(s0));
    expect(s2.d0).toBeGreaterThanOrEqual(s1.d0 + segLen(s1));
    expect([s0.live, s1.live, s2.live]).toEqual([false, false, false]);

    const a = build(true, false);
    expect(a.r.segments.map((s) => s.live)).toEqual([false, true, true]);
    const b = build(false, true);
    expect(b.r.segments.map((s) => s.live)).toEqual([false, false, true]);
  });

  it('carries the union of colours (red lamp at the wrist + green well under a finger -> yellow)', () => {
    const h = optic();
    const lv = level({
      lamps: [lampInto(h.ports[5], Color.R)],
      wells: [{ p: h.ports[4].p, r: 0.012, color: Color.G }],
    });
    const r = traceLevel(lv, [h]);
    expect(r.hands[0].inMask).toEqual([0, 0, 0, 0, Color.G, Color.R]);
    expect(r.hands[0].carried).toBe(Color.Y);
    expect(r.hands[0].outMask).toEqual([3, 3, 3, 3, 0, 0]);
    for (const f of [0, 1, 2, 3]) expect(segsFrom(r, h.ports[f].p)[0].color).toBe(Color.Y);
    // Well light counts as distance 0 at the port.
    expect(segsFrom(r, h.ports[0].p)[0].d0).toBeLessThan(0.2);
  });

  it('a palm resting in a well drinks its light through the wrist', () => {
    const h = optic();
    const r = traceLevel(level({ wells: [{ p: h.center, r: 0.03, color: Color.B }] }), [h]);
    expect(r.hands[0].inMask[5]).toBe(Color.B);
    expect(r.hands[0].outMask).toEqual([4, 4, 4, 4, 4, 0]);
    expect(r.segments.every((s) => s.d0 < 0.3)).toBe(true);
  });

  it('finger tints filter the emitted colour', () => {
    const h = optic({}, 'h', false, [7, 1, 2, 4, 0]);
    const r = traceLevel(level({ lamps: [lampInto(h.ports[5], Color.W)] }), [h]);
    expect(r.hands[0].outMask).toEqual([7, 1, 2, 4, 0, 0]);
    expect(r.segments).toHaveLength(5);
    expect(segsFrom(r, h.ports[4].p)).toHaveLength(0);
  });
});

describe('traceLevel: targets and geometry', () => {
  it('wakes a hush stone and blocks the solve', () => {
    const h = optic(POINT);
    const hp = along(h.ports[1].p, h.ports[1].dir, 0.15);
    const lv = level({
      lamps: [lampInto(h.ports[5], Color.R), { p: [0.4, 0.3], a: Math.PI, color: Color.R }],
      crystals: [{ p: [0.2, 0.3], color: Color.R }],
      hush: [{ p: hp }],
    });
    const r = traceLevel(lv, [h]);
    expect(r.crystals[0].state).toBe('lit');
    expect(r.hush[0]).toEqual({ received: Color.R, awake: true });
    expect(r.solved).toBe(false);
  });

  it('blade hands reflect from both sides with equal angles', () => {
    const h = optic({ roll: Math.PI / 2, spread: 0, heading: -Math.PI / 2 + 0.2 });
    expect(h.mode).toBe('blade');
    const m = h.mirror!;
    const mid: V2 = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2];
    const l = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
    const u: V2 = [(m.b[0] - m.a[0]) / l, (m.b[1] - m.a[1]) / l];
    const n: V2 = [-u[1], u[0]];
    for (const side of [1, -1]) {
      // Incoming 35 deg off the mirror line, from either side.
      const d: V2 = [u[0] * Math.cos(35 * DEG) - side * n[0] * Math.sin(35 * DEG), u[1] * Math.cos(35 * DEG) - side * n[1] * Math.sin(35 * DEG)];
      const lamp: Lamp = { p: along(mid, d, -0.12), a: Math.atan2(d[1], d[0]), color: Color.C };
      const r = traceLevel(level({ lamps: [lamp] }), [h]);
      expect(r.segments).toHaveLength(2);
      expect(near(r.segments[0].b, mid, 1e-6)).toBe(true);
      const out = segDir(r.segments[1]);
      const dn = d[0] * n[0] + d[1] * n[1];
      expect(out[0]).toBeCloseTo(d[0] - 2 * dn * n[0], 6);
      expect(out[1]).toBeCloseTo(d[1] - 2 * dn * n[1], 6);
      // Angle of incidence == angle of reflection.
      expect(Math.abs(out[0] * n[0] + out[1] * n[1])).toBeCloseTo(Math.abs(dn), 9);
      expect(r.segments[1].d0).toBeCloseTo(0.12, 3);
      expect(r.segments[1].live).toBe(false);
    }
    const live = computeOptic(makeHand({ roll: Math.PI / 2, spread: 0 }), { id: 'b', live: true });
    const lm = live.mirror!;
    const lamp: Lamp = { p: [-0.2, (lm.a[1] + lm.b[1]) / 2], a: 0, color: Color.R };
    const r = traceLevel(level({ lamps: [lamp] }), [live]);
    expect(r.segments.map((s) => s.live)).toEqual([false, true]);
    expect(segDir(r.segments[1])[0]).toBeLessThan(-0.99);
  });

  it('walls block light', () => {
    const lamp: Lamp = { p: [-0.3, 0], a: 0, color: Color.R };
    const crystals = [{ p: [0.2, 0] as V2, color: Color.R }];
    expect(traceLevel(level({ lamps: [lamp], crystals }), []).crystals[0].state).toBe('lit');
    const r = traceLevel(level({ lamps: [lamp], crystals, walls: [{ a: [0, -0.05], b: [0, 0.05] }] }), []);
    expect(r.crystals[0].state).toBe('off');
    expect(r.segments[0].b[0]).toBeCloseTo(0, 9);
  });

  it('fixed mirrors reflect (45 deg turns +X into +Z)', () => {
    const r = traceLevel(
      level({
        lamps: [{ p: [-0.3, 0], a: 0, color: Color.B }],
        mirrors: [{ a: [-0.03, -0.03], b: [0.03, 0.03] }],
        crystals: [{ p: [0, 0.2], color: Color.B }],
      }),
      [],
    );
    expect(r.segments).toHaveLength(2);
    expect(segDir(r.segments[1])[1]).toBeCloseTo(1, 9);
    expect(r.crystals[0].state).toBe('lit');
    expect(r.solved).toBe(true);
  });

  it('ends rays at the bench edge', () => {
    const r = traceLevel(level({ lamps: [{ p: [0, 0], a: 0.3, color: Color.R }] }), []);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].b[0]).toBeCloseTo(0.5, 9);
    expect(r.segments[0].b[1]).toBeCloseTo(0.5 * Math.tan(0.3), 9);
    const up = traceLevel(level({ lamps: [{ p: [0.1, 0], a: -Math.PI / 2, color: Color.R }] }), []);
    expect(up.segments[0].b).toEqual([expect.closeTo(0.1, 9), expect.closeTo(-0.4, 9)]);
  });

  it('caps reflection depth between parallel mirrors', () => {
    const lv = level({
      lamps: [{ p: [0, -0.3], a: 0.1, color: Color.R }],
      mirrors: [
        { a: [-0.05, -0.35], b: [-0.05, 0.35] },
        { a: [0.05, -0.35], b: [0.05, 0.35] },
      ],
    });
    const r = traceLevel(lv, [], { maxDepth: 5 });
    expect(r.segments).toHaveLength(6);
    expect(traceLevel(lv, []).segments.length).toBeLessThanOrEqual(13);
  });

  it('reports crystal states and the solved flag', () => {
    const lamp = (z: number, color: number): Lamp => ({ p: [-0.3, z], a: 0, color });
    const r = traceLevel(
      level({
        lamps: [lamp(0, Color.R), lamp(0.1, Color.R), lamp(0.2, Color.R)],
        crystals: [
          { p: [0, 0], color: Color.R },
          { p: [0, 0.1], color: Color.Y },
          { p: [0, 0.2], color: Color.G },
          { p: [0, 0.3], color: Color.G },
        ],
      }),
      [],
    );
    expect(r.crystals.map((c) => c.state)).toEqual(['lit', 'partial', 'wrong', 'off']);
    expect(r.solved).toBe(false);
    expect(traceLevel(level({ lamps: [lamp(0, Color.R)] }), []).solved).toBe(false);
    const ok = level({ lamps: [lamp(0, Color.R)], crystals: [{ p: [0, 0], color: Color.R }] });
    expect(traceLevel(ok, []).solved).toBe(true);
    expect(traceLevel({ ...ok, hush: [{ p: [0.2, 0.3] }] }, []).solved).toBe(true);
  });
});

describe('traceLevel: aim assist', () => {
  const setup = (offDeg: number, extra: Partial<LevelDef> = {}, assist?: number) => {
    const h = optic(POINT);
    const P = h.ports[1].p;
    const target = along(P, rot(h.ports[1].dir, offDeg * DEG), 0.3);
    const lv = level({ bench: { w: 1.0, d: 1.2 }, lamps: [lampInto(h.ports[5], Color.R)], crystals: [{ p: target, color: Color.R }], ...extra });
    return { h, P, target, r: traceLevel(lv, [h], assist === undefined ? undefined : { assist }) };
  };

  it('bends a 4 deg miss onto a crystal', () => {
    const { r, P, target } = setup(4);
    expect(r.crystals[0].state).toBe('lit');
    const s = segsFrom(r, P)[0];
    expect(s.assisted).toBe(true);
    const d = segDir(s);
    const want = Math.atan2(target[1] - P[1], target[0] - P[0]);
    expect(Math.atan2(d[1], d[0])).toBeCloseTo(want, 6);
    expect(r.segments[0].assisted).toBeUndefined();
  });

  it('leaves a 9 deg miss alone, and is disabled by assist: 0', () => {
    const nine = setup(9);
    expect(nine.r.crystals[0].state).toBe('off');
    expect(nine.r.segments.some((s) => s.assisted)).toBe(false);
    const off = setup(4, {}, 0);
    expect(off.r.crystals[0].state).toBe('off');
  });

  it('never aims at a hush stone', () => {
    const h = optic(POINT);
    const P = h.ports[1].p;
    const hp = along(P, rot(h.ports[1].dir, 4 * DEG), 0.3);
    const r = traceLevel(level({ bench: { w: 1.0, d: 1.2 }, lamps: [lampInto(h.ports[5], Color.R)], hush: [{ p: hp }] }), [h]);
    expect(r.hush[0].awake).toBe(false);
    expect(r.segments.some((s) => s.assisted)).toBe(false);
  });

  it('does not assist through walls', () => {
    const h = optic(POINT);
    const P = h.ports[1].p;
    const u = rot(h.ports[1].dir, 4 * DEG);
    const m = along(P, u, 0.15);
    const nrm: V2 = [-u[1], u[0]];
    const wall = { a: along(m, nrm, -0.004), b: along(m, nrm, 0.004) };
    const { r } = setup(4, { walls: [wall] });
    expect(r.crystals[0].state).toBe('off');
    expect(r.segments.some((s) => s.assisted)).toBe(false);
  });

  it('assists onto another hand port but never its own', () => {
    const A = optic({ ...POINT, heading: 0, at: [-0.25, 0.03, 0] }, 'A');
    // B's wrist 5 deg off A's index ray, far enough (30 cm) that the natural ray misses its 2 cm port.
    const target = along(A.ports[1].p, rot(A.ports[1].dir, 5 * DEG), 0.3);
    const B = placed({ ...POINT, heading: 0 }, 5, target, 'B');
    const r = traceLevel(level({ bench: { w: 1.2, d: 1.2 }, lamps: [lampInto(A.ports[5], Color.R)] }), [A, B]);
    expect(traceLevel(level({ bench: { w: 1.2, d: 1.2 }, lamps: [lampInto(A.ports[5], Color.R)] }), [A, B], { assist: 0 })
      .hands[1].inMask[5]).toBe(0);
    expect(r.hands[1].inMask[5]).toBe(Color.R);
    expect(segsFrom(r, A.ports[1].p)[0].assisted).toBe(true);
  });
});

describe('traceLevel: fixpoint and robustness', () => {
  /** A minimal hand-built fan optic (no body) with the given open finger ports. */
  function bare(id: string, fingers: { f: number; p: V2; dir: V2 }[], wrist?: { p: V2; dir: V2 }): HandOptic {
    const ports: Port[] = [];
    for (let f = 0; f < 5; f++) {
      const spec = fingers.find((x) => x.f === f);
      ports.push({ kind: 'finger', finger: f, p: spec?.p ?? [0, 0], dir: spec?.dir ?? [0, -1], r: 0.013, open: !!spec });
    }
    ports.push({ kind: 'wrist', finger: -1, p: wrist?.p ?? [0, 0], dir: wrist?.dir ?? [0, 1], r: 0.02, open: !!wrist });
    return { id, hand: 'right', mode: 'fan', live: false, ports, body: [], palm: [], center: ports[0].p, height: 0.03, tints: [7, 7, 7, 7, 7] };
  }
  const norm = (x: number, z: number): V2 => {
    const l = Math.hypot(x, z);
    return [x / l, z / l];
  };

  it('terminates deterministically on an oscillating cyclic relay', () => {
    // A's finger 0 feeds B's finger 0; B's finger 1 shines straight back into A's finger 0.
    const A = bare('A', [{ f: 0, p: [-0.1, 0], dir: [1, 0] }], { p: [-0.3, 0], dir: [-1, 0] });
    const B = bare('B', [
      { f: 0, p: [0.1, 0], dir: [-1, 0] },
      { f: 1, p: [0.1, 0.05], dir: norm(-0.2, -0.05) },
    ]);
    const lv = level({ lamps: [{ p: [-0.45, 0], a: 0, color: Color.R }] });
    const r1 = traceLevel(lv, [A, B], { assist: 0 });
    const r2 = traceLevel(lv, [A, B], { assist: 0 });
    expect(r1).toEqual(r2);
    expect(r1.segments.length).toBeLessThan(512);
    // Consistent result: no port both receives and emits.
    for (const io of r1.hands) io.outMask.forEach((o, i) => expect(o !== 0 && io.inMask[i] !== 0).toBe(false));
  });

  it('settles face-to-face real hands relaying into each other', () => {
    const A = optic({ heading: 0, at: [-0.28, 0.03, 0] }, 'A');
    const B = placed({ heading: Math.PI, hand: 'left' }, 2, along(A.ports[2].p, A.ports[2].dir, 0.06), 'B');
    const lv = level({ lamps: [lampInto(A.ports[5], Color.W)] });
    const r1 = traceLevel(lv, [A, B]);
    expect(r1).toEqual(traceLevel(lv, [A, B]));
    expect(r1.hands[1].carried).not.toBe(0);
    for (const io of r1.hands) io.outMask.forEach((o, i) => expect(o !== 0 && io.inMask[i] !== 0).toBe(false));
  });

  it('a hand never feeds itself', () => {
    // Index points straight back at the hand's own wrist port region: no self-catch.
    const A = bare('A', [{ f: 1, p: [0, -0.1], dir: [0, 1] }], { p: [0, 0.05], dir: [0, 1] });
    const r = traceLevel(level({ wells: [{ p: [0, -0.1], r: 0.02, color: Color.R }] }), [A]);
    expect(r.hands[0].inMask).toEqual([0, Color.R, 0, 0, 0, 0]);
    expect(r.hands[0].outMask).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('caps total segments at 512', () => {
    const lamps: Lamp[] = [];
    for (let i = 0; i < 100; i++) lamps.push({ p: [0, -0.3 + i * 0.006], a: 0.05, color: Color.R });
    const lv = level({
      lamps,
      mirrors: [
        { a: [-0.2, -0.4], b: [-0.2, 0.4] },
        { a: [0.2, -0.4], b: [0.2, 0.4] },
      ],
    });
    expect(traceLevel(lv, []).segments).toHaveLength(512);
  });

  it('traces 12 hands and ~64 rays well under budget', () => {
    const hands: HandOptic[] = [];
    const lamps: Lamp[] = [];
    let k = 0;
    for (const z of [0.3, 0, -0.3]) {
      for (const x of [-0.36, -0.12, 0.12, 0.36]) {
        const h = optic({ at: [x, 0.03, z], hand: k % 2 ? 'left' : 'right' }, `h${k++}`, k === 1);
        hands.push(h);
        lamps.push(lampInto(h.ports[5], (k % 7) + 1, 0.05));
      }
    }
    const lv = level({ bench: { w: 1.0, d: 1.0 }, lamps, crystals: [{ p: [0, -0.48], color: Color.W }], hush: [{ p: [0.3, -0.48] }] });
    let r = traceLevel(lv, hands);
    for (let i = 0; i < 20; i++) r = traceLevel(lv, hands);
    const n = 100;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r = traceLevel(lv, hands);
    const ms = (performance.now() - t0) / n;
    console.log(`traceLevel: 12 hands, ${r.segments.length} segments, ${ms.toFixed(3)} ms/call`);
    expect(r.segments.length).toBeGreaterThan(50);
    expect(ms).toBeLessThan(5);
  });
});

describe('vec2 ray primitives', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  /** Brute-force ray march reference: first t where the point enters the shape. */
  const march = (inside: (x: number, z: number) => boolean, ox: number, oz: number, dx: number, dz: number) => {
    for (let t = 0; t < 0.6; t += 1e-4) if (inside(ox + dx * t, oz + dz * t)) return t;
    return Infinity;
  };

  it('rayCapsule (with early-outs) matches a ray march', () => {
    for (let i = 0; i < 300; i++) {
      const ax = rnd() * 0.2 - 0.1, az = rnd() * 0.2 - 0.1, bx = rnd() * 0.2 - 0.1, bz = rnd() * 0.2 - 0.1;
      const r = 0.005 + rnd() * 0.02;
      const ox = rnd() * 0.4 - 0.2, oz = rnd() * 0.4 - 0.2;
      const a = rnd() * Math.PI * 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      const t = rayCapsule(ox, oz, dx, dz, ax, az, bx, bz, r);
      const ref = march((x, z) => pointSegDistSq(x, z, ax, az, bx, bz) <= r * r, ox, oz, dx, dz);
      if (ref === Infinity) expect(t === Infinity || t > 0.599).toBe(true);
      else expect(Math.abs(t - ref)).toBeLessThan(2e-4);
      // maxT only ever turns far hits into misses.
      const capped = rayCapsule(ox, oz, dx, dz, ax, az, bx, bz, r, 0.05);
      if (t < 0.05) expect(capped).toBeCloseTo(t, 12);
    }
  });

  it('rayConvexPolygon matches a ray march on a random hull', () => {
    const pts: V2[] = [];
    for (let i = 0; i < 9; i++) pts.push([rnd() * 0.1 - 0.05, rnd() * 0.1 - 0.05]);
    const hull = convexHull(pts);
    expect(signedArea(hull)).toBeGreaterThan(0);
    const inside = (x: number, z: number) =>
      hull.every((p, i) => {
        const q = hull[(i + 1) % hull.length];
        return (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (x - p[0]) >= 0;
      });
    for (let i = 0; i < 200; i++) {
      const ox = rnd() * 0.3 - 0.15, oz = rnd() * 0.3 - 0.15;
      const a = rnd() * Math.PI * 2;
      const t = rayConvexPolygon(ox, oz, Math.cos(a), Math.sin(a), hull);
      const ref = march(inside, ox, oz, Math.cos(a), Math.sin(a));
      if (ref === Infinity) expect(t).toBe(Infinity);
      else expect(Math.abs(t - ref)).toBeLessThan(2e-4);
    }
  });

  it('rayCircle and raySegment basics', () => {
    expect(rayCircle(-1, 0, 1, 0, 0, 0, 0.1)).toBeCloseTo(0.9, 12);
    expect(rayCircle(0.05, 0, 1, 0, 0, 0, 0.1)).toBe(0);
    expect(rayCircle(1, 0, 1, 0, 0, 0, 0.1)).toBe(Infinity);
    expect(raySegment(0, 0, 1, 0, 0.5, -1, 0.5, 1)).toBeCloseTo(0.5, 12);
    expect(raySegment(0, 0, 1, 0, 0.5, 0.1, 0.5, 1)).toBe(Infinity);
    expect(raySegment(0, 0, 1, 0, 0, 1, 1, 1)).toBe(Infinity);
  });
});
