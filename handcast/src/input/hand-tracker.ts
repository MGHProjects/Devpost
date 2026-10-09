/**
 * Live 25-joint hand tracking for HANDCAST. Each frame reads every WebXR hand
 * joint (fillPoses / fillJointRadii when the browser has them, per-joint
 * getJointPose otherwise), moves it from the session reference space into
 * world space (XR origin matrix) and then into bench space, and derives what
 * the game needs: One-Euro filtered positions, slerp-smoothed orientations,
 * pinch with hysteresis, palm frame, knuckle / tip speeds, a short history
 * for jitter-free cast snapshots and the hold-still detector.
 *
 * Everything is preallocated; update() does not allocate (except whatever the
 * browser allocates inside getJointPose on the fallback path, and a one-off
 * joint-space table when a new XRHand object appears).
 */

import { DEFAULT_RADII } from '../core/hand-bind';
import { JOINTS, JOINT_COUNT, KNUCKLE, TIP } from '../core/joints';
import { qfromBasis, qmul } from '../core/math3';
import type { Handedness, HandPose } from '../core/types';
import { OneEuroFilter3, type OneEuroOptions } from './one-euro';
import { StillnessDetector, type StillnessOptions } from './stillness';

/** Pinch hysteresis on the thumb-tip / index-tip distance (m). */
export const PINCH_ON = 0.018;
export const PINCH_OFF = 0.032;
/** Frames kept for snapshot averaging. */
export const HISTORY_FRAMES = 12;

const THUMB_TIP = TIP[0];
const INDEX_TIP = TIP[1];
const WRIST = 0;
const MIDDLE_KNUCKLE = KNUCKLE[2];

export interface HandTrackerOptions {
  /** Position filter (bench space, metres). */
  euro?: OneEuroOptions;
  /** Rotation smoothing cutoff at rest (Hz). */
  rotMinCutoff?: number;
  /** Extra rotation cutoff (Hz) per radian of error between smoothed and raw. */
  rotGain?: number;
  /** Time constant (s) of the low-pass on knuckle / tip velocities. */
  speedTau?: number;
  stillness?: StillnessOptions;
}

/** Browser extensions to XRFrame not in @types/webxr. */
interface XRFrameFill {
  fillPoses?(spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array): boolean;
  fillJointRadii?(jointSpaces: XRJointSpace[], radii: Float32Array): boolean;
  getJointPose?(joint: XRJointSpace, baseSpace: XRSpace): XRJointPose | undefined;
}

export interface PinchState {
  /** Pinch held (hysteresis). */
  active: boolean;
  /** Became active this frame. */
  started: boolean;
  /** Released this frame (including tracking loss while pinching). */
  ended: boolean;
  /** Filtered midpoint of thumb and index tips, bench space. */
  readonly point: Float32Array;
  /** 0 open .. 1 touching. */
  strength: number;
  /** Raw thumb-tip / index-tip distance (m). */
  distance: number;
}

export interface PalmState {
  /** (wrist + middle knuckle) / 2, filtered, bench space. */
  readonly center: Float32Array;
  /** Unit normal out of the palm (palm down ~ (0, -1, 0) for both hands). */
  readonly normal: Float32Array;
  /** Unit hand axis, wrist -> middle knuckle. */
  readonly axis: Float32Array;
}

export interface SpeedState {
  /** Speed (m/s) of each finger's knuckle (KNUCKLE order: thumb..pinky). */
  readonly knuckle: Float32Array;
  /** Speed (m/s) of each fingertip. */
  readonly tip: Float32Array;
  /** Velocity vectors (5 x 3, m/s, bench space). */
  readonly knuckleVel: Float32Array;
  readonly tipVel: Float32Array;
  /** Palm centre velocity (m/s, bench space) and speed. */
  readonly palmVel: Float32Array;
  palm: number;
}

/** One tracked hand. All buffers are allocated once and updated in place. */
export class TrackedHand {
  readonly hand: Handedness;
  tracked = false;
  /** Seconds since tracking was (re)acquired. */
  trackedTime = 0;
  /** Raw joint positions / orientations in world space. */
  readonly posWorld = new Float32Array(75);
  readonly rotWorld = new Float32Array(100);
  /** Joint radii (m); defaults until the browser reports them. */
  readonly radii = Float32Array.from(DEFAULT_RADII);
  /** One-Euro filtered positions, bench space. */
  readonly posBench = new Float32Array(75);
  /** Slerp-smoothed orientations, bench space. */
  readonly rotBench = new Float32Array(100);
  /** Unfiltered positions / orientations, bench space. */
  readonly rawBench = new Float32Array(75);
  readonly rawRotBench = new Float32Array(100);
  readonly pinch: PinchState = {
    active: false, started: false, ended: false, point: new Float32Array(3), strength: 0, distance: 1,
  };
  readonly palm: PalmState = { center: new Float32Array(3), normal: new Float32Array(3), axis: new Float32Array(3) };
  readonly speed: SpeedState = {
    knuckle: new Float32Array(5), tip: new Float32Array(5),
    knuckleVel: new Float32Array(15), tipVel: new Float32Array(15),
    palmVel: new Float32Array(3), palm: 0,
  };
  /** Ring of the last HISTORY_FRAMES raw bench poses (positions, orientations). */
  readonly history = {
    pos: new Float32Array(HISTORY_FRAMES * 75),
    rot: new Float32Array(HISTORY_FRAMES * 100),
    /** Next write slot. */
    head: 0,
    count: 0,
  };
  readonly stillness: StillnessDetector;

  /** @internal filters and scratch */
  readonly euro: OneEuroFilter3;
  private readonly rotMinCutoff: number;
  private readonly rotGain: number;
  private readonly speedTau: number;
  private readonly prevRaw = new Float32Array(75);
  private readonly prevCenter = new Float32Array(3);
  private readonly tipsScratch = new Float32Array(15);
  private readonly livePose: HandPose;
  /** XRHand whose joint spaces are cached in `spaces`. */
  private xrHand: XRHand | null = null;
  private spaces: XRJointSpace[] = [];

  constructor(hand: Handedness, opts: HandTrackerOptions = {}) {
    this.hand = hand;
    this.euro = new OneEuroFilter3(JOINT_COUNT, opts.euro);
    this.rotMinCutoff = opts.rotMinCutoff ?? 2;
    this.rotGain = opts.rotGain ?? 40;
    this.speedTau = opts.speedTau ?? 0.02;
    this.stillness = new StillnessDetector(opts.stillness);
    for (let j = 0; j < JOINT_COUNT; j++) {
      this.rotWorld[j * 4 + 3] = 1;
      this.rotBench[j * 4 + 3] = 1;
      this.rawRotBench[j * 4 + 3] = 1;
    }
    this.palm.normal[1] = -1;
    this.palm.axis[2] = -1;
    this.livePose = { hand, pos: this.posBench, rot: this.rotBench, radii: this.radii };
  }

  /**
   * The current filtered pose. Not a copy: its arrays are this hand's live
   * buffers (posBench, rotBench, radii) and change every frame.
   */
  toPose(): HandPose {
    return this.livePose;
  }

  /**
   * A frozen pose (fresh arrays) averaged over the last `nFrames` raw frames:
   * positions averaged, orientations by normalised quaternion lerp. Use when
   * casting; it removes tracking jitter without filter lag.
   */
  snapshot(nFrames = 8): HandPose & { pos: Float32Array; rot: Float32Array; radii: Float32Array } {
    const out = { hand: this.hand, pos: new Float32Array(75), rot: new Float32Array(100), radii: new Float32Array(25) };
    this.snapshotInto(out, nFrames);
    return out;
  }

  /** snapshot() into caller-owned buffers (pos 75, rot 100, radii 25). */
  snapshotInto(out: { pos: Float32Array | number[]; rot?: Float32Array | number[]; radii?: Float32Array | number[] }, nFrames = 8): void {
    const h = this.history;
    const n = Math.min(Math.max(1, nFrames | 0), h.count);
    if (out.radii) for (let j = 0; j < 25; j++) out.radii[j] = this.radii[j];
    if (n === 0) {
      for (let i = 0; i < 75; i++) out.pos[i] = this.posBench[i];
      if (out.rot) for (let i = 0; i < 100; i++) out.rot[i] = this.rotBench[i];
      return;
    }
    const newest = (h.head - 1 + HISTORY_FRAMES) % HISTORY_FRAMES;
    for (let i = 0; i < 75; i++) {
      let s = 0;
      for (let k = 0, slot = newest; k < n; k++, slot = slot === 0 ? HISTORY_FRAMES - 1 : slot - 1) s += h.pos[slot * 75 + i];
      out.pos[i] = s / n;
    }
    const rot = out.rot;
    if (!rot) return;
    for (let j = 0; j < 25; j++) {
      const r0 = newest * 100 + j * 4;
      let x = 0, y = 0, z = 0, w = 0;
      for (let k = 0, slot = newest; k < n; k++, slot = slot === 0 ? HISTORY_FRAMES - 1 : slot - 1) {
        const r = slot * 100 + j * 4;
        // Align to the newest sample's hemisphere (q and -q are the same rotation).
        const sgn = h.rot[r] * h.rot[r0] + h.rot[r + 1] * h.rot[r0 + 1] + h.rot[r + 2] * h.rot[r0 + 2] + h.rot[r + 3] * h.rot[r0 + 3] < 0 ? -1 : 1;
        x += sgn * h.rot[r];
        y += sgn * h.rot[r + 1];
        z += sgn * h.rot[r + 2];
        w += sgn * h.rot[r + 3];
      }
      const l = Math.hypot(x, y, z, w) || 1;
      rot[j * 4] = x / l;
      rot[j * 4 + 1] = y / l;
      rot[j * 4 + 2] = z / l;
      rot[j * 4 + 3] = w / l;
    }
  }

  /** @internal Joint spaces of `hand` in JOINTS order, or null if any is missing. */
  jointSpaces(hand: XRHand): XRJointSpace[] | null {
    if (hand !== this.xrHand) {
      const spaces: XRJointSpace[] = [];
      for (let j = 0; j < JOINT_COUNT; j++) {
        const s = hand.get(JOINTS[j] as XRHandJoint);
        if (!s) return null;
        spaces.push(s);
      }
      this.xrHand = hand;
      this.spaces = spaces;
    }
    return this.spaces;
  }

  /** @internal Called by HandTracker25 after rawBench / rawRotBench / posWorld / rotWorld were written. */
  ingest(dt: number): void {
    const reacquired = !this.tracked;
    this.tracked = true;
    this.pinch.started = false;
    this.pinch.ended = false;
    if (reacquired) {
      this.trackedTime = 0;
      this.euro.reset(this.rawBench);
      this.posBench.set(this.euro.value);
      this.rotBench.set(this.rawRotBench);
      this.history.count = 0;
      this.history.head = 0;
      this.stillness.reset();
      this.prevRaw.set(this.rawBench);
      this.speed.knuckle.fill(0);
      this.speed.tip.fill(0);
      this.speed.knuckleVel.fill(0);
      this.speed.tipVel.fill(0);
      this.speed.palmVel.fill(0);
      this.speed.palm = 0;
    } else {
      this.trackedTime += dt > 0 ? dt : 0;
      this.posBench.set(this.euro.filter(this.rawBench, dt));
      this.smoothRotations(dt);
    }
    this.pushHistory();
    this.updatePalm();
    this.updatePinch();
    if (!reacquired) this.updateSpeeds(dt);
    else this.prevCenter.set(this.palm.center);
    const tips = this.tipsScratch;
    for (let f = 0; f < 5; f++) {
      const t = TIP[f] * 3;
      tips[f * 3] = this.posBench[t];
      tips[f * 3 + 1] = this.posBench[t + 1];
      tips[f * 3 + 2] = this.posBench[t + 2];
    }
    this.stillness.feed(this.palm.center, tips, this.palm.normal, dt);
  }

  /** @internal Tracking lost this frame: keep the last good data, end any pinch. */
  lose(): void {
    this.pinch.started = false;
    this.pinch.ended = this.pinch.active;
    if (!this.tracked) return;
    this.tracked = false;
    this.pinch.active = false;
    this.pinch.strength = 0;
    this.stillness.reset();
    this.speed.knuckle.fill(0);
    this.speed.tip.fill(0);
    this.speed.knuckleVel.fill(0);
    this.speed.tipVel.fill(0);
    this.speed.palmVel.fill(0);
    this.speed.palm = 0;
  }

  private pushHistory(): void {
    const h = this.history;
    h.pos.set(this.rawBench, h.head * 75);
    h.rot.set(this.rawRotBench, h.head * 100);
    h.head = (h.head + 1) % HISTORY_FRAMES;
    if (h.count < HISTORY_FRAMES) h.count++;
  }

  private smoothRotations(dt: number): void {
    if (!(dt > 0)) return;
    const s = this.rotBench;
    const r = this.rawRotBench;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const i = j * 4;
      let d = s[i] * r[i] + s[i + 1] * r[i + 1] + s[i + 2] * r[i + 2] + s[i + 3] * r[i + 3];
      const sgn = d < 0 ? -1 : 1;
      d *= sgn;
      const err = 2 * Math.acos(d > 1 ? 1 : d);
      const fc = this.rotMinCutoff + this.rotGain * err;
      const t = 1 - Math.exp(-2 * Math.PI * fc * dt);
      slerpToward(s, i, r, sgn, d, t);
    }
  }

  private updatePalm(): void {
    const p = this.posBench;
    const c = this.palm.center;
    const w = WRIST * 3, m = MIDDLE_KNUCKLE * 3, ki = KNUCKLE[1] * 3, kp = KNUCKLE[4] * 3;
    c[0] = (p[w] + p[m]) / 2;
    c[1] = (p[w + 1] + p[m + 1]) / 2;
    c[2] = (p[w + 2] + p[m + 2]) / 2;
    const ux = p[ki] - p[w], uy = p[ki + 1] - p[w + 1], uz = p[ki + 2] - p[w + 2];
    const vx = p[kp] - p[w], vy = p[kp + 1] - p[w + 1], vz = p[kp + 2] - p[w + 2];
    // (K_index - W) x (K_pinky - W) points out of the palm for a right hand; mirror for the left.
    const sgn = this.hand === 'left' ? -1 : 1;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 1e-9) {
      nx *= sgn / nl; ny *= sgn / nl; nz *= sgn / nl;
      this.palm.normal[0] = nx;
      this.palm.normal[1] = ny;
      this.palm.normal[2] = nz;
    }
    const ax = p[m] - p[w], ay = p[m + 1] - p[w + 1], az = p[m + 2] - p[w + 2];
    const al = Math.hypot(ax, ay, az);
    if (al > 1e-9) {
      this.palm.axis[0] = ax / al;
      this.palm.axis[1] = ay / al;
      this.palm.axis[2] = az / al;
    }
  }

  private updatePinch(): void {
    const r = this.rawBench, p = this.posBench, pin = this.pinch;
    const t = THUMB_TIP * 3, i = INDEX_TIP * 3;
    const d = Math.hypot(r[t] - r[i], r[t + 1] - r[i + 1], r[t + 2] - r[i + 2]);
    pin.distance = d;
    const s = (PINCH_OFF + 0.02 - d) / (PINCH_OFF + 0.02 - PINCH_ON);
    pin.strength = s < 0 ? 0 : s > 1 ? 1 : s;
    pin.point[0] = (p[t] + p[i]) / 2;
    pin.point[1] = (p[t + 1] + p[i + 1]) / 2;
    pin.point[2] = (p[t + 2] + p[i + 2]) / 2;
    if (!pin.active && d < PINCH_ON) {
      pin.active = true;
      pin.started = true;
    } else if (pin.active && d > PINCH_OFF) {
      pin.active = false;
      pin.ended = true;
    }
  }

  /** Raw finite differences, low-passed (tau = speedTau) so a knock peak survives but jitter does not. */
  private updateSpeeds(dt: number): void {
    if (!(dt > 0)) return;
    const a = dt / (dt + this.speedTau);
    const raw = this.rawBench, prev = this.prevRaw, sp = this.speed;
    for (let f = 0; f < 5; f++) {
      sp.knuckle[f] = lowpassVel(sp.knuckleVel, f * 3, raw, prev, KNUCKLE[f] * 3, dt, a);
      sp.tip[f] = lowpassVel(sp.tipVel, f * 3, raw, prev, TIP[f] * 3, dt, a);
    }
    sp.palm = lowpassVel(sp.palmVel, 0, this.palm.center, this.prevCenter, 0, dt, a);
    prev.set(raw);
    this.prevCenter.set(this.palm.center);
  }
}

/** v[vi..] += a * ((x - prev) / dt - v); returns |v|. */
function lowpassVel(v: Float32Array, vi: number, x: Float32Array, prev: Float32Array, xi: number, dt: number, a: number): number {
  let s2 = 0;
  for (let k = 0; k < 3; k++) {
    const d = (x[xi + k] - prev[xi + k]) / dt;
    const nv = v[vi + k] + a * (d - v[vi + k]);
    v[vi + k] = nv;
    s2 += nv * nv;
  }
  return Math.sqrt(s2);
}

/**
 * s[i..] = slerp(s, sgn * r, t) in place, where `cos` = |dot(s, r)| (already
 * hemisphere-aligned by `sgn`).
 */
function slerpToward(s: Float32Array, i: number, r: Float32Array, sgn: number, cos: number, t: number): void {
  let ws: number, wr: number;
  if (cos > 0.9995) {
    ws = 1 - t;
    wr = t;
  } else {
    const th = Math.acos(cos);
    const sin = Math.sin(th);
    ws = Math.sin((1 - t) * th) / sin;
    wr = Math.sin(t * th) / sin;
  }
  wr *= sgn;
  const x = ws * s[i] + wr * r[i];
  const y = ws * s[i + 1] + wr * r[i + 1];
  const z = ws * s[i + 2] + wr * r[i + 2];
  const w = ws * s[i + 3] + wr * r[i + 3];
  const l = Math.hypot(x, y, z, w) || 1;
  s[i] = x / l;
  s[i + 1] = y / l;
  s[i + 2] = z / l;
  s[i + 3] = w / l;
}

// --------------------------------------------------------------- matrices
// Column-major 4x4 (WebXR / three.js layout).

function m4mul(o: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

/** Rotation part of a rigid (optionally uniformly scaled) matrix as a quaternion. */
function quatOfMatrix(o: Float64Array | Float32Array, oi: number, m: ArrayLike<number>, mi: number): void {
  const sx = Math.hypot(m[mi], m[mi + 1], m[mi + 2]) || 1;
  const sy = Math.hypot(m[mi + 4], m[mi + 5], m[mi + 6]) || 1;
  const sz = Math.hypot(m[mi + 8], m[mi + 9], m[mi + 10]) || 1;
  qfromBasis(
    o, oi,
    m[mi] / sx, m[mi + 1] / sx, m[mi + 2] / sx,
    m[mi + 4] / sy, m[mi + 5] / sy, m[mi + 6] / sy,
    m[mi + 8] / sz, m[mi + 9] / sz, m[mi + 10] / sz,
  );
}

/** o[oi..] = m * (x, y, z, 1). */
function m4point(o: Float32Array, oi: number, m: ArrayLike<number>, x: number, y: number, z: number): void {
  o[oi] = m[0] * x + m[4] * y + m[8] * z + m[12];
  o[oi + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  o[oi + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

// ---------------------------------------------------------------- tracker

/** Both hands. Call update() once per XR frame. */
export class HandTracker25 {
  readonly left: TrackedHand;
  readonly right: TrackedHand;
  readonly hands: readonly TrackedHand[];

  /** 25 joint matrices from fillPoses / getJointPose (reference space). */
  private readonly poseBuf = new Float32Array(JOINT_COUNT * 16);
  private readonly radiiBuf = new Float32Array(JOINT_COUNT);
  /** worldToBench * originWorld. */
  private readonly toBench = new Float64Array(16);
  private readonly qOrigin = new Float64Array(4);
  private readonly qBench = new Float64Array(4);
  private readonly qJoint = new Float64Array(4);
  private readonly qTmp = new Float64Array(4);

  constructor(opts: HandTrackerOptions = {}) {
    this.left = new TrackedHand('left', opts);
    this.right = new TrackedHand('right', opts);
    this.hands = [this.left, this.right];
  }

  /**
   * Sample both hands. `originWorld` is the XR origin's world matrix (joint
   * poses come in the session reference space), `worldToBench` the inverse of
   * the bench anchor's world matrix; both column-major 4x4.
   */
  update(
    frame: XRFrame | null | undefined,
    refSpace: XRReferenceSpace | null,
    originWorld: Float32Array | number[],
    worldToBench: Float32Array | number[],
    dt: number,
  ): void {
    let gotLeft = false, gotRight = false;
    let claimedLeft = false, claimedRight = false;
    if (frame && refSpace && frame.session) {
      m4mul(this.toBench, worldToBench, originWorld);
      quatOfMatrix(this.qOrigin, 0, originWorld, 0);
      quatOfMatrix(this.qBench, 0, this.toBench, 0);
      const session = frame.session as XRSession & { trackedSources?: XRInputSourceArray };
      // Quest may list the same hand in inputSources and trackedSources: first one wins.
      for (let pass = 0; pass < 2; pass++) {
        const list = pass === 0 ? session.inputSources : session.trackedSources;
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const src = list[i];
          const xrHand = src?.hand;
          if (!xrHand) continue;
          if (src.handedness === 'left' && !claimedLeft) {
            claimedLeft = true;
            gotLeft = this.sample(frame, refSpace, xrHand, this.left, originWorld, dt);
          } else if (src.handedness === 'right' && !claimedRight) {
            claimedRight = true;
            gotRight = this.sample(frame, refSpace, xrHand, this.right, originWorld, dt);
          }
        }
      }
    }
    if (!gotLeft) this.left.lose();
    if (!gotRight) this.right.lose();
  }

  private sample(
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    xrHand: XRHand,
    h: TrackedHand,
    originWorld: ArrayLike<number>,
    dt: number,
  ): boolean {
    const spaces = h.jointSpaces(xrHand);
    if (!spaces) return false;
    const f = frame as unknown as XRFrameFill;
    const buf = this.poseBuf;
    let haveRadii = false;
    if (f.fillPoses) {
      if (!f.fillPoses(spaces, refSpace, buf)) return false;
      if (f.fillJointRadii) haveRadii = f.fillJointRadii(spaces, this.radiiBuf);
    } else if (f.getJointPose) {
      for (let j = 0; j < JOINT_COUNT; j++) {
        const pose = f.getJointPose(spaces[j], refSpace);
        if (!pose) return false;
        buf.set(pose.transform.matrix, j * 16);
        this.radiiBuf[j] = pose.radius ?? h.radii[j];
      }
      haveRadii = true;
    } else {
      return false;
    }
    for (let j = 0; j < JOINT_COUNT; j++) {
      if (!Number.isFinite(buf[j * 16 + 12])) return false;
    }

    const toBench = this.toBench;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const m = j * 16;
      const x = buf[m + 12], y = buf[m + 13], z = buf[m + 14];
      m4point(h.posWorld, j * 3, originWorld, x, y, z);
      m4point(h.rawBench, j * 3, toBench, x, y, z);
      quatOfMatrix(this.qJoint, 0, buf, m);
      qmul(this.qTmp, 0, this.qOrigin, 0, this.qJoint, 0);
      writeQuat(h.rotWorld, j * 4, this.qTmp);
      qmul(this.qTmp, 0, this.qBench, 0, this.qJoint, 0);
      writeQuat(h.rawRotBench, j * 4, this.qTmp);
    }
    if (haveRadii) {
      for (let j = 0; j < JOINT_COUNT; j++) if (this.radiiBuf[j] > 0) h.radii[j] = this.radiiBuf[j];
    }
    h.ingest(dt);
    return true;
  }
}

function writeQuat(o: Float32Array, oi: number, q: Float64Array): void {
  o[oi] = q[0];
  o[oi + 1] = q[1];
  o[oi + 2] = q[2];
  o[oi + 3] = q[3];
}
