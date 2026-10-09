/**
 * Bakes a hand pose into a static glass-hand geometry: CPU linear-blend
 * skinning of the generic-hand template (bench-space joint poses x inverse
 * bind matrices), smooth normals recomputed on the posed surface (UV seams
 * welded), optional inflation along the normal so the glass shell encloses the
 * real hand, and the template's glass attributes (aAlong, aFinger, aVein).
 *
 * subdivide >= 1 (what CastView uses) welds the seams, rounds the wrist end
 * and splits triangles with Phong-tessellated midpoints for smooth silhouettes.
 *
 * Output frame: bench space, minus `origin` when given (CastView bakes
 * relative to the cast's foot point so the cast can be nudged / twisted by
 * moving its root).
 *
 * Poses without orientations: joint rotations are derived from the joint
 * positions (deriveJointRotations): a hand frame fitted to the wrist and the
 * index / middle / pinky knuckles gives the palm rotation, and each bone then
 * swings minimally (relative to its parent's derived rotation) from its bind
 * direction onto its posed direction. No twist is invented, so the result is
 * stable for curled fingers too.
 */
import { BufferAttribute, BufferGeometry } from '@iwsdk/core';
import type { HandPose, Handedness } from '../../core/types';
import { FINGER_CHAINS, JOINT_COUNT } from '../../core/joints';
import { qconj, qfromBasis, qfromTo, qmul, qrot, v3cross, v3norm } from '../../core/math3';
import type { HandTemplate } from './hand-model';

export interface BakeOptions {
  /** Push every vertex out along its normal by this many metres (default 0). */
  inflate?: number;
  /** Subtracted from every baked position (bench space), e.g. the cast's foot point. */
  origin?: ArrayLike<number>;
  /**
   * 0 (default) keeps the template's vertices 1:1; 1 or 2 welds UV seams and
   * splits every triangle into 4 (per level) with Phong-tessellated
   * midpoints for rounder silhouettes (~2.7k / ~11k triangles -> x4 / x16).
   */
  subdivide?: number;
}

const PARENT = new Int8Array(JOINT_COUNT).fill(-1);
const CHILD = new Int8Array(JOINT_COUNT).fill(-1);
for (const chain of FINGER_CHAINS) {
  chain.forEach((j, k) => {
    PARENT[j] = k === 0 ? 0 : chain[k - 1];
    if (k + 1 < chain.length) CHILD[j] = chain[k + 1];
  });
}

// Scratch (bake is not per-frame, but keep it allocation-light).
const sMat = new Float64Array(JOINT_COUNT * 12);
const sRot = new Float64Array(JOINT_COUNT * 4);
const sDelta = new Float64Array(JOINT_COUNT * 4);
const sQa = new Float64Array(4);
const sQb = new Float64Array(4);
const sQs = new Float64Array(4);
const sV1 = new Float64Array(3);
const sV2 = new Float64Array(3);
const sV3 = new Float64Array(3);

/** Rotation of the palm frame (x lateral, y back of the hand, z = -(wrist -> middle knuckle)). */
function handFrame(out: Float64Array, pos: ArrayLike<number>, hand: Handedness): void {
  const side = hand === 'right' ? 1 : -1;
  const ax = [pos[33] - pos[0], pos[34] - pos[1], pos[35] - pos[2]];
  v3norm(ax, 0, ax, 0);
  sV1[0] = pos[18] - pos[0]; sV1[1] = pos[19] - pos[1]; sV1[2] = pos[20] - pos[2];
  sV2[0] = pos[63] - pos[0]; sV2[1] = pos[64] - pos[1]; sV2[2] = pos[65] - pos[2];
  v3cross(sV3, 0, sV1, 0, sV2, 0); // palm normal for a right hand
  const d = sV3[0] * ax[0] + sV3[1] * ax[1] + sV3[2] * ax[2];
  const up = [-side * (sV3[0] - d * ax[0]), -side * (sV3[1] - d * ax[1]), -side * (sV3[2] - d * ax[2])];
  v3norm(up, 0, up, 0);
  const z = [-ax[0], -ax[1], -ax[2]];
  const x = [0, 0, 0];
  v3cross(x, 0, up, 0, z, 0);
  qfromBasis(out, 0, x[0], x[1], x[2], up[0], up[1], up[2], z[0], z[1], z[2]);
}

/**
 * Derives WebXR-convention joint orientations (100, x y z w) for `pos` (75,
 * bench space) from the template's bind pose. Writes into `out` and returns it.
 */
export function deriveJointRotations(
  template: Pick<HandTemplate, 'hand' | 'bindPos' | 'bindRot'>,
  pos: ArrayLike<number>,
  out: Float64Array = new Float64Array(100),
): Float64Array {
  const bp = template.bindPos;
  const br = template.bindRot;
  // Palm: delta = posedFrame * inverse(bindFrame).
  handFrame(sQa, bp, template.hand);
  handFrame(sQb, pos, template.hand);
  qconj(sQa, 0, sQa, 0);
  qmul(sDelta, 0, sQb, 0, sQa, 0);
  for (const chain of FINGER_CHAINS) {
    for (const j of chain) {
      const p = PARENT[j];
      const c = CHILD[j];
      if (c < 0) {
        for (let i = 0; i < 4; i++) sDelta[j * 4 + i] = sDelta[p * 4 + i];
        continue;
      }
      // Bind bone direction carried by the parent's rotation -> posed bone direction.
      sV1[0] = bp[c * 3] - bp[j * 3]; sV1[1] = bp[c * 3 + 1] - bp[j * 3 + 1]; sV1[2] = bp[c * 3 + 2] - bp[j * 3 + 2];
      v3norm(sV1, 0, sV1, 0);
      qrot(sV1, 0, sDelta, p * 4, sV1, 0);
      sV2[0] = pos[c * 3] - pos[j * 3]; sV2[1] = pos[c * 3 + 1] - pos[j * 3 + 1]; sV2[2] = pos[c * 3 + 2] - pos[j * 3 + 2];
      v3norm(sV2, 0, sV2, 0);
      qfromTo(sQs, 0, sV1, 0, sV2, 0);
      qmul(sDelta, j * 4, sQs, 0, sDelta, p * 4);
    }
  }
  for (let j = 0; j < JOINT_COUNT; j++) {
    qmul(out, j * 4, sDelta, j * 4, br, j * 4);
    if (out[j * 4 + 3] < 0) for (let i = 0; i < 4; i++) out[j * 4 + i] = -out[j * 4 + i];
  }
  return out;
}

/** Bakes `pose` into a new static BufferGeometry (see the module comment for the frame). */
export function bakePose(template: HandTemplate, pose: HandPose, opts: BakeOptions = {}): BufferGeometry {
  const pos = pose.pos;
  let rot: ArrayLike<number>;
  if (pose.rot && pose.rot.length >= 100) rot = pose.rot;
  else rot = deriveJointRotations(template, pos, sRot);

  // Per joint skinning matrix (3x4, column-major rows dropped): T(p) * R(q) * IBM.
  const ibm = template.ibm;
  for (let j = 0; j < JOINT_COUNT; j++) {
    let qx = rot[j * 4], qy = rot[j * 4 + 1], qz = rot[j * 4 + 2], qw = rot[j * 4 + 3];
    const ql = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= ql; qy /= ql; qz /= ql; qw /= ql;
    // Rotation matrix (column-major r[col*3+row]).
    const r00 = 1 - 2 * (qy * qy + qz * qz), r10 = 2 * (qx * qy + qz * qw), r20 = 2 * (qx * qz - qy * qw);
    const r01 = 2 * (qx * qy - qz * qw), r11 = 1 - 2 * (qx * qx + qz * qz), r21 = 2 * (qy * qz + qx * qw);
    const r02 = 2 * (qx * qz + qy * qw), r12 = 2 * (qy * qz - qx * qw), r22 = 1 - 2 * (qx * qx + qy * qy);
    const tx = pos[j * 3], ty = pos[j * 3 + 1], tz = pos[j * 3 + 2];
    const b = j * 16;
    const o = j * 12;
    // M = [R t] * IBM; store as 4 columns x 3 rows.
    for (let col = 0; col < 4; col++) {
      const m0 = ibm[b + col * 4], m1 = ibm[b + col * 4 + 1], m2 = ibm[b + col * 4 + 2], m3 = ibm[b + col * 4 + 3];
      sMat[o + col * 3] = r00 * m0 + r01 * m1 + r02 * m2 + tx * m3;
      sMat[o + col * 3 + 1] = r10 * m0 + r11 * m1 + r12 * m2 + ty * m3;
      sMat[o + col * 3 + 2] = r20 * m0 + r21 * m1 + r22 * m2 + tz * m3;
    }
  }

  const n = template.vertexCount;
  const src = template.positions;
  const si = template.skinIndex;
  const sw = template.skinWeight;
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = src[v * 3], y = src[v * 3 + 1], z = src[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[v * 4 + k];
      if (w === 0) continue;
      const o = si[v * 4 + k] * 12;
      ox += w * (sMat[o] * x + sMat[o + 3] * y + sMat[o + 6] * z + sMat[o + 9]);
      oy += w * (sMat[o + 1] * x + sMat[o + 4] * y + sMat[o + 7] * z + sMat[o + 10]);
      oz += w * (sMat[o + 2] * x + sMat[o + 5] * y + sMat[o + 8] * z + sMat[o + 11]);
    }
    out[v * 3] = ox;
    out[v * 3 + 1] = oy;
    out[v * 3 + 2] = oz;
  }

  const inflate = opts.inflate ?? 0;
  const origin = opts.origin ?? ZERO3;
  const levels = Math.max(0, Math.min(2, Math.floor(opts.subdivide ?? 0)));
  if (levels === 0) {
    // Keep the template's vertex order (UV-seam duplicates share welded normals).
    const normals = smoothNormals(out, template.index, template.weld, n);
    return finish(out, normals, template.aAlong.slice(), template.aFinger.slice(), template.aVein.slice(),
      template.index.slice(), inflate, origin);
  }
  // Compact welded mesh, then Phong-tessellated subdivision.
  const weld = template.weld;
  const remap = new Int32Array(n).fill(-1);
  let m = 0;
  for (let v = 0; v < n; v++) if (weld[v] === v) remap[v] = m++;
  let mesh: Mesh = {
    pos: new Float32Array(m * 3), along: new Float32Array(m), finger: new Float32Array(m),
    vein: new Float32Array(m * 2), index: new Uint32Array(template.index.length), normal: new Float32Array(0),
  };
  for (let v = 0; v < n; v++) {
    const r = remap[v];
    if (r < 0) continue;
    mesh.pos.set(out.subarray(v * 3, v * 3 + 3), r * 3);
    mesh.along[r] = template.aAlong[v];
    mesh.finger[r] = template.aFinger[v];
    mesh.vein[r * 2] = template.aVein[v * 2];
    mesh.vein[r * 2 + 1] = template.aVein[v * 2 + 1];
  }
  for (let i = 0; i < template.index.length; i++) mesh.index[i] = remap[weld[template.index[i]]];
  relaxWrist(mesh);
  mesh.normal = smoothNormals(mesh.pos, mesh.index, null, m);
  for (let l = 0; l < levels; l++) {
    mesh = subdivide(mesh);
    mesh.normal = smoothNormals(mesh.pos, mesh.index, null, mesh.along.length);
  }
  return finish(mesh.pos, mesh.normal, mesh.along, mesh.finger, mesh.vein, mesh.index, inflate, origin);
}

const ZERO3 = [0, 0, 0];

interface Mesh {
  pos: Float32Array;
  normal: Float32Array;
  along: Float32Array;
  finger: Float32Array;
  vein: Float32Array;
  index: Uint32Array;
}

/** Area-weighted vertex normals; `weld` (optional) shares them between coincident vertices. */
function smoothNormals(pos: Float32Array, index: Uint32Array, weld: Uint32Array | null, n: number): Float32Array {
  const acc = new Float64Array(n * 3);
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const e1x = pos[b * 3] - pos[a * 3], e1y = pos[b * 3 + 1] - pos[a * 3 + 1], e1z = pos[b * 3 + 2] - pos[a * 3 + 2];
    const e2x = pos[c * 3] - pos[a * 3], e2y = pos[c * 3 + 1] - pos[a * 3 + 1], e2z = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (let k = 0; k < 3; k++) {
      const vi = (weld ? weld[index[t + k]] : index[t + k]) * 3;
      acc[vi] += nx; acc[vi + 1] += ny; acc[vi + 2] += nz;
    }
  }
  const normals = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const r = weld ? weld[v] : v;
    const l = Math.hypot(acc[r * 3], acc[r * 3 + 1], acc[r * 3 + 2]) || 1;
    normals[v * 3] = acc[r * 3] / l;
    normals[v * 3 + 1] = acc[r * 3 + 1] / l;
    normals[v * 3 + 2] = acc[r * 3 + 2] / l;
  }
  return normals;
}

/**
 * Rounds off the wrist end: the GLB closes the wrist with a flat cap whose
 * zigzag rim catches a jagged highlight. A few Laplacian steps, weighted to
 * the wrist (aAlong < ~0.06), turn it into a soft fire-polished end.
 */
function relaxWrist(src: Mesh): void {
  const n = src.along.length;
  const idx = src.index;
  const sum = new Float64Array(n * 3);
  const cnt = new Uint16Array(n);
  const pos = src.pos;
  for (let it = 0; it < 4; it++) {
    sum.fill(0);
    cnt.fill(0);
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = idx[t + k], b = idx[t + (k + 1) % 3];
        for (let i = 0; i < 3; i++) { sum[a * 3 + i] += pos[b * 3 + i]; sum[b * 3 + i] += pos[a * 3 + i]; }
        cnt[a]++; cnt[b]++;
      }
    }
    for (let v = 0; v < n; v++) {
      const x = src.along[v] / 0.06;
      if (x >= 1 || cnt[v] === 0) continue;
      const w = 0.6 * (1 - x * x * (3 - 2 * x));
      for (let i = 0; i < 3; i++) pos[v * 3 + i] += w * (sum[v * 3 + i] / cnt[v] - pos[v * 3 + i]);
    }
  }
}

/**
 * One 1 -> 4 split. Edge midpoints are lifted with Phong tessellation (the
 * average of the midpoint projected onto both endpoints' tangent planes,
 * shape factor 3/4), which rounds the low-poly silhouette.
 */
function subdivide(src: Mesh): Mesh {
  const n = src.along.length;
  const tris = src.index.length / 3;
  // Edge -> midpoint vertex: open-addressing hash on the (min, max) pair.
  let size = 1;
  while (size < tris * 4) size <<= 1;
  const keyA = new Int32Array(size).fill(-1);
  const keyB = new Int32Array(size);
  const val = new Int32Array(size);
  let next = n;
  const index = new Uint32Array(tris * 12);
  const mids = new Int32Array(tris * 3 * 2); // endpoint pairs per new vertex
  const mid = (p: number, q: number): number => {
    const a = p < q ? p : q, b = p < q ? q : p;
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) & (size - 1);
    while (keyA[h] !== -1) {
      if (keyA[h] === a && keyB[h] === b) return val[h];
      h = (h + 1) & (size - 1);
    }
    keyA[h] = a; keyB[h] = b; val[h] = next;
    mids[(next - n) * 2] = a;
    mids[(next - n) * 2 + 1] = b;
    return next++;
  };
  for (let t = 0; t < tris; t++) {
    const a = src.index[t * 3], b = src.index[t * 3 + 1], c = src.index[t * 3 + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    const o = t * 12;
    index[o] = a; index[o + 1] = ab; index[o + 2] = ca;
    index[o + 3] = ab; index[o + 4] = b; index[o + 5] = bc;
    index[o + 6] = ca; index[o + 7] = bc; index[o + 8] = c;
    index[o + 9] = ab; index[o + 10] = bc; index[o + 11] = ca;
  }
  const total = next;
  const pos = new Float32Array(total * 3);
  const along = new Float32Array(total);
  const finger = new Float32Array(total);
  const vein = new Float32Array(total * 2);
  pos.set(src.pos);
  along.set(src.along);
  finger.set(src.finger);
  vein.set(src.vein);
  const P = src.pos, N = src.normal;
  for (let i = 0; i < total - n; i++) {
    const a = mids[i * 2], b = mids[i * 2 + 1], v = n + i;
    const mx = (P[a * 3] + P[b * 3]) / 2, my = (P[a * 3 + 1] + P[b * 3 + 1]) / 2, mz = (P[a * 3 + 2] + P[b * 3 + 2]) / 2;
    const da = (mx - P[a * 3]) * N[a * 3] + (my - P[a * 3 + 1]) * N[a * 3 + 1] + (mz - P[a * 3 + 2]) * N[a * 3 + 2];
    const db = (mx - P[b * 3]) * N[b * 3] + (my - P[b * 3 + 1]) * N[b * 3 + 1] + (mz - P[b * 3 + 2]) * N[b * 3 + 2];
    // Phong: m - 0.75 * ((da * na + db * nb) / 2)
    pos[v * 3] = mx - 0.375 * (da * N[a * 3] + db * N[b * 3]);
    pos[v * 3 + 1] = my - 0.375 * (da * N[a * 3 + 1] + db * N[b * 3 + 1]);
    pos[v * 3 + 2] = mz - 0.375 * (da * N[a * 3 + 2] + db * N[b * 3 + 2]);
    along[v] = (src.along[a] + src.along[b]) / 2;
    // Discrete ids: prefer the finger over the palm so finger borders stay on the finger.
    finger[v] = src.finger[a] === 5 ? src.finger[b] : src.finger[a];
    vein[v * 2] = src.vein[a * 2 + 1] >= src.vein[b * 2 + 1] ? src.vein[a * 2] : src.vein[b * 2];
    vein[v * 2 + 1] = (src.vein[a * 2 + 1] + src.vein[b * 2 + 1]) / 2;
  }
  return { pos, normal: new Float32Array(0), along, finger, vein, index };
}

function finish(
  pos: Float32Array, normals: Float32Array, along: Float32Array, finger: Float32Array, vein: Float32Array,
  index: Uint32Array, inflate: number, origin: ArrayLike<number>,
): BufferGeometry {
  const n = along.length;
  for (let v = 0; v < n; v++) {
    pos[v * 3] += normals[v * 3] * inflate - origin[0];
    pos[v * 3 + 1] += normals[v * 3 + 1] * inflate - origin[1];
    pos[v * 3 + 2] += normals[v * 3 + 2] * inflate - origin[2];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(normals, 3));
  g.setAttribute('aAlong', new BufferAttribute(along, 1));
  g.setAttribute('aFinger', new BufferAttribute(finger, 1));
  g.setAttribute('aVein', new BufferAttribute(vein, 2));
  g.setIndex(new BufferAttribute(index, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
