import { describe, expect, it } from 'vitest';
import { computeOptic, type FeatureState } from '../src/core/hand-features.js';
import { KNUCKLE, TIP } from '../src/core/joints.js';
import type { Handedness, HandPose } from '../src/core/types.js';
import { signedArea } from '../src/core/vec2.js';

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

function straightness(pose: HandPose, f: number): number {
  const p = pose.pos;
  const j = (i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const chain = f === 0 ? [2, 3, 4] : [5 * f + 1, 5 * f + 2, 5 * f + 3, 5 * f + 4];
  let L = 0;
  for (let i = 0; i < chain.length - 1; i++) L += d(j(chain[i]), j(chain[i + 1]));
  return d(j(KNUCKLE[f]), j(TIP[f])) / L;
}

const FIST = [1.4, 1.4, 1.4, 1.4, 1.4];
const FIST_MCP = [0.3, 1.2, 1.2, 1.2, 1.2];
const opt = { id: 'h', live: true };

describe('computeOptic', () => {
  it('palm-down right hand is a fan with palm normal -Y and all ports open', () => {
    const o = computeOptic(makeHand(), opt);
    expect(o.mode).toBe('fan');
    expect(o.ports).toHaveLength(6);
    expect(o.ports.every((p) => p.open)).toBe(true);
    // Thumb on the -X side, pinky on +X.
    expect(o.ports[0].p[0]).toBeLessThan(o.ports[4].p[0]);
    // Wrist port behind the wrist, facing the player.
    expect(o.ports[5].kind).toBe('wrist');
    expect(o.ports[5].dir[1]).toBeCloseTo(1, 2);
    expect(o.ports[5].p[1]).toBeCloseTo(0.01, 4);
    expect(o.ports[2].dir[1]).toBeCloseTo(-1, 5);
    expect(o.body).toHaveLength(24);
    expect(signedArea(o.palm)).toBeGreaterThan(0);
    expect(o.height).toBeCloseTo(0.03, 5);
    expect(o.center[1]).toBeCloseTo(-0.044, 3);
  });

  it('computes the palm normal for both hands', () => {
    // Exposed through the mode thresholds: verify via an internal recompute.
    for (const hand of ['left', 'right'] as const) {
      const pose = makeHand({ hand });
      const p = pose.pos;
      const v = (i: number) => [p[i * 3] - p[0], p[i * 3 + 1] - p[1], p[i * 3 + 2] - p[2]];
      const u = v(KNUCKLE[1]);
      const w = v(KNUCKLE[4]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const ny = (hand === 'left' ? -1 : 1) * (n[1] / Math.hypot(n[0], n[1], n[2]));
      expect(ny).toBeCloseTo(-1, 5);
      const o = computeOptic(pose, opt);
      expect(o.mode).toBe('fan');
      expect(o.hand).toBe(hand);
    }
  });

  it('left hand mirrors the right (thumb on +X)', () => {
    const o = computeOptic(makeHand({ hand: 'left' }), opt);
    expect(o.ports[0].p[0]).toBeGreaterThan(o.ports[4].p[0]);
    expect(o.ports.every((p) => p.open)).toBe(true);
    expect(signedArea(o.palm)).toBeGreaterThan(0);
  });

  it('palm-up still fans', () => {
    expect(computeOptic(makeHand({ roll: Math.PI }), opt).mode).toBe('fan');
  });

  it('fist is a stone with closed ports and a body', () => {
    const o = computeOptic(makeHand({ curl: FIST, mcp: FIST_MCP }), opt);
    expect(o.mode).toBe('stone');
    expect(o.ports.every((p) => !p.open)).toBe(true);
    expect(o.body.length).toBe(24);
    expect(o.palm.length).toBeGreaterThanOrEqual(3);
  });

  it('hand on its pinky edge with fingers together is a blade mirror', () => {
    for (const hand of ['left', 'right'] as const) {
      const pose = makeHand({ hand, roll: Math.PI / 2, spread: 0, heading: 0.3 });
      const o = computeOptic(pose, opt);
      expect(o.mode).toBe('blade');
      expect(o.body).toEqual([]);
      expect(o.palm).toEqual([]);
      expect(o.ports.every((p) => !p.open)).toBe(true);
      const m = o.mirror!;
      expect(m.a[0]).toBeCloseTo(pose.pos[0], 6);
      expect(m.a[1]).toBeCloseTo(pose.pos[2], 6);
      // Extends 1 cm past the middle tip along the hand.
      const tx = pose.pos[TIP[2] * 3];
      const tz = pose.pos[TIP[2] * 3 + 2];
      expect(Math.hypot(m.b[0] - tx, m.b[1] - tz)).toBeCloseTo(0.01, 5);
      expect(Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1])).toBeGreaterThan(Math.hypot(tx - m.a[0], tz - m.a[1]));
    }
  });

  it('vertical palm with some fingers curled is none', () => {
    expect(computeOptic(makeHand({ roll: Math.PI / 2, curl: [0, 1.4, 1.4, 0, 0] }), opt).mode).toBe('none');
  });

  it('tilted palm between the blade and fan thresholds is none', () => {
    // |n.y| = cos(65 deg) ~ 0.42: neither flat enough to fan nor upright enough to be a blade.
    expect(computeOptic(makeHand({ roll: 65 * (Math.PI / 180), spread: 0 }), opt).mode).toBe('none');
  });

  it('pointing opens only the index port (plus wrist)', () => {
    const o = computeOptic(makeHand({ curl: [1.4, 0, 1.4, 1.4, 1.4] }), opt);
    expect(o.mode).toBe('fan');
    expect(o.ports.map((p) => p.open)).toEqual([false, true, false, false, false, true]);
  });

  it('finger extension has hysteresis between 0.82 and 0.88', () => {
    // Find a curl giving index straightness ~0.85.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const c = (lo + hi) / 2;
      if (straightness(makeHand({ curl: [0, c, 0, 0, 0] }), 1) > 0.85) lo = c;
      else hi = c;
    }
    const mid = makeHand({ curl: [0, lo, 0, 0, 0] });
    expect(straightness(mid, 1)).toBeCloseTo(0.85, 3);
    expect(computeOptic(mid, opt).ports[1].open).toBe(false);

    const state: FeatureState = { extended: [] };
    expect(computeOptic(makeHand(), { ...opt, state }).ports[1].open).toBe(true);
    expect(state.extended).toEqual([true, true, true, true, true]);
    // Same 0.85 pose now stays extended because it was extended.
    expect(computeOptic(mid, { ...opt, state }).ports[1].open).toBe(true);
    expect(state.extended[1]).toBe(true);
    // Below the exit threshold it releases, and 0.85 does not re-enter.
    computeOptic(makeHand({ curl: [0, 0.8, 0, 0, 0] }), { ...opt, state });
    expect(state.extended[1]).toBe(false);
    expect(computeOptic(mid, { ...opt, state }).ports[1].open).toBe(false);
  });

  it('closes the port of a finger pointing too steeply into the bench', () => {
    const o = computeOptic(makeHand({ handPitch: 0.87, pitch: [0, 0.27, 0, 0, 0] }), opt);
    expect(o.mode).toBe('fan');
    expect(o.ports[1].open).toBe(false);
    expect(o.ports[2].open).toBe(true);
    expect(o.ports[3].open).toBe(true);
  });

  it('respects benchY, heading and tints', () => {
    const o = computeOptic(makeHand({ at: [0.1, 0.9, 0.05], heading: 0 }), {
      ...opt,
      benchY: 0.85,
      tints: [1, 2, 4, 7, 0],
    });
    expect(o.height).toBeCloseTo(0.05, 5);
    expect(o.ports[2].dir[0]).toBeCloseTo(1, 5);
    expect(o.ports[5].dir[0]).toBeCloseTo(-1, 2);
    expect(o.tints).toEqual([1, 2, 4, 7, 0]);
    expect(o.live).toBe(true);
    expect(o.id).toBe('h');
  });
});
