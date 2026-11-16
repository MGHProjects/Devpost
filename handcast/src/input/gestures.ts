/**
 * Pure gesture helpers on bench-space hand data (TrackedHand buffers or any
 * HandPose): finger curl / fist, fist knock, palm-up menu pose, wrist twist
 * (swing-twist), pinch-grab proximity and fingertip plucks across a glass
 * finger. No three.js, no allocation: the integrator combines these with
 * TrackedHand.pinch / speed / palm to drive nudging, shattering and music.
 */

import { FINGER_CHAINS, KNUCKLE, TIP } from '../core/joints';

type Arr = ArrayLike<number>;
/** Quaternion as [x, y, z, w] (array-like) or an object with x, y, z, w (three.js Quaternion). */
export type QuatLike = Arr | { x: number; y: number; z: number; w: number };
/** Vector as [x, y, z] or an object with x, y, z (three.js Vector3). */
export type Vec3Like = Arr | { x: number; y: number; z: number };

export const GESTURE = {
  /** Long finger counts as curled when |tip - knuckle| / chain length is below this. */
  curlRatio: 0.62,
  /** Fist knock: knuckle speed (m/s). */
  knockSpeed: 0.6,
  /** Palm-up menu: palm normal y above this ... */
  palmUpY: 0.8,
  /** ... held this long (s). */
  palmUpHold: 0.4,
  /** Pinch point within this distance of a cast foot grabs it (m). */
  grabRadius: 0.04,
  /** Minimum fingertip speed (m/s) across a tine for a pluck. */
  pluckSpeed: 0.15,
} as const;

// ------------------------------------------------------------------ scratch
const sA = new Float64Array(4);
const sB = new Float64Array(4);
const sAx = new Float64Array(3);

function readQuat(o: Float64Array, q: QuatLike): void {
  if ('x' in q) {
    o[0] = q.x; o[1] = q.y; o[2] = q.z; o[3] = q.w;
  } else {
    o[0] = q[0]; o[1] = q[1]; o[2] = q[2]; o[3] = q[3];
  }
}

function readVec(o: Float64Array, v: Vec3Like): void {
  if ('x' in v) {
    o[0] = v.x; o[1] = v.y; o[2] = v.z;
  } else {
    o[0] = v[0]; o[1] = v[1]; o[2] = v[2];
  }
}

/**
 * Signed rotation (radians, in (-PI, PI]) of `now` relative to `start` about
 * the unit `axis` (swing-twist decomposition of now * start^-1): how far the
 * wrist has turned a knob. Axis is in the same (world / bench) frame as the
 * quaternions; positive = counter-clockwise looking down the axis.
 */
export function twistAngle(start: QuatLike, now: QuatLike, axis: Vec3Like): number {
  readQuat(sA, start);
  readQuat(sB, now);
  readVec(sAx, axis);
  // rel = now * conj(start)
  const ax = -sA[0], ay = -sA[1], az = -sA[2], aw = sA[3];
  const bx = sB[0], by = sB[1], bz = sB[2], bw = sB[3];
  const rx = bw * ax + bx * aw + by * az - bz * ay;
  const ry = bw * ay - bx * az + by * aw + bz * ax;
  const rz = bw * az + bx * ay - by * ax + bz * aw;
  const rw = bw * aw - bx * ax - by * ay - bz * az;
  const proj = rx * sAx[0] + ry * sAx[1] + rz * sAx[2];
  let a = 2 * Math.atan2(proj, rw);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Unwraps successive twist readings so a continuous turn past 180 deg keeps counting. */
export function unwrapAngle(prev: number, now: number): number {
  let d = now - prev;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return prev + d;
}

function dist(p: Arr, a: number, b: number): number {
  return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
}

/**
 * Straightness of finger f (0 thumb .. 4 pinky): |tip - knuckle| divided by
 * the bone length from the knuckle to the tip. 1 = straight, ~0.45 = fully
 * curled. Positions: 25 x 3 (any frame, scale-free).
 */
export function fingerStraightness(pos: Arr, f: number): number {
  const chain = FINGER_CHAINS[f];
  const k = KNUCKLE[f];
  let L = 0;
  for (let i = chain.indexOf(k); i < chain.length - 1; i++) L += dist(pos, chain[i], chain[i + 1]);
  return L > 1e-9 ? dist(pos, k, TIP[f]) / L : 1;
}

/** Number of long fingers (index..pinky) curled below `ratio`. */
export function curledCount(pos: Arr, ratio: number = GESTURE.curlRatio): number {
  let n = 0;
  for (let f = 1; f < 5; f++) if (fingerStraightness(pos, f) < ratio) n++;
  return n;
}

/** All four long fingers curled (the thumb is ignored: it may wrap or stick out). */
export function fistClosed(pos: Arr, ratio: number = GESTURE.curlRatio): boolean {
  return curledCount(pos, ratio) === 4;
}

/** Peak knuckle speed over the long fingers (index..pinky), from TrackedHand.speed.knuckle. */
export function knockSpeed(knuckleSpeeds: Arr): number {
  let m = 0;
  for (let f = 1; f < 5; f++) if (knuckleSpeeds[f] > m) m = knuckleSpeeds[f];
  return m;
}

/** Fist knock: fist closed and its knuckles moving faster than `minSpeed`. */
export function isKnock(pos: Arr, knuckleSpeeds: Arr, minSpeed: number = GESTURE.knockSpeed): boolean {
  return knockSpeed(knuckleSpeeds) > minSpeed && fistClosed(pos);
}

/** Palm facing up (normal out of the palm, bench space). */
export function palmUp(normal: Arr, minY: number = GESTURE.palmUpY): boolean {
  return normal[1] > minY;
}

/**
 * Debounced "held for a while" condition (e.g. palm-up menu: update with
 * palmUp(normal) each frame). `fired` is true on exactly the frame the hold
 * completes; the condition must drop before it can fire again.
 */
export class HoldTimer {
  held = 0;
  active = false;
  fired = false;

  constructor(public holdTime: number = GESTURE.palmUpHold) {}

  update(cond: boolean, dt: number): boolean {
    this.fired = false;
    if (!cond) {
      this.held = 0;
      this.active = false;
      return false;
    }
    this.held += dt > 0 ? dt : 0;
    if (!this.active && this.held >= this.holdTime) {
      this.active = true;
      this.fired = true;
    }
    return this.active;
  }

  /** 0..1 progress toward firing. */
  get progress(): number {
    return this.active ? 1 : Math.min(1, this.held / this.holdTime);
  }

  reset(): void {
    this.held = 0;
    this.active = false;
    this.fired = false;
  }
}

/**
 * Distance (m) from a pinch point (bench 3D) to a cast foot at [x, z] whose
 * palm centre sits `height` above the bench. Horizontal distance, plus how far
 * the pinch is above or below the foot's height band [0, height + 0.02].
 */
export function footDistance(point: Arr, foot: Arr, height = 0): number {
  const dx = point[0] - foot[0];
  const dz = point[2] - foot[1];
  const y = point[1];
  const top = height + 0.02;
  const dy = y < 0 ? -y : y > top ? y - top : 0;
  return Math.hypot(dx, dy, dz);
}

/** Pinch started close enough to a cast foot to grab it. */
export function pinchGrabs(pinchStarted: boolean, point: Arr, foot: Arr, height = 0, radius: number = GESTURE.grabRadius): boolean {
  return pinchStarted && footDistance(point, foot, height) <= radius;
}

/** Squared distance between segments p0-p1 and q0-q1 (3D, flat arrays at offsets). */
export function segSegDist2(
  p0: Arr, p0i: number, p1: Arr, p1i: number,
  q0: Arr, q0i: number, q1: Arr, q1i: number,
): number {
  const ux = p1[p1i] - p0[p0i], uy = p1[p1i + 1] - p0[p0i + 1], uz = p1[p1i + 2] - p0[p0i + 2];
  const vx = q1[q1i] - q0[q0i], vy = q1[q1i + 1] - q0[q0i + 1], vz = q1[q1i + 2] - q0[q0i + 2];
  const wx = p0[p0i] - q0[q0i], wy = p0[p0i + 1] - q0[q0i + 1], wz = p0[p0i + 2] - q0[q0i + 2];
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const den = a * c - b * b;
  let s: number, t: number;
  if (a < 1e-12 && c < 1e-12) {
    s = 0; t = 0;
  } else if (a < 1e-12) {
    s = 0; t = clamp01(e / c);
  } else if (c < 1e-12) {
    t = 0; s = clamp01(-d / a);
  } else {
    s = den > 1e-12 ? clamp01((b * e - c * d) / den) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = clamp01(-d / a); }
    else if (t > 1) { t = 1; s = clamp01((b - d) / a); }
  }
  const dx = wx + s * ux - t * vx, dy = wy + s * uy - t * vy, dz = wz + s * uz - t * vz;
  return dx * dx + dy * dy + dz * dz;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Squared distance from point p to segment a-b. */
function pointSegDist2(p: Arr, pi: number, a: Arr, ai: number, b: Arr, bi: number): number {
  return segSegDist2(p, pi, p, pi, a, ai, b, bi);
}

/**
 * Fingertip pluck of a glass finger ("tine", the segment a-b with radius r,
 * bench space): if the tip moved from outside the tine (prevTip) into or
 * through it (tip) this frame, returns the tip speed across the tine (m/s,
 * speed perpendicular to the tine axis); otherwise 0. Use `speed >=
 * GESTURE.pluckSpeed` to trigger and the speed for loudness.
 */
export function pluckCrossing(
  prevTip: Arr, prevTipI: number, tip: Arr, tipI: number,
  a: Arr, ai: number, b: Arr, bi: number, r: number, dt: number,
): number {
  if (!(dt > 0)) return 0;
  const r2 = r * r;
  if (pointSegDist2(prevTip, prevTipI, a, ai, b, bi) <= r2) return 0; // already inside
  if (segSegDist2(prevTip, prevTipI, tip, tipI, a, ai, b, bi) > r2) return 0; // missed
  const mx = tip[tipI] - prevTip[prevTipI], my = tip[tipI + 1] - prevTip[prevTipI + 1], mz = tip[tipI + 2] - prevTip[prevTipI + 2];
  let tx = b[bi] - a[ai], ty = b[bi + 1] - a[ai + 1], tz = b[bi + 2] - a[ai + 2];
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  const along = mx * tx + my * ty + mz * tz;
  const px = mx - along * tx, py = my - along * ty, pz = mz - along * tz;
  return Math.hypot(px, py, pz) / dt;
}

/** Joint quaternion j from a 25 x 4 rotation buffer into `out` (4). */
export function jointQuat(rot: Arr, j: number, out: { [i: number]: number }): void {
  out[0] = rot[j * 4];
  out[1] = rot[j * 4 + 1];
  out[2] = rot[j * 4 + 2];
  out[3] = rot[j * 4 + 3];
}
