/**
 * Allocation-free 2D geometry kernel for the light sheet ([x, z] bench
 * coordinates). Ray queries take scalar origin/direction (direction must be
 * unit length) and return the hit distance t >= 0, or Infinity on a miss.
 * A ray whose origin is already inside a solid shape returns 0.
 */

import type { V2 } from './types.js';

export const DEG = Math.PI / 180;

export function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function dist2(a: V2, b: V2): number {
  return len2(b[0] - a[0], b[1] - a[1]);
}

/** Normalizes (x, z) into `out` (falls back to `fx, fz` when degenerate). */
export function normalizeInto(out: V2, x: number, z: number, fx = 1, fz = 0): V2 {
  const l = len2(x, z);
  if (l < 1e-12) {
    out[0] = fx;
    out[1] = fz;
  } else {
    out[0] = x / l;
    out[1] = z / l;
  }
  return out;
}

/** Unit direction for an angle in the atan2(z, x) convention. */
export function dirFromAngle(out: V2, a: number): V2 {
  out[0] = Math.cos(a);
  out[1] = Math.sin(a);
  return out;
}

export function angleOf(x: number, z: number): number {
  return Math.atan2(z, x);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a <= 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** Unsigned angle (0..PI) between two non-zero vectors. */
export function angleBetween(ax: number, az: number, bx: number, bz: number): number {
  return Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
}

/** Reflects direction d across a line with unit normal n: d - 2(d.n)n (either normal sign). */
export function reflectInto(out: V2, dx: number, dz: number, nx: number, nz: number): V2 {
  const k = 2 * (dx * nx + dz * nz);
  out[0] = dx - k * nx;
  out[1] = dz - k * nz;
  return out;
}

/** Squared distance from point p to segment ab. */
export function pointSegDistSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax;
  const ez = bz - az;
  const ll = ex * ex + ez * ez;
  let u = ll > 0 ? ((px - ax) * ex + (pz - az) * ez) / ll : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const dx = ax + u * ex - px;
  const dz = az + u * ez - pz;
  return dx * dx + dz * dz;
}

/** Ray vs solid circle. */
export function rayCircle(ox: number, oz: number, dx: number, dz: number, cx: number, cz: number, r: number): number {
  const fx = ox - cx;
  const fz = oz - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const b = fx * dx + fz * dz;
  if (b >= 0) return Infinity;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  return -b - Math.sqrt(disc);
}

/** Ray vs segment ab (two-sided, zero thickness). Parallel rays miss. */
export function raySegment(
  ox: number, oz: number, dx: number, dz: number,
  ax: number, az: number, bx: number, bz: number,
): number {
  const ex = bx - ax;
  const ez = bz - az;
  const den = dx * ez - dz * ex;
  if (den > -1e-14 && den < 1e-14) return Infinity;
  const wx = ax - ox;
  const wz = az - oz;
  const t = (wx * ez - wz * ex) / den;
  if (t < 0) return Infinity;
  const u = (wx * dz - wz * dx) / den;
  if (u < 0 || u > 1) return Infinity;
  return t;
}

/**
 * Ray vs solid capsule (stadium) around segment ab with radius r. Hits
 * farther than `maxT` may be reported as misses (cheap early-out).
 */
export function rayCapsule(
  ox: number, oz: number, dx: number, dz: number,
  ax: number, az: number, bx: number, bz: number, r: number,
  maxT = Infinity,
): number {
  // Reject: both ends beyond r on the same side of the ray line, or both behind / past maxT.
  const sa = dx * (az - oz) - dz * (ax - ox);
  const sb = dx * (bz - oz) - dz * (bx - ox);
  if ((sa > r && sb > r) || (sa < -r && sb < -r)) return Infinity;
  const pa = dx * (ax - ox) + dz * (az - oz);
  const pb = dx * (bx - ox) + dz * (bz - oz);
  if ((pa < -r && pb < -r) || (pa - r >= maxT && pb - r >= maxT)) return Infinity;
  if (pointSegDistSq(ox, oz, ax, az, bx, bz) <= r * r) return 0;
  let t = rayCircle(ox, oz, dx, dz, ax, az, r);
  const tb = rayCircle(ox, oz, dx, dz, bx, bz, r);
  if (tb < t) t = tb;
  const ex = bx - ax;
  const ez = bz - az;
  const l = len2(ex, ez);
  if (l > 1e-12) {
    const nx = (-ez / l) * r;
    const nz = (ex / l) * r;
    const t1 = raySegment(ox, oz, dx, dz, ax + nx, az + nz, bx + nx, bz + nz);
    if (t1 < t) t = t1;
    const t2 = raySegment(ox, oz, dx, dz, ax - nx, az - nz, bx - nx, bz - nz);
    if (t2 < t) t = t2;
  }
  return t;
}

/**
 * Ray vs solid convex polygon given CCW (positive signed area in (x, z)).
 * Cyrus-Beck clipping; fewer than 3 vertices never hit.
 */
export function rayConvexPolygon(ox: number, oz: number, dx: number, dz: number, poly: readonly V2[]): number {
  const n = poly.length;
  if (n < 3) return Infinity;
  let tEnter = 0;
  let tExit = Infinity;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[i + 1 === n ? 0 : i + 1];
    // Outward normal of a CCW edge is the edge direction rotated clockwise.
    const nx = q[1] - p[1];
    const nz = -(q[0] - p[0]);
    const num = nx * (p[0] - ox) + nz * (p[1] - oz);
    const den = nx * dx + nz * dz;
    if (den === 0) {
      if (num < 0) return Infinity;
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > tEnter) tEnter = t;
    } else if (t < tExit) {
      tExit = t;
    }
    if (tEnter > tExit) return Infinity;
  }
  return tEnter;
}

/** Distance along a ray from inside the axis-aligned box |x| <= hw, |z| <= hd to its edge (0 if outside). */
export function rayBoxExit(ox: number, oz: number, dx: number, dz: number, hw: number, hd: number): number {
  let t = Infinity;
  if (dx > 1e-12) t = Math.min(t, (hw - ox) / dx);
  else if (dx < -1e-12) t = Math.min(t, (-hw - ox) / dx);
  if (dz > 1e-12) t = Math.min(t, (hd - oz) / dz);
  else if (dz < -1e-12) t = Math.min(t, (-hd - oz) / dz);
  return t > 0 ? t : 0;
}

/** Signed area of a polygon in (x, z); positive = CCW. */
export function signedArea(poly: readonly V2[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** Convex hull (Andrew's monotone chain), CCW, no collinear points. Allocates. */
export function convexHull(points: readonly V2[]): V2[] {
  const pts = points.map((p) => [p[0], p[1]] as V2).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
