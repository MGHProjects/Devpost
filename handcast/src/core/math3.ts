/**
 * Tiny allocation-free vec3 / quaternion helpers for pure core modules (no
 * three.js). Vectors and quaternions live in flat number arrays; every
 * function takes an output array + offset so callers can work in place on
 * pose buffers. Quaternions are x, y, z, w (Hamilton, as three.js / WebXR).
 */

export type Arr = { [i: number]: number; length: number };

export function v3set(o: Arr, oi: number, x: number, y: number, z: number): void {
  o[oi] = x;
  o[oi + 1] = y;
  o[oi + 2] = z;
}

export function v3len(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Distance between point a[ai..] and b[bi..]. */
export function v3dist(a: Arr, ai: number, b: Arr, bi: number): number {
  return v3len(a[ai] - b[bi], a[ai + 1] - b[bi + 1], a[ai + 2] - b[bi + 2]);
}

/** o = normalize(a). Safe for zero vectors (left as zero). */
export function v3norm(o: Arr, oi: number, a: Arr, ai: number): void {
  const l = v3len(a[ai], a[ai + 1], a[ai + 2]) || 1;
  o[oi] = a[ai] / l;
  o[oi + 1] = a[ai + 1] / l;
  o[oi + 2] = a[ai + 2] / l;
}

/** o = a x b (o may alias a or b). */
export function v3cross(o: Arr, oi: number, a: Arr, ai: number, b: Arr, bi: number): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2];
  o[oi] = ay * bz - az * by;
  o[oi + 1] = az * bx - ax * bz;
  o[oi + 2] = ax * by - ay * bx;
}

export function v3dot(a: Arr, ai: number, b: Arr, bi: number): number {
  return a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2];
}

/** o = q * v (rotate vector v by unit quaternion q). o may alias v. */
export function qrot(o: Arr, oi: number, q: Arr, qi: number, v: Arr, vi: number): void {
  const qx = q[qi], qy = q[qi + 1], qz = q[qi + 2], qw = q[qi + 3];
  const vx = v[vi], vy = v[vi + 1], vz = v[vi + 2];
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  o[oi] = vx + qw * tx + (qy * tz - qz * ty);
  o[oi + 1] = vy + qw * ty + (qz * tx - qx * tz);
  o[oi + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** o = a * b (Hamilton product; o may alias a or b). */
export function qmul(o: Arr, oi: number, a: Arr, ai: number, b: Arr, bi: number): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** o = conjugate(q) (= inverse for unit quaternions). */
export function qconj(o: Arr, oi: number, q: Arr, qi: number): void {
  o[oi] = -q[qi];
  o[oi + 1] = -q[qi + 1];
  o[oi + 2] = -q[qi + 2];
  o[oi + 3] = q[qi + 3];
}

/** o = rotation of `angle` radians about the unit axis (x, y, z). */
export function qaxis(o: Arr, oi: number, x: number, y: number, z: number, angle: number): void {
  const s = Math.sin(angle / 2);
  o[oi] = x * s;
  o[oi + 1] = y * s;
  o[oi + 2] = z * s;
  o[oi + 3] = Math.cos(angle / 2);
}

export function qnormalize(o: Arr, oi: number): void {
  const l = Math.sqrt(o[oi] ** 2 + o[oi + 1] ** 2 + o[oi + 2] ** 2 + o[oi + 3] ** 2) || 1;
  o[oi] /= l;
  o[oi + 1] /= l;
  o[oi + 2] /= l;
  o[oi + 3] /= l;
}

/**
 * o = quaternion of the rotation matrix with columns (x axis, y axis, z axis),
 * each given as a unit vector. Shepperd's method.
 */
export function qfromBasis(
  o: Arr, oi: number,
  xx: number, xy: number, xz: number,
  yx: number, yy: number, yz: number,
  zx: number, zy: number, zz: number,
): void {
  // m00=xx m01=yx m02=zx / m10=xy m11=yy m12=zy / m20=xz m21=yz m22=zz
  const tr = xx + yy + zz;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    o[oi + 3] = s / 4;
    o[oi] = (yz - zy) / s;
    o[oi + 1] = (zx - xz) / s;
    o[oi + 2] = (xy - yx) / s;
  } else if (xx > yy && xx > zz) {
    const s = Math.sqrt(1 + xx - yy - zz) * 2;
    o[oi + 3] = (yz - zy) / s;
    o[oi] = s / 4;
    o[oi + 1] = (yx + xy) / s;
    o[oi + 2] = (zx + xz) / s;
  } else if (yy > zz) {
    const s = Math.sqrt(1 + yy - xx - zz) * 2;
    o[oi + 3] = (zx - xz) / s;
    o[oi] = (yx + xy) / s;
    o[oi + 1] = s / 4;
    o[oi + 2] = (zy + yz) / s;
  } else {
    const s = Math.sqrt(1 + zz - xx - yy) * 2;
    o[oi + 3] = (xy - yx) / s;
    o[oi] = (zx + xz) / s;
    o[oi + 1] = (zy + yz) / s;
    o[oi + 2] = s / 4;
  }
  qnormalize(o, oi);
}

/**
 * o = quaternion whose local -Z axis is `fwd` and whose local +Y is as close
 * as possible to `up` (both unit-ish; up is orthogonalised against fwd).
 */
export function qlook(o: Arr, oi: number, fwd: Arr, fi: number, up: Arr, ui: number): void {
  // z axis = -fwd
  let zx = -fwd[fi], zy = -fwd[fi + 1], zz = -fwd[fi + 2];
  const zl = v3len(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;
  // x = up x z
  let xx = up[ui + 1] * zz - up[ui + 2] * zy;
  let xy = up[ui + 2] * zx - up[ui] * zz;
  let xz = up[ui] * zy - up[ui + 1] * zx;
  const xl = v3len(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;
  // y = z x x
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  qfromBasis(o, oi, xx, xy, xz, yx, yy, yz, zx, zy, zz);
}

/** o = shortest-arc rotation taking unit vector a to unit vector b. */
export function qfromTo(o: Arr, oi: number, a: Arr, ai: number, b: Arr, bi: number): void {
  const d = v3dot(a, ai, b, bi);
  if (d < -0.999999) {
    // 180 deg: any axis perpendicular to a
    let x = 0, y = -a[ai + 2], z = a[ai + 1];
    if (v3len(x, y, z) < 1e-6) { x = a[ai + 2]; y = 0; z = -a[ai]; }
    const l = v3len(x, y, z);
    qaxis(o, oi, x / l, y / l, z / l, Math.PI);
    return;
  }
  o[oi] = a[ai + 1] * b[bi + 2] - a[ai + 2] * b[bi + 1];
  o[oi + 1] = a[ai + 2] * b[bi] - a[ai] * b[bi + 2];
  o[oi + 2] = a[ai] * b[bi + 1] - a[ai + 1] * b[bi];
  o[oi + 3] = 1 + d;
  qnormalize(o, oi);
}
