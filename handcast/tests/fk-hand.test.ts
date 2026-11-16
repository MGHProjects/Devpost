import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { pointHandPose } from 'iwer/lib/device/configs/hand/point.js';
import { BONES, FINGER_CHAINS, KNUCKLE, TIP } from '../src/core/joints';
import type { HandPose, Handedness, Quat, V3 } from '../src/core/types';
import { createHandPose, fkPose, fkPoseInto, palmCenter, type PoseParams } from '../src/core/fk-hand';
import { EXTENDED, POSES, POSE_NAMES, canonicalPose } from '../src/core/pose-library';
import { benchToWorld, iwerPoseFromWorld, iwerPoseToWorld, matrixFromQuatPos } from '../src/core/iwer-pose';

const HANDS: Handedness[] = ['right', 'left'];
const DEG = 180 / Math.PI;

const sub = (p: ArrayLike<number>, a: number, b: number): V3 => [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);
const norm = (v: V3): V3 => { const l = len(v); return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a: V3, b: V3) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * DEG;
function rotate(q: ArrayLike<number>, qi: number, v: V3): V3 {
  const [x, y, z, w] = [q[qi], q[qi + 1], q[qi + 2], q[qi + 3]];
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

function palmNormal(p: HandPose): V3 {
  const n = norm(cross(sub(p.pos, 0, KNUCKLE[1]), sub(p.pos, 0, KNUCKLE[4])));
  return p.hand === 'left' ? [-n[0], -n[1], -n[2]] : n;
}

function extension(p: HandPose, f: number): number {
  const chain = FINGER_CHAINS[f];
  let total = 0;
  for (let i = chain.indexOf(KNUCKLE[f]); i < chain.length - 1; i++) total += len(sub(p.pos, chain[i], chain[i + 1]));
  return len(sub(p.pos, KNUCKLE[f], TIP[f])) / total;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomParams(r: () => number, hand: Handedness): PoseParams {
  return {
    hand,
    curl: [r(), r(), r(), r(), r()],
    spread: r(),
    at: [r() * 0.4 - 0.2, r() * 0.3 - 0.15],
    yaw: r() * 2 * Math.PI - Math.PI,
    roll: r() * Math.PI - Math.PI / 2,
    pitch: r() * 0.8 - 0.4,
    lift: 0.02 + r() * 0.08,
    thumbAbduct: r() * 2 - 1,
  };
}

const flat = (hand: Handedness, extra: Partial<PoseParams> = {}) => fkPose({ hand, curl: [0, 0, 0, 0, 0], at: [0, 0], ...extra });

describe('FK hand', () => {
  it('keeps bone lengths constant under all parameters', () => {
    const r = rng(7);
    for (const hand of HANDS) {
      const rest = flat(hand);
      const restLen = BONES.map(([a, b]) => len(sub(rest.pos, a, b)));
      for (let k = 0; k < 200; k++) {
        const p = fkPose(randomParams(r, hand));
        BONES.forEach(([a, b], i) => expect(Math.abs(len(sub(p.pos, a, b)) - restLen[i])).toBeLessThan(1e-5));
      }
    }
  });

  it('builds the canonical frame: fingers along -Z, palm normal -Y, palm down', () => {
    for (const hand of HANDS) {
      const p = flat(hand);
      for (let f = 1; f < 5; f++) expect(angle(sub(p.pos, KNUCKLE[f], TIP[f]), [0, 0, -1])).toBeLessThan(10);
      expect(angle(sub(p.pos, 0, KNUCKLE[2]), [0, 0, -1])).toBeLessThan(1e-3);
      expect(angle(palmNormal(p), [0, -1, 0])).toBeLessThan(15);
      // Flat and straight: every finger fully extended.
      for (let f = 0; f < 5; f++) expect(extension(p, f)).toBeGreaterThan(0.99);
    }
  });

  it('puts the right thumb on -X and the left thumb on +X', () => {
    const r = flat('right');
    const l = flat('left');
    expect(r.pos[TIP[0] * 3] - r.pos[0]).toBeLessThan(-0.03);
    expect(r.pos[KNUCKLE[4] * 3]).toBeGreaterThan(r.pos[KNUCKLE[1] * 3]);
    expect(l.pos[TIP[0] * 3] - l.pos[0]).toBeGreaterThan(0.03);
    expect(l.pos[KNUCKLE[4] * 3]).toBeLessThan(l.pos[KNUCKLE[1] * 3]);
  });

  it('places the palm centre at (at, lift)', () => {
    const r = rng(3);
    for (const hand of HANDS) for (let k = 0; k < 20; k++) {
      const params = randomParams(r, hand);
      const c = palmCenter(fkPose(params));
      expect(c[0]).toBeCloseTo(params.at[0], 6);
      expect(c[1]).toBeCloseTo(params.lift!, 6);
      expect(c[2]).toBeCloseTo(params.at[1], 6);
    }
    expect(palmCenter(flat('right'))[1]).toBeCloseTo(0.035, 6);
  });

  it('rotates the hand axis to the requested yaw', () => {
    for (const hand of HANDS) for (const yaw of [-Math.PI / 2, 0, Math.PI / 4, Math.PI / 2, Math.PI, -2.5]) {
      for (const pitch of [0, 0.3]) {
        const p = flat(hand, { yaw, pitch, roll: 0.4 });
        const axis = sub(p.pos, 0, KNUCKLE[2]);
        const a = Math.atan2(axis[2], axis[0]);
        expect(Math.abs(Math.atan2(Math.sin(a - yaw), Math.cos(a - yaw)))).toBeLessThan(1e-5);
      }
    }
    // Default heading points away from the player.
    const d = sub(flat('right').pos, 0, KNUCKLE[2]);
    expect(d[2]).toBeLessThan(0);
    expect(Math.abs(d[0])).toBeLessThan(1e-6);
  });

  it('pitch tilts the fingers down toward the bench', () => {
    const p = flat('right', { pitch: 0.3 });
    const axis = sub(p.pos, 0, KNUCKLE[2]);
    expect(Math.asin(-axis[1] / len(axis))).toBeCloseTo(0.3, 5);
  });

  it('blade stands on the pinky edge', () => {
    for (const hand of HANDS) for (const yaw of [-Math.PI / 2, 0.7]) {
      const p = canonicalPose('blade', hand, [0.05, -0.02], yaw);
      expect(Math.abs(palmNormal(p)[1])).toBeLessThan(0.3);
      expect(p.pos[KNUCKLE[4] * 3 + 1]).toBeLessThan(p.pos[KNUCKLE[1] * 3 + 1] - 0.03);
      for (let j = 0; j < 25; j++) expect(p.pos[j * 3 + 1] - p.radii![j]).toBeGreaterThan(0);
    }
  });

  it('library poses match their intended extended / curled fingers', () => {
    for (const hand of HANDS) for (const name of POSE_NAMES) {
      const p = canonicalPose(name, hand, [0, 0], 0.3);
      for (let f = 0; f < 5; f++) {
        const e = extension(p, f);
        const msg = `${hand} ${name} finger ${f}: ${e.toFixed(3)}`;
        if (EXTENDED[name][f]) expect(e, msg).toBeGreaterThan(0.9);
        else expect(e, msg).toBeLessThan(0.76);
        if (POSES[name].curl[f] >= 0.6) expect(e, msg).toBeLessThan(0.72);
      }
    }
  });

  it('library poses rest above the bench (joint spheres clear y = 0)', () => {
    for (const hand of HANDS) for (const name of POSE_NAMES) {
      const p = canonicalPose(name, hand, [0, 0]);
      let low = Infinity;
      for (let j = 0; j < 25; j++) low = Math.min(low, p.pos[j * 3 + 1] - p.radii![j]);
      expect(low, `${hand} ${name}`).toBeGreaterThan(0);
      expect(low, `${hand} ${name}`).toBeLessThan(0.012);
    }
  });

  it('any curl >= 0.6 reads clearly curled; curl <= 0.15 reads extended', () => {
    for (const hand of HANDS) for (let f = 0; f < 5; f++) for (const c of [0, 0.1, 0.15, 0.6, 0.8, 1]) {
      const curl: PoseParams['curl'] = [0, 0, 0, 0, 0];
      curl[f] = c;
      const e = extension(fkPose({ hand, curl, at: [0, 0] }), f);
      if (c >= 0.6) expect(e).toBeLessThan(0.75);
      else expect(e).toBeGreaterThan(0.9);
    }
  });

  it('joint quaternions are unit, -Z follows the bone and +Y is dorsal', () => {
    const r = rng(11);
    for (const hand of HANDS) for (let k = 0; k < 100; k++) {
      const params = k === 0 ? { hand, curl: [0, 0, 0, 0, 0] as PoseParams['curl'], at: [0, 0] as [number, number] } : randomParams(r, hand);
      const p = fkPose(params);
      const rot = p.rot!;
      for (let j = 0; j < 25; j++) {
        expect(Math.hypot(rot[j * 4], rot[j * 4 + 1], rot[j * 4 + 2], rot[j * 4 + 3])).toBeCloseTo(1, 5);
      }
      expect(angle(rotate(rot, 0, [0, 0, -1]), sub(p.pos, 0, KNUCKLE[2]))).toBeLessThan(10);
      for (const chain of FINGER_CHAINS) {
        for (let i = 0; i < chain.length; i++) {
          const j = chain[i];
          const bone = i < chain.length - 1 ? sub(p.pos, j, chain[i + 1]) : sub(p.pos, chain[i - 1], j);
          expect(angle(rotate(rot, j * 4, [0, 0, -1]), bone), `${hand} joint ${j}`).toBeLessThan(10);
        }
      }
      if (k === 0) {
        // Palm-down flat hand: finger joints have +Y up (dorsal) and are ~identity.
        for (let f = 1; f < 5; f++) for (const j of FINGER_CHAINS[f]) {
          expect(rotate(rot, j * 4, [0, 1, 0])[1], `${hand} joint ${j}`).toBeGreaterThan(0.9);
          expect(Math.abs(rot[j * 4 + 3]), `${hand} joint ${j}`).toBeGreaterThan(0.95);
        }
        expect(Math.abs(rot[3])).toBeGreaterThan(0.95);
      }
    }
  });

  it('fkPoseInto reuses its buffers and matches fkPose', () => {
    const out = createHandPose('right');
    const { pos, rot } = out;
    const params: PoseParams = { hand: 'left', curl: [0.2, 0.4, 0.6, 0.8, 1], spread: 0.5, at: [0.1, 0.05], yaw: 0.3 };
    fkPoseInto(params, out);
    expect(out.pos).toBe(pos);
    expect(out.rot).toBe(rot);
    expect(out.hand).toBe('left');
    const ref = fkPose(params);
    for (let i = 0; i < 75; i++) expect(out.pos[i]).toBe(ref.pos[i]);
  });
});

describe('IWER export', () => {
  const ident: Quat = [0, 0, 0, 1];
  const zero: V3 = [0, 0, 0];

  function maxMatrixError(a: Record<string, { offsetMatrix: ArrayLike<number> }>, b: Record<string, { offsetMatrix: ArrayLike<number> }>): number {
    let err = 0;
    for (const k of Object.keys(a)) for (let i = 0; i < 16; i++) err = Math.max(err, Math.abs(a[k].offsetMatrix[i] - b[k].offsetMatrix[i]));
    return err;
  }

  it("round-trips IWER's own point pose through world space", () => {
    for (const hand of HANDS) {
      const w = iwerPoseToWorld(pointHandPose, zero, ident, hand);
      const back = iwerPoseFromWorld(w.pos, w.rot, w.radii, zero, ident, hand);
      expect(maxMatrixError(pointHandPose.jointTransforms, back.jointTransforms)).toBeLessThan(1e-5);
      // With a non-trivial hand transform too.
      const hp: V3 = [0.25, 1.4, -0.35];
      const s = Math.sin(0.6), c = Math.cos(0.6);
      const hq: Quat = [0.3 * s, 0.8 * s, -0.52 * s, c];
      const l = Math.hypot(...hq);
      for (let i = 0; i < 4; i++) hq[i] /= l;
      const w2 = iwerPoseToWorld(pointHandPose, hp, hq, hand);
      const back2 = iwerPoseFromWorld(w2.pos, w2.rot, w2.radii, hp, hq, hand);
      expect(maxMatrixError(pointHandPose.jointTransforms, back2.jointTransforms)).toBeLessThan(1e-5);
      for (const k of Object.keys(back2.jointTransforms)) {
        expect(back2.jointTransforms[k].radius).toBe(pointHandPose.jointTransforms[k as keyof typeof pointHandPose.jointTransforms].radius);
      }
    }
  });

  it("matches IWER's world matrix = hand transform * (mirrored) offset", () => {
    const hp: V3 = [-0.2, 1.3, -0.4];
    const hq: Quat = [0, Math.sin(0.35), 0, Math.cos(0.35)];
    const H = mat4.fromRotationTranslation(mat4.create(), hq, hp);
    const S = mat4.fromScaling(mat4.create(), [-1, 1, 1]);
    for (const hand of HANDS) {
      const w = iwerPoseToWorld(pointHandPose, hp, hq, hand);
      for (const [k, jt] of Object.entries(pointHandPose.jointTransforms)) {
        const j = Object.keys(pointHandPose.jointTransforms).indexOf(k);
        let off = mat4.clone(jt.offsetMatrix as unknown as mat4);
        if (hand === 'right') off = mat4.multiply(mat4.create(), mat4.multiply(mat4.create(), S, off), S);
        const expected = mat4.multiply(mat4.create(), H, off);
        const got = matrixFromQuatPos(w.rot.slice(j * 4, j * 4 + 4), w.pos.slice(j * 3, j * 3 + 3));
        for (let i = 0; i < 16; i++) expect(Math.abs(got[i] - expected[i])).toBeLessThan(1e-5);
      }
    }
  });

  it('exports FK poses placed on a bench in the world', () => {
    const benchPos: V3 = [0.1, 0.74, -0.45];
    const benchQuat: Quat = [0, Math.sin(-0.2), 0, Math.cos(-0.2)];
    const hp: V3 = [0.2, 0.9, -0.4];
    const hq: Quat = [0, 0, 0, 1];
    for (const hand of HANDS) {
      const pose = canonicalPose('peace', hand, [0.05, 0]);
      const w = benchToWorld(pose, benchPos, benchQuat);
      // Rigid: bone lengths preserved, bench origin maps to benchPos.
      for (const [a, b] of BONES) expect(len(sub(w.pos, a, b))).toBeCloseTo(len(sub(pose.pos, a, b)), 6);
      const cfg = iwerPoseFromWorld(w.pos, w.rot, pose.radii!, hp, hq, hand);
      expect(Object.keys(cfg.jointTransforms)).toHaveLength(25);
      const back = iwerPoseToWorld(cfg, hp, hq, hand);
      for (let i = 0; i < 75; i++) expect(Math.abs(back.pos[i] - w.pos[i])).toBeLessThan(1e-6);
      for (let j = 0; j < 25; j++) {
        const d = Math.abs(dot(back.rot.slice(j * 4, j * 4 + 3) as V3, w.rot.slice(j * 4, j * 4 + 3) as V3) + back.rot[j * 4 + 3] * w.rot[j * 4 + 3]);
        expect(d).toBeGreaterThan(1 - 1e-6);
      }
    }
  });
});
