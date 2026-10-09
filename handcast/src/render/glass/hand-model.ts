/**
 * Hand templates for the glass casts: the WebXR generic-hand GLBs
 * (public/models/{right,left}.glb) parsed once into flat, bake-ready data.
 *
 * The GLBs have a flat skeleton (all 25 joints are untransformed-Armature
 * children, the mesh node is untransformed too), so a vertex in bench space is
 * sum_i w_i * Pose_i * IBM_i * v with Pose_i the joint pose in bench space.
 *
 * Besides the skin data, every template geometry gets the per-vertex glass
 * attributes the shaders need (computeGlassAttributes):
 * - aAlong:  0 at the wrist -> 1 at the fingertips. Each influencing bone
 *            gives an estimate (arc length from the wrist along its finger's
 *            joint chain to the vertex's projection on the bone, normalised by
 *            that finger's wrist -> tip length) and the estimates are blended
 *            by skin weight, so the gradient is smooth across bone borders.
 * - aFinger: dominant finger 0..4 (thumb..pinky), 5 = palm / wrist (the four
 *            finger metacarpals and the wrist count as palm; the thumb
 *            metacarpal is the thenar pad and counts as thumb).
 * - aVein:   vec2 (nearest finger 0..4 counting metacarpals as finger,
 *            finger membership 0 palm .. 1 finger): lets the shader blend
 *            the palm light into each finger's light without seams.
 */
import {
  Bone, BufferAttribute, BufferGeometry, Matrix4, Object3D, SkinnedMesh,
} from '@iwsdk/core';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Handedness } from '../../core/types';
import { FINGER_CHAINS, JOINTS, JOINT_COUNT } from '../../core/joints';
import { bakePose } from './bake';
import { Shatter } from './shatter';

export interface HandTemplate {
  hand: Handedness;
  /** The parsed glTF scene (Armature + bones + skinned mesh), untouched. */
  scene: Object3D;
  mesh: SkinnedMesh;
  /** The skinned mesh's geometry, with aAlong / aFinger / aVein added. */
  geometry: BufferGeometry;
  /** Bones in JOINTS order. */
  bones: Bone[];
  vertexCount: number;
  /** Bind-space vertex positions (3 / vertex). */
  positions: Float32Array;
  /** Triangle indices. */
  index: Uint32Array;
  /** 4 influences per vertex: joint index in JOINTS order, and weight (normalised). */
  skinIndex: Uint8Array;
  skinWeight: Float32Array;
  /** Inverse bind matrices, JOINTS order, column-major (16 / joint). */
  ibm: Float64Array;
  /** Bind pose of the joints in model space (= Armature space): pos 75, rot 100 (x, y, z, w). */
  bindPos: Float64Array;
  bindRot: Float64Array;
  /** Vertex -> representative vertex sharing its position (welds UV seams for smooth normals). */
  weld: Uint32Array;
  aAlong: Float32Array;
  aFinger: Float32Array;
  aVein: Float32Array;
}

/** Joint -> finger (0..4), wrist = -1. */
const FINGER_OF = new Int8Array(JOINT_COUNT).fill(-1);
/** Joint -> index within its finger chain. */
const CHAIN_POS = new Int8Array(JOINT_COUNT);
FINGER_CHAINS.forEach((chain, f) => chain.forEach((j, k) => { FINGER_OF[j] = f; CHAIN_POS[j] = k; }));

/**
 * Computes aAlong / aFinger / aVein for a skinned hand mesh. `jointPos` holds
 * the bind-pose joint positions (75, JOINTS order) in the geometry's space;
 * `skinIndex` must already be in JOINTS order.
 */
export function computeGlassAttributes(
  positions: ArrayLike<number>,
  skinIndex: ArrayLike<number>,
  skinWeight: ArrayLike<number>,
  jointPos: ArrayLike<number>,
): { aAlong: Float32Array; aFinger: Float32Array; aVein: Float32Array } {
  const n = positions.length / 3;
  const P = (j: number, i: number): number => jointPos[j * 3 + i];
  const dist = (a: number, b: number): number =>
    Math.hypot(P(a, 0) - P(b, 0), P(a, 1) - P(b, 1), P(a, 2) - P(b, 2));

  // Arc length from the wrist to each joint along its finger, and each finger's total length.
  const arc = new Float64Array(JOINT_COUNT);
  const total = new Float64Array(5);
  for (let f = 0; f < 5; f++) {
    const chain = FINGER_CHAINS[f];
    let s = dist(0, chain[0]);
    arc[chain[0]] = s;
    for (let k = 1; k < chain.length; k++) {
      s += dist(chain[k - 1], chain[k]);
      arc[chain[k]] = s;
    }
    total[f] = s;
  }
  // Child joint of each non-tip joint (wrist -> middle metacarpal).
  const child = new Int8Array(JOINT_COUNT).fill(-1);
  child[0] = FINGER_CHAINS[2][0];
  for (const chain of FINGER_CHAINS) for (let k = 0; k + 1 < chain.length; k++) child[chain[k]] = chain[k + 1];

  const aAlong = new Float32Array(n);
  const aFinger = new Float32Array(n);
  const aVein = new Float32Array(n * 2);
  const group = new Float64Array(6); // thumb..pinky phalanges, 5 = palm
  const veinGroup = new Float64Array(5);
  for (let v = 0; v < n; v++) {
    const vx = positions[v * 3], vy = positions[v * 3 + 1], vz = positions[v * 3 + 2];
    let est = 0;
    let wsum = 0;
    group.fill(0);
    veinGroup.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[v * 4 + k];
      if (w <= 0) continue;
      const j = skinIndex[v * 4 + k];
      const f = FINGER_OF[j];
      const c = child[j];
      let e: number;
      if (c < 0) {
        e = 1; // tip joint
      } else {
        const dx = P(c, 0) - P(j, 0), dy = P(c, 1) - P(j, 1), dz = P(c, 2) - P(j, 2);
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        let t = ((vx - P(j, 0)) * dx + (vy - P(j, 1)) * dy + (vz - P(j, 2)) * dz) / len;
        if (j === 0) {
          // Wrist: up to the middle metacarpal joint, normalised by the middle finger.
          t = Math.min(Math.max(t, 0), len);
          e = t / total[2];
        } else {
          const prevLen = CHAIN_POS[j] === 0 ? arc[j] : arc[j] - arc[FINGER_CHAINS[f][CHAIN_POS[j] - 1]];
          t = Math.min(Math.max(t, -prevLen), len);
          e = (arc[j] + t) / total[f];
        }
      }
      est += w * e;
      wsum += w;
      // Finger / palm membership.
      if (j === 0) group[5] += w;
      else if (f > 0 && CHAIN_POS[j] === 0) group[5] += w;
      else group[f] += w;
      if (f >= 0) veinGroup[f] += w;
    }
    aAlong[v] = wsum > 0 ? Math.min(1, Math.max(0, est / wsum)) : 0;
    let best = 5;
    for (let g = 0; g < 5; g++) if (group[g] > group[best]) best = g;
    aFinger[v] = best;
    let vein = 2;
    for (let g = 0; g < 5; g++) if (veinGroup[g] > veinGroup[vein]) vein = g;
    // Membership: weight on the vein finger's own phalanges (thumb: whole chain).
    let member = 0;
    for (let k = 0; k < 4; k++) {
      const j = skinIndex[v * 4 + k];
      if (FINGER_OF[j] === vein && (vein === 0 || CHAIN_POS[j] > 0)) member += skinWeight[v * 4 + k];
    }
    aVein[v * 2] = vein;
    aVein[v * 2 + 1] = wsum > 0 ? Math.min(1, member / wsum) : 0;
  }
  return { aAlong, aFinger, aVein };
}

/** Joint positions (75, JOINTS order) of a skeleton's bind pose, from its inverse bind matrices. */
export function bindJointPositions(boneInverses: Matrix4[]): Float64Array {
  const out = new Float64Array(75);
  const m = new Matrix4();
  for (let j = 0; j < JOINT_COUNT; j++) {
    m.copy(boneInverses[j]).invert();
    out[j * 3] = m.elements[12];
    out[j * 3 + 1] = m.elements[13];
    out[j * 3 + 2] = m.elements[14];
  }
  return out;
}

interface SkinData {
  bones: Bone[];
  ibm: Float64Array;
  positions: Float32Array;
  skinIndex: Uint8Array;
  skinWeight: Float32Array;
  jointPos: Float64Array;
}

/** Reads a hand SkinnedMesh's skin with bones remapped to JOINTS order (by name). */
function readSkin(sm: SkinnedMesh): SkinData {
  const geometry = sm.geometry;
  const skeleton = sm.skeleton;
  const slotToJoint = new Uint8Array(skeleton.bones.length);
  const bones: Bone[] = new Array(JOINT_COUNT);
  const inverses: Matrix4[] = new Array(JOINT_COUNT);
  const ibm = new Float64Array(JOINT_COUNT * 16);
  skeleton.bones.forEach((b, slot) => {
    const j = (JOINTS as readonly string[]).indexOf(b.name);
    if (j < 0) throw new Error(`hand-model: unknown bone ${b.name}`);
    slotToJoint[slot] = j;
    bones[j] = b;
    inverses[j] = skeleton.boneInverses[slot];
    ibm.set(skeleton.boneInverses[slot].elements, j * 16);
  });
  for (let j = 0; j < JOINT_COUNT; j++) if (!bones[j]) throw new Error(`hand-model: bone ${JOINTS[j]} missing`);

  // Vertices are in mesh space; fold the (normally identity) bind matrix in.
  const posAttr = geometry.getAttribute('position');
  const n = posAttr.count;
  const positions = new Float32Array(n * 3);
  const e = sm.bindMatrix.elements;
  for (let v = 0; v < n; v++) {
    const x = posAttr.getX(v), y = posAttr.getY(v), z = posAttr.getZ(v);
    positions[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    positions[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    positions[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const siAttr = geometry.getAttribute('skinIndex');
  const swAttr = geometry.getAttribute('skinWeight');
  const skinIndex = new Uint8Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      skinIndex[v * 4 + k] = slotToJoint[siAttr.getComponent(v, k)];
      const w = swAttr.getComponent(v, k);
      skinWeight[v * 4 + k] = w;
      s += w;
    }
    if (s > 0) for (let k = 0; k < 4; k++) skinWeight[v * 4 + k] /= s;
  }
  return { bones, ibm, positions, skinIndex, skinWeight, jointPos: bindJointPositions(inverses) };
}

function setGlassAttributes(geometry: BufferGeometry, skin: SkinData): ReturnType<typeof computeGlassAttributes> {
  const attrs = computeGlassAttributes(skin.positions, skin.skinIndex, skin.skinWeight, skin.jointPos);
  geometry.setAttribute('aAlong', new BufferAttribute(attrs.aAlong, 1));
  geometry.setAttribute('aFinger', new BufferAttribute(attrs.aFinger, 1));
  geometry.setAttribute('aVein', new BufferAttribute(attrs.aVein, 2));
  return attrs;
}

/**
 * Adds aAlong / aFinger / aVein to a generic-hand SkinnedMesh's geometry
 * (e.g. IWSDK's live hand visual) unless it already has them.
 */
export function ensureGlassAttributes(mesh: SkinnedMesh): void {
  if (mesh.geometry.getAttribute('aAlong')) return;
  setGlassAttributes(mesh.geometry, readSkin(mesh));
}

/** Builds a template from a parsed generic-hand glTF scene. */
export function buildHandTemplate(scene: Object3D, hand: Handedness): HandTemplate {
  scene.updateMatrixWorld(true);
  let mesh: SkinnedMesh | null = null;
  scene.traverse((o) => { if (!mesh && (o as SkinnedMesh).isSkinnedMesh) mesh = o as SkinnedMesh; });
  if (!mesh) throw new Error(`hand-model: no SkinnedMesh in the ${hand} hand model`);
  const sm = mesh as SkinnedMesh;
  const geometry = sm.geometry;
  const skin = readSkin(sm);
  const { bones, ibm, positions, skinIndex, skinWeight } = skin;
  const n = positions.length / 3;
  const idx = geometry.getIndex();
  const index = idx ? Uint32Array.from(idx.array as ArrayLike<number>) : Uint32Array.from({ length: n }, (_, i) => i);

  // Bind pose from the bone nodes (Armature-relative = model space).
  const bindPos = new Float64Array(75);
  const bindRot = new Float64Array(100);
  for (let j = 0; j < JOINT_COUNT; j++) {
    const b = bones[j];
    bindPos.set([b.position.x, b.position.y, b.position.z], j * 3);
    const q = b.quaternion;
    const s = q.w < 0 ? -1 : 1;
    bindRot.set([q.x * s, q.y * s, q.z * s, q.w * s], j * 4);
  }

  // Weld vertices sharing a position (UV seams), so baked normals are smooth.
  const weld = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let v = 0; v < n; v++) {
    const key = `${Math.round(positions[v * 3] * 1e5)},${Math.round(positions[v * 3 + 1] * 1e5)},${Math.round(positions[v * 3 + 2] * 1e5)}`;
    const r = seen.get(key);
    if (r === undefined) { seen.set(key, v); weld[v] = v; } else weld[v] = r;
  }

  const { aAlong, aFinger, aVein } = setGlassAttributes(geometry, skin);

  return {
    hand, scene, mesh: sm, geometry, bones, vertexCount: n, positions, index,
    skinIndex, skinWeight, ibm, bindPos, bindRot, weld, aAlong, aFinger, aVein,
  };
}

/** Parses a generic-hand GLB already in memory (also used by node tests). */
export async function parseHandTemplate(data: ArrayBuffer, hand: Handedness): Promise<HandTemplate> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  return buildHandTemplate(gltf.scene, hand);
}

/**
 * Loads both hand templates. `baseUrl` is the folder holding right.glb and
 * left.glb (default: the app's public models/ folder).
 */
export async function loadHandTemplates(baseUrl?: string): Promise<{ left: HandTemplate; right: HandTemplate }> {
  const base = baseUrl ?? `${import.meta.env.BASE_URL}models/`;
  const sep = base.endsWith('/') ? '' : '/';
  const loader = new GLTFLoader();
  const [l, r] = await Promise.all([
    loader.loadAsync(`${base}${sep}left.glb`),
    loader.loadAsync(`${base}${sep}right.glb`),
  ]);
  const out = { left: buildHandTemplate(l.scene, 'left'), right: buildHandTemplate(r.scene, 'right') };
  warmUp(out.right);
  return out;
}

/**
 * Runs the bake and shatter code paths once so the JIT has compiled them
 * before the first real cast (cold, a subdivided bake takes ~10x longer).
 */
export function warmUp(template: HandTemplate): void {
  const pos = Float32Array.from(template.bindPos);
  bakePose(template, { hand: template.hand, pos, rot: Float32Array.from(template.bindRot) }, { subdivide: 1 }).dispose();
  const coarse = bakePose(template, { hand: template.hand, pos });
  new Shatter(coarse, { shards: 24 }).dispose();
  coarse.dispose();
}
