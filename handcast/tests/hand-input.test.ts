import { describe, expect, it } from 'vitest';
import { fkPose } from '../src/core/fk-hand';
import { JOINTS, KNUCKLE, TIP } from '../src/core/joints';
import { qaxis, qmul } from '../src/core/math3';
import type { Handedness } from '../src/core/types';
import {
  curledCount, fistClosed, fingerStraightness, HoldTimer, isKnock, palmUp, pinchGrabs, pluckCrossing, twistAngle,
  unwrapAngle,
} from '../src/input/gestures';
import { HandTracker25, HISTORY_FRAMES } from '../src/input/hand-tracker';
import { OneEuroFilter3 } from '../src/input/one-euro';
import { StillnessDetector } from '../src/input/stillness';

const DT = 1 / 72;

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function std(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

// ------------------------------------------------------------------ one-euro

describe('OneEuroFilter3', () => {
  it('reduces jitter on a noisy constant signal', () => {
    const r = rng(1);
    const f = new OneEuroFilter3(1);
    const x = new Float32Array(3);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 400; i++) {
      x[0] = 0.1 + (r() - 0.5) * 0.004; // +-2 mm
      x[1] = 0.2;
      x[2] = -0.1;
      f.filter(x, DT);
      if (i > 100) {
        raw.push(x[0]);
        out.push(f.value[0]);
      }
    }
    expect(std(out)).toBeLessThan(std(raw) * 0.35);
    expect(Math.abs(out[out.length - 1] - 0.1)).toBeLessThan(0.001);
  });

  it('tracks a ramp with less lag than a fixed low-pass', () => {
    const adaptive = new OneEuroFilter3(1);
    const fixed = new OneEuroFilter3(1, { beta: 0 });
    const x = new Float32Array(3);
    const v = 0.3; // m/s
    let t = 0;
    for (let i = 0; i < 90; i++) {
      t = i * DT;
      x[0] = v * t;
      adaptive.filter(x, DT);
      fixed.filter(x, DT);
    }
    const lagA = x[0] - adaptive.value[0];
    const lagF = x[0] - fixed.value[0];
    expect(lagA).toBeGreaterThan(0);
    expect(lagA).toBeLessThan(0.012);
    expect(lagA).toBeLessThan(lagF * 0.5);
  });

  it('handles variable dt, zero dt and reset', () => {
    const f = new OneEuroFilter3(2);
    const x = Float32Array.of(1, 2, 3, 4, 5, 6);
    f.filter(x, 0.01);
    expect(Array.from(f.value)).toEqual([1, 2, 3, 4, 5, 6]); // first sample snaps
    const y = Float32Array.of(2, 2, 3, 4, 5, 6);
    f.filter(y, 0); // ignored
    expect(f.value[0]).toBe(1);
    f.filter(y, 0.05);
    const a = f.value[0];
    expect(a).toBeGreaterThan(1);
    expect(a).toBeLessThan(2);
    f.filter(y, 0.2); // a long step moves further toward the input
    expect(f.value[0]).toBeGreaterThan(a);
    f.reset(Float32Array.of(9, 9, 9, 9, 9, 9));
    expect(f.value[3]).toBe(9);
    f.reset();
    f.filter(x, 0.01);
    expect(f.value[0]).toBe(1);
  });
});

// ------------------------------------------------------------------ stillness

/** Synthetic hand for the stillness detector: palm + 5 tips + normal. */
function stillFeed(
  det: StillnessDetector, frames: number,
  opts: { noise?: number; drift?: number; speed?: number; seed?: number; t0?: number; glitchAt?: number; glitch?: number; tilt?: number } = {},
): number[] {
  const r = rng(opts.seed ?? 7);
  const noise = opts.noise ?? 0.001;
  const palm = new Float32Array(3);
  const tips = new Float32Array(15);
  const normal = new Float32Array([0, -1, 0]);
  const progress: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t = (opts.t0 ?? 0) + i * DT;
    const shift = (opts.drift ?? 0) * t + (opts.speed ?? 0) * i * DT;
    const g = i === opts.glitchAt ? opts.glitch ?? 0 : 0;
    const n = () => (r() * 2 - 1) * noise;
    palm[0] = shift + n() + g;
    palm[1] = 0.04 + n();
    palm[2] = n();
    for (let f = 0; f < 5; f++) {
      tips[f * 3] = -0.04 + f * 0.02 + shift + n() + g;
      tips[f * 3 + 1] = 0.03 + n();
      tips[f * 3 + 2] = -0.09 + n();
    }
    const tilt = (opts.tilt ?? 0) * t;
    normal[0] = Math.sin(tilt);
    normal[1] = -Math.cos(tilt);
    progress.push(det.feed(palm, tips, normal, DT));
  }
  return progress;
}

describe('StillnessDetector', () => {
  it('rises to 1 within ~0.75 s on a still hand with 1 mm noise', () => {
    const det = new StillnessDetector();
    const p = stillFeed(det, 120);
    const first = p.findIndex((v) => v >= 1);
    expect(first).toBeGreaterThan(0);
    expect((first + 1) * DT).toBeLessThanOrEqual(0.76);
    expect((first + 1) * DT).toBeGreaterThan(0.65);
    expect(det.still).toBe(true);
  });

  it('does not reach 1 while drifting faster than the tolerance allows (3 cm/s)', () => {
    // A drift v deviates v * window / 2 from the window mean: 3 cm/s -> 9 mm > 7 mm.
    const det = new StillnessDetector();
    const p = stillFeed(det, 300, { drift: 0.03 });
    expect(Math.max(...p)).toBeLessThan(1);
    expect(p[p.length - 1]).toBe(0);
  });

  it('treats a slow 1 cm/s creep as still (inside the 7 mm tolerance)', () => {
    const det = new StillnessDetector();
    const p = stillFeed(det, 120, { drift: 0.01 });
    expect(p[p.length - 1]).toBe(1);
  });

  it('does not reach 1 while the palm keeps turning (20 deg/s: +-6 deg over the window)', () => {
    const det = new StillnessDetector();
    const p = stillFeed(det, 300, { tilt: (20 * Math.PI) / 180 });
    expect(Math.max(...p)).toBeLessThan(1);
  });

  it('falls gradually (not snapping to 0) when the hand moves', () => {
    const det = new StillnessDetector();
    stillFeed(det, 72);
    expect(det.progress).toBe(1);
    const p = stillFeed(det, 40, { speed: 0.3, t0: 1, seed: 9 });
    // The motion only leaves tolerance after a few frames; then ~2.86 / s.
    expect(p[0]).toBeGreaterThan(0.95);
    const i = p.findIndex((v) => v < 1);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(p[i]).toBeGreaterThan(0.9);
    expect(p[i + 7]).toBeGreaterThan(0.5); // ~0.1 s later still well above 0
    expect(p[p.length - 1]).toBeLessThan(p[i]);
  });

  it('ignores a single-frame 3 mm glitch (and even a 2 cm one)', () => {
    for (const glitch of [0.003, 0.02]) {
      const det = new StillnessDetector();
      const p = stillFeed(det, 100, { glitchAt: 30, glitch });
      for (let i = 31; i < p.length; i++) expect(p[i]).toBeGreaterThanOrEqual(p[i - 1]);
      expect(p[p.length - 1]).toBe(1);
    }
  });

  it('reset clears progress', () => {
    const det = new StillnessDetector();
    stillFeed(det, 72);
    det.reset();
    expect(det.progress).toBe(0);
    expect(det.still).toBe(false);
  });
});

// ------------------------------------------------------------------ XR mocks

class MockJointSpace {
  constructor(readonly owner: MockHand, readonly index: number) {}
}

/** A hand: joint matrices (column-major, reference space) and radii; null = pose missing. */
class MockHand extends Map<string, MockJointSpace> {
  mats: (Float32Array | null)[] = [];
  radii = new Float32Array(25).fill(0.01);
  constructor() {
    super();
    JOINTS.forEach((name, i) => this.set(name, new MockJointSpace(this, i)));
  }
  /** Set joint matrices from positions (25 x 3) and quaternions (25 x 4). */
  setPose(pos: ArrayLike<number>, rot: ArrayLike<number>): void {
    for (let j = 0; j < 25; j++) {
      this.mats[j] = matFrom(rot, j * 4, pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
    }
  }
}

function mockSource(handedness: Handedness, hand: MockHand) {
  return { handedness, hand };
}

function mockFrame(
  inputSources: unknown[],
  trackedSources: unknown[] | undefined,
  mode: 'fill' | 'getJointPose' = 'fill',
) {
  const session = { inputSources, trackedSources };
  const frame: Record<string, unknown> = { session };
  if (mode === 'fill') {
    frame.fillPoses = (spaces: MockJointSpace[], _ref: unknown, out: Float32Array) => {
      let ok = true;
      spaces.forEach((s, i) => {
        const m = s.owner.mats[s.index];
        if (!m) ok = false;
        else out.set(m, i * 16);
      });
      return ok;
    };
    frame.fillJointRadii = (spaces: MockJointSpace[], out: Float32Array) => {
      spaces.forEach((s, i) => (out[i] = s.owner.radii[s.index]));
      return true;
    };
  } else {
    frame.getJointPose = (s: MockJointSpace) => {
      const m = s.owner.mats[s.index];
      return m ? { transform: { matrix: m }, radius: s.owner.radii[s.index] } : undefined;
    };
  }
  return frame as unknown as XRFrame;
}

const REF = {} as XRReferenceSpace;

/** Column-major 4x4 from quaternion (q[qi..]) and translation. */
function matFrom(q: ArrayLike<number>, qi: number, tx: number, ty: number, tz: number): Float32Array {
  const x = q[qi], y = q[qi + 1], z = q[qi + 2], w = q[qi + 3];
  return Float32Array.of(
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    tx, ty, tz, 1,
  );
}

function yaw(a: number): number[] {
  const q = [0, 0, 0, 1];
  qaxis(q, 0, 0, 1, 0, a);
  return q;
}

const IDENTITY = matFrom([0, 0, 0, 1], 0, 0, 0, 0);

function flatHand(hand: Handedness = 'right') {
  const p = fkPose({ hand, curl: [0, 0, 0, 0, 0], at: [0, 0] });
  return { pos: Float32Array.from(p.pos), rot: Float32Array.from(p.rot!) };
}

function quatClose(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number, eps = 1e-4): boolean {
  const d = Math.abs(a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3]);
  return 1 - d < eps;
}

// ------------------------------------------------------------------ tracker

describe('HandTracker25', () => {
  it('tracks a hand and transforms joints by the origin and worldToBench matrices', () => {
    const { pos, rot } = flatHand();
    const right = new MockHand();
    right.setPose(pos, rot);
    // XR origin: yawed 90 deg, at (1, 0, 2). Bench anchor: yawed 30 deg at (0.5, 0.8, -0.3).
    const a = Math.PI / 2, c = Math.PI / 6;
    const origin = matFrom(yaw(a), 0, 1, 0, 2);
    // worldToBench = inverse(bench) = R(-c) * T(-b)
    const inv = matFrom(yaw(-c), 0, 0, 0, 0);
    const bx = 0.5, by = 0.8, bz = -0.3;
    inv[12] = -(inv[0] * bx + inv[4] * by + inv[8] * bz);
    inv[13] = -(inv[1] * bx + inv[5] * by + inv[9] * bz);
    inv[14] = -(inv[2] * bx + inv[6] * by + inv[10] * bz);

    const tr = new HandTracker25();
    tr.update(mockFrame([mockSource('right', right)], undefined), REF, origin, inv, DT);
    expect(tr.right.tracked).toBe(true);
    expect(tr.left.tracked).toBe(false);

    const rotY = (ang: number, x: number, y: number, z: number) =>
      [Math.cos(ang) * x + Math.sin(ang) * z, y, -Math.sin(ang) * x + Math.cos(ang) * z];
    for (const j of [0, 4, 9, 24]) {
      const [px, py, pz] = [pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]];
      const w = rotY(a, px, py, pz);
      const world = [w[0] + 1, w[1], w[2] + 2];
      for (let k = 0; k < 3; k++) expect(tr.right.posWorld[j * 3 + k]).toBeCloseTo(world[k], 5);
      const b = rotY(-c, world[0] - bx, world[1] - by, world[2] - bz);
      for (let k = 0; k < 3; k++) {
        expect(tr.right.rawBench[j * 3 + k]).toBeCloseTo(b[k], 5);
        expect(tr.right.posBench[j * 3 + k]).toBeCloseTo(b[k], 5); // first frame snaps
      }
      const qw = [0, 0, 0, 0];
      qmul(qw, 0, yaw(a), 0, rot, j * 4);
      expect(quatClose(tr.right.rotWorld, j * 4, qw, 0)).toBe(true);
      const qb = [0, 0, 0, 0];
      qmul(qb, 0, yaw(a - c), 0, rot, j * 4);
      expect(quatClose(tr.right.rawRotBench, j * 4, qb, 0)).toBe(true);
      expect(quatClose(tr.right.rotBench, j * 4, qb, 0)).toBe(true);
    }
    expect(tr.right.radii[0]).toBeCloseTo(0.01, 6);
  });

  it('computes the palm frame: palm-down normal is -Y for both hands', () => {
    for (const hand of ['left', 'right'] as const) {
      const { pos, rot } = flatHand(hand);
      const mh = new MockHand();
      mh.setPose(pos, rot);
      const tr = new HandTracker25();
      tr.update(mockFrame([mockSource(hand, mh)], undefined), REF, IDENTITY, IDENTITY, DT);
      const h = tr[hand];
      expect(h.tracked).toBe(true);
      expect(h.palm.normal[1]).toBeLessThan(-0.95);
      expect(h.palm.axis[2]).toBeLessThan(-0.95);
      expect(h.palm.center[0]).toBeCloseTo((pos[0] + pos[KNUCKLE[2] * 3]) / 2, 5);
    }
  });

  it('applies pinch hysteresis on the thumb / index tip distance', () => {
    const { pos, rot } = flatHand();
    const mh = new MockHand();
    const tr = new HandTracker25();
    const frame = mockFrame([mockSource('right', mh)], undefined);
    const T = TIP[0] * 3, I = TIP[1] * 3;
    const step = (d: number) => {
      pos[I] = pos[T] + d;
      pos[I + 1] = pos[T + 1];
      pos[I + 2] = pos[T + 2];
      mh.setPose(pos, rot);
      tr.update(frame, REF, IDENTITY, IDENTITY, DT);
      return { ...tr.right.pinch };
    };
    expect(step(0.05).active).toBe(false);
    const on = step(0.015);
    expect(on.active && on.started).toBe(true);
    expect(on.strength).toBe(1);
    const hold = step(0.025);
    expect(hold.active).toBe(true);
    expect(hold.started).toBe(false);
    const off = step(0.035);
    expect(off.active).toBe(false);
    expect(off.ended).toBe(true);
    expect(step(0.025).active).toBe(false); // needs < 0.018 to re-engage
    // Pinch point is the midpoint of the tips.
    expect(tr.right.pinch.point[1]).toBeCloseTo(pos[T + 1], 4);
  });

  it('averages the last n raw frames in snapshot()', () => {
    const { pos, rot } = flatHand();
    const mh = new MockHand();
    const tr = new HandTracker25();
    const frame = mockFrame([mockSource('right', mh)], undefined);
    const p = Float32Array.from(pos);
    const r = Float32Array.from(rot);
    const tilt = [0, 0, 0, 0];
    for (let k = 0; k < HISTORY_FRAMES + 3; k++) {
      // Positions offset by k mm in x; orientations alternate +-10 deg about Y.
      for (let j = 0; j < 25; j++) p[j * 3] = pos[j * 3] + k * 0.001;
      for (let j = 0; j < 25; j++) {
        qmul(tilt, 0, yaw((k % 2 ? 1 : -1) * 0.1745), 0, rot, j * 4);
        r.set(tilt, j * 4);
      }
      mh.setPose(p, r);
      tr.update(frame, REF, IDENTITY, IDENTITY, DT);
    }
    const last = HISTORY_FRAMES + 2;
    const snap = tr.right.snapshot(4);
    expect(snap.hand).toBe('right');
    for (const j of [0, 9, 24]) {
      expect(snap.pos[j * 3]).toBeCloseTo(pos[j * 3] + (last - 1.5) * 0.001, 5);
      expect(snap.pos[j * 3 + 1]).toBeCloseTo(pos[j * 3 + 1], 5);
      expect(quatClose(snap.rot, j * 4, rot, j * 4, 1e-5)).toBe(true); // +-10 deg average out
    }
    // Asking for more frames than kept uses the whole ring.
    const all = tr.right.snapshot(50);
    expect(all.pos[0]).toBeCloseTo(pos[0] + (last - (HISTORY_FRAMES - 1) / 2) * 0.001, 5);
    // Snapshots are independent copies.
    expect(snap.pos).not.toBe(tr.right.posBench);
    expect(tr.right.toPose().pos).toBe(tr.right.posBench);
  });

  it('marks the hand untracked when a joint pose is missing, keeping the last good data', () => {
    const { pos, rot } = flatHand();
    const mh = new MockHand();
    mh.setPose(pos, rot);
    const tr = new HandTracker25();
    for (const mode of ['fill', 'getJointPose'] as const) {
      const frame = mockFrame([mockSource('right', mh)], undefined, mode);
      mh.setPose(pos, rot);
      tr.update(frame, REF, IDENTITY, IDENTITY, DT);
      expect(tr.right.tracked).toBe(true);
      const before = Float32Array.from(tr.right.posBench);
      mh.mats[13] = null;
      tr.update(frame, REF, IDENTITY, IDENTITY, DT);
      expect(tr.right.tracked).toBe(false);
      expect(Array.from(tr.right.posBench)).toEqual(Array.from(before));
    }
    // No frame at all: both hands untracked.
    tr.update(null, REF, IDENTITY, IDENTITY, DT);
    expect(tr.right.tracked || tr.left.tracked).toBe(false);
  });

  it('ends an active pinch when tracking is lost', () => {
    const { pos, rot } = flatHand();
    const T = TIP[0] * 3, I = TIP[1] * 3;
    pos[I] = pos[T] + 0.01; pos[I + 1] = pos[T + 1]; pos[I + 2] = pos[T + 2];
    const mh = new MockHand();
    mh.setPose(pos, rot);
    const tr = new HandTracker25();
    const frame = mockFrame([mockSource('right', mh)], undefined);
    tr.update(frame, REF, IDENTITY, IDENTITY, DT);
    expect(tr.right.pinch.active).toBe(true);
    tr.update(mockFrame([], undefined), REF, IDENTITY, IDENTITY, DT);
    expect(tr.right.tracked).toBe(false);
    expect(tr.right.pinch.active).toBe(false);
    expect(tr.right.pinch.ended).toBe(true);
    tr.update(mockFrame([], undefined), REF, IDENTITY, IDENTITY, DT);
    expect(tr.right.pinch.ended).toBe(false);
  });

  it('takes the first source when the same hand appears twice', () => {
    const { pos, rot } = flatHand();
    const first = new MockHand();
    first.setPose(pos, rot);
    const moved = Float32Array.from(pos);
    for (let j = 0; j < 25; j++) moved[j * 3 + 1] += 0.5;
    const dupe = new MockHand();
    dupe.setPose(moved, rot);
    const tr = new HandTracker25();
    tr.update(
      mockFrame([mockSource('right', first)], [mockSource('right', dupe)]),
      REF, IDENTITY, IDENTITY, DT,
    );
    expect(tr.right.rawBench[1]).toBeCloseTo(pos[1], 5);
    // Hand only present in trackedSources is still picked up.
    tr.update(mockFrame([], [mockSource('right', dupe)]), REF, IDENTITY, IDENTITY, DT);
    expect(tr.right.tracked).toBe(true);
    expect(tr.right.rawBench[1]).toBeCloseTo(moved[1], 5);
  });

  it('filters jitter, measures knuckle speed and feeds stillness', () => {
    const { pos, rot } = flatHand();
    const mh = new MockHand();
    const tr = new HandTracker25();
    const frame = mockFrame([mockSource('right', mh)], undefined);
    const r = rng(3);
    const p = Float32Array.from(pos);
    let maxStill = 0;
    for (let i = 0; i < 80; i++) {
      for (let k = 0; k < 75; k++) p[k] = pos[k] + (r() - 0.5) * 0.002;
      mh.setPose(p, rot);
      tr.update(frame, REF, IDENTITY, IDENTITY, DT);
      maxStill = Math.max(maxStill, tr.right.stillness.progress);
    }
    expect(maxStill).toBe(1);
    expect(tr.right.speed.knuckle[2]).toBeLessThan(0.2);
    // Knock: whole hand moving down at 1 m/s for a few frames.
    for (let i = 1; i <= 6; i++) {
      for (let k = 0; k < 75; k++) p[k] = pos[k] - (k % 3 === 1 ? i * DT : 0);
      mh.setPose(p, rot);
      tr.update(frame, REF, IDENTITY, IDENTITY, DT);
    }
    expect(tr.right.speed.knuckle[2]).toBeGreaterThan(0.6);
    expect(tr.right.speed.knuckleVel[2 * 3 + 1]).toBeLessThan(-0.6);
    expect(tr.right.stillness.progress).toBeLessThan(1);
  });
});

// ------------------------------------------------------------------ gestures

describe('gestures', () => {
  it('twistAngle measures rotation about an axis and ignores swing', () => {
    const start = yaw(0.3);
    const now = [0, 0, 0, 0];
    qmul(now, 0, yaw(0.5), 0, start, 0);
    expect(twistAngle(start, now, [0, 1, 0])).toBeCloseTo(0.5, 5);
    expect(twistAngle(now, start, [0, 1, 0])).toBeCloseTo(-0.5, 5);
    // Add a swing about X: twist about Y stays ~the same for small swings.
    const swing = [0, 0, 0, 0];
    qaxis(swing, 0, 1, 0, 0, 0.2);
    const both = [0, 0, 0, 0];
    qmul(both, 0, swing, 0, now, 0);
    expect(Math.abs(twistAngle(start, both, [0, 1, 0]) - 0.5)).toBeLessThan(0.05);
    // Accepts three.js-like objects; result wrapped to (-PI, PI].
    const big = yaw(3.5);
    const t = twistAngle({ x: 0, y: 0, z: 0, w: 1 }, { x: big[0], y: big[1], z: big[2], w: big[3] }, { x: 0, y: 1, z: 0 });
    expect(t).toBeCloseTo(3.5 - 2 * Math.PI, 5);
    expect(unwrapAngle(3.0, t)).toBeCloseTo(3.5, 5);
    // q and -q give the same twist.
    expect(twistAngle(start, now.map((v) => -v), [0, 1, 0])).toBeCloseTo(0.5, 5);
  });

  it('detects a fist and a knock', () => {
    const open = fkPose({ hand: 'right', curl: [0, 0, 0, 0, 0], at: [0, 0] }).pos;
    const fist = fkPose({ hand: 'right', curl: [1, 1, 1, 1, 1], at: [0, 0] }).pos;
    const point = fkPose({ hand: 'right', curl: [1, 0, 1, 1, 1], at: [0, 0] }).pos;
    expect(fingerStraightness(open, 1)).toBeCloseTo(1, 2);
    expect(fistClosed(open)).toBe(false);
    expect(fistClosed(fist)).toBe(true);
    expect(fistClosed(point)).toBe(false);
    expect(curledCount(point)).toBe(3);
    const slow = [0, 0.2, 0.3, 0.2, 0.1];
    const fast = [0, 0.5, 0.9, 0.7, 0.4];
    expect(isKnock(fist, slow)).toBe(false);
    expect(isKnock(fist, fast)).toBe(true);
    expect(isKnock(open, fast)).toBe(false);
  });

  it('palm-up menu pose needs 0.4 s of hold', () => {
    const timer = new HoldTimer(0.4);
    const up = [0, 0.95, 0.1];
    let fired = 0;
    for (let i = 0; i < 27; i++) {
      timer.update(palmUp(up), DT);
      if (timer.fired) fired++;
    }
    expect(timer.active).toBe(false); // 27 frames = 0.375 s
    for (let i = 0; i < 40; i++) {
      timer.update(palmUp(up), DT);
      if (timer.fired) fired++;
    }
    expect(timer.active).toBe(true);
    expect(fired).toBe(1);
    timer.update(palmUp([0, 0.5, 0.8]), DT);
    expect(timer.active).toBe(false);
    expect(timer.progress).toBe(0);
  });

  it('pinch grabs a cast foot only nearby', () => {
    expect(pinchGrabs(true, [0.1, 0.03, 0.05], [0.11, 0.04], 0.03)).toBe(true);
    expect(pinchGrabs(true, [0.2, 0.03, 0.05], [0.11, 0.04], 0.03)).toBe(false);
    expect(pinchGrabs(false, [0.1, 0.03, 0.05], [0.11, 0.04], 0.03)).toBe(false);
    expect(pinchGrabs(true, [0.11, 0.2, 0.04], [0.11, 0.04], 0.03)).toBe(false); // far above
  });

  it('detects a pluck crossing a glass finger and its speed', () => {
    // Tine along -Z at height 0.03, x = 0; tip sweeps along +X through it.
    const a = [0, 0.03, 0], b = [0, 0.03, -0.06];
    const prev = [-0.012, 0.03, -0.03], now = [0.012, 0.03, -0.03];
    const s = pluckCrossing(prev, 0, now, 0, a, 0, b, 0, 0.008, DT);
    expect(s).toBeCloseTo(0.024 / DT, 3);
    // Moving along the tine (no crossing) or missing it: 0.
    expect(pluckCrossing([0.02, 0.03, 0], 0, [0.02, 0.03, -0.05], 0, a, 0, b, 0, 0.008, DT)).toBe(0);
    // Starting inside the tine: no new pluck.
    expect(pluckCrossing([0.002, 0.03, -0.03], 0, now, 0, a, 0, b, 0, 0.008, DT)).toBe(0);
  });
});
