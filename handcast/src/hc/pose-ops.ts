/**
 * Rigid operations on bench-space hand poses (pure): moving and turning a
 * glass hand about its foot, and converting between HandPose and the compact
 * CastData stored in levels and share codes.
 */

import type { CastData, HandPose, V2 } from '../core/types.js';

/** Foot point of a pose: palm centre ((wrist + middle knuckle) / 2) on the bench. */
export function footOf(pose: HandPose): V2 {
  const p = pose.pos;
  return [(p[0] + p[33]) / 2, (p[2] + p[35]) / 2];
}

/**
 * Returns a copy of `pose` rotated by `yaw` (radians, about +Y, positive =
 * counter-clockwise seen from above, matching three's rotation.y) around the
 * foot point `pivot`, then translated by (dx, dz).
 */
export function transformPose(pose: HandPose, pivot: V2, yaw: number, dx: number, dz: number): HandPose {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const pos = new Float32Array(75);
  for (let j = 0; j < 25; j++) {
    const x = pose.pos[j * 3] - pivot[0];
    const y = pose.pos[j * 3 + 1];
    const z = pose.pos[j * 3 + 2] - pivot[1];
    // three.js rotation.y: x' = x cos + z sin, z' = -x sin + z cos
    pos[j * 3] = x * c + z * s + pivot[0] + dx;
    pos[j * 3 + 1] = y;
    pos[j * 3 + 2] = -x * s + z * c + pivot[1] + dz;
  }
  let rot: Float32Array | undefined;
  if (pose.rot) {
    rot = new Float32Array(100);
    // q' = qYaw * q
    const hy = yaw / 2;
    const qw = Math.cos(hy);
    const qy = Math.sin(hy);
    for (let j = 0; j < 25; j++) {
      const x = pose.rot[j * 4];
      const y = pose.rot[j * 4 + 1];
      const z = pose.rot[j * 4 + 2];
      const w = pose.rot[j * 4 + 3];
      rot[j * 4] = qw * x + qy * z;
      rot[j * 4 + 1] = qw * y + qy * w;
      rot[j * 4 + 2] = qw * z - qy * x;
      rot[j * 4 + 3] = qw * w - qy * y;
    }
  }
  return { hand: pose.hand, pos, rot, radii: pose.radii ? Float32Array.from(pose.radii) : undefined };
}

export function poseToCast(pose: HandPose): CastData {
  const cast: CastData = {
    hand: pose.hand,
    pos: Array.from(pose.pos, (v) => Math.round(v * 1000)),
  };
  if (pose.rot) cast.rot = Array.from(pose.rot, (v) => Math.round(v * 10000));
  return cast;
}

export function castToPose(cast: CastData): HandPose {
  const pos = new Float32Array(75);
  for (let i = 0; i < 75; i++) pos[i] = cast.pos[i] / 1000;
  let rot: Float32Array | undefined;
  if (cast.rot && cast.rot.length === 100) {
    rot = new Float32Array(100);
    for (let j = 0; j < 25; j++) {
      let x = cast.rot[j * 4] / 10000;
      let y = cast.rot[j * 4 + 1] / 10000;
      let z = cast.rot[j * 4 + 2] / 10000;
      let w = cast.rot[j * 4 + 3] / 10000;
      const l = Math.hypot(x, y, z, w) || 1;
      x /= l; y /= l; z /= l; w /= l;
      rot.set([x, y, z, w], j * 4);
    }
  }
  return { hand: cast.hand, pos, rot };
}
