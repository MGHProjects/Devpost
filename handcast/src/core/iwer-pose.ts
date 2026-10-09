/**
 * Export FK hand poses to the IWER emulator (IWSDK's in-browser WebXR
 * emulator) so desktop tests can drive "real" hand-tracking input.
 *
 * HOW IWER BUILDS A HAND (iwer/lib/device/XRHandInput.js, v1.x)
 * - Each XRHandInput keeps `this[P_HAND_INPUT] = { poseId, poses }`, where
 *   P_HAND_INPUT = Symbol('@iwer/xr-hand-input') (module-private: find it via
 *   Object.getOwnPropertySymbols(hand).find(s => s.description === '@iwer/xr-hand-input')).
 * - `poses` is the SAME object for both hands (oculusHandConfig.poses:
 *   { default, pinch, point }), so a custom pose needs a per-hand key.
 * - Every frame (onFrameStart -> updateHandPose) each joint's offset matrix is
 *   interpolate(poses[poseId], poses.pinch, pinchValue) (lerp translation,
 *   slerp rotation); at pinchValue 0 it is exactly poses[poseId]. Keep pinch
 *   at 0 (setPinchValueImmediate(0)) or the pose blends toward IWER's pinch.
 * - The configs are authored as LEFT hands. For the right hand IWER mirrors
 *   each matrix across X (M' = S M S, S = diag(-1, 1, 1, 1)) after
 *   interpolation. iwerPoseFromWorld(..., 'right') pre-applies that mirror, so
 *   the result can be registered as-is on the right hand.
 * - The joint world matrix = hand transform (hand.position, hand.quaternion,
 *   i.e. the target-ray space) * offsetMatrix. Radii are lerped the same way.
 * - The `poseId` setter only accepts keys present in `poses` (warns
 *   otherwise), so add the pose first, then select it. Mutating the
 *   dictionary entry later is picked up on the next frame.
 *
 * REGISTERING A CUSTOM POSE FROM A TEST (Playwright):
 *   const cfg = iwerPoseFromWorld(w.pos, w.rot, pose.radii, handPos, handQuat, 'right');
 *   await page.evaluate(`(${IWER_REGISTER_POSE_JS})(${JSON.stringify({
 *     hand: 'right', poseId: 'hc-right', pose: cfg, position: handPos, quaternion: handQuat })})`);
 * (A string is needed: Playwright only passes `arg` to real functions.)
 * where `w = benchToWorld(pose, benchPos, benchQuat)` puts an FK bench pose
 * into the emulator's world (reference) space.
 *
 * Pure TS, no three.js, no DOM (the snippet is only a string).
 */
import type { HandPose, Handedness, Quat, V3 } from './types';
import { JOINTS } from './joints';
import { qconj, qfromBasis, qmul, qrot } from './math3';

export interface IwerJointTransform {
  /** 4x4 column-major, relative to the emulated hand's transform. */
  offsetMatrix: number[];
  radius: number;
}

export interface IwerHandPose {
  jointTransforms: Record<string, IwerJointTransform>;
}

/** Any IWER-style config as input (IWER's own configs hold gl-matrix mat4 = Float32Array). */
export interface IwerHandPoseLike {
  jointTransforms: Record<string, { offsetMatrix: ArrayLike<number>; radius: number }>;
}

/** IWER's left->right mirror, element-wise on a column-major matrix (= S M S). */
const MIRROR = [1, -1, -1, 0, -1, 1, 1, 0, -1, 1, 1, 0, -1, 1, 1, 1];

/**
 * Converts world-space joint poses (25 x pos, 25 x quat) into an IWER hand
 * pose config relative to the emulated hand transform (handPos, handQuat).
 * `hand` = the IWER hand it will be registered on: 'right' pre-mirrors the
 * matrices (IWER mirrors right-hand configs); omitted or 'left' = raw offsets.
 */
export function iwerPoseFromWorld(
  posWorld: ArrayLike<number>,
  rotWorld: ArrayLike<number>,
  radii: ArrayLike<number>,
  handPos: V3,
  handQuat: Quat,
  hand?: Handedness,
): IwerHandPose {
  const inv = [0, 0, 0, 1];
  qconj(inv, 0, handQuat, 0);
  const q = [0, 0, 0, 1];
  const t = [0, 0, 0];
  const d = [0, 0, 0];
  const jointTransforms: Record<string, IwerJointTransform> = {};
  for (let j = 0; j < 25; j++) {
    for (let i = 0; i < 3; i++) d[i] = posWorld[j * 3 + i] - handPos[i];
    qrot(t, 0, inv, 0, d, 0);
    qmul(q, 0, inv, 0, rotWorld, j * 4);
    const m = matrixFromQuatPos(q, t);
    if (hand === 'right') for (let i = 0; i < 16; i++) m[i] *= MIRROR[i];
    jointTransforms[JOINTS[j]] = { offsetMatrix: m, radius: radii[j] };
  }
  return { jointTransforms };
}

/**
 * Inverse of iwerPoseFromWorld: world-space joint positions, quaternions and
 * radii of an IWER hand pose config (e.g. IWER's own relaxed / pinch / point)
 * under the hand transform. `hand` = 'right' applies IWER's right-hand mirror.
 */
export function iwerPoseToWorld(
  config: IwerHandPoseLike,
  handPos: V3,
  handQuat: Quat,
  hand?: Handedness,
): { pos: number[]; rot: number[]; radii: number[] } {
  const pos: number[] = new Array(75);
  const rot: number[] = new Array(100);
  const radii: number[] = new Array(25);
  const m = new Array<number>(16);
  const q = [0, 0, 0, 1];
  const t = [0, 0, 0];
  for (let j = 0; j < 25; j++) {
    const jt = config.jointTransforms[JOINTS[j]];
    for (let i = 0; i < 16; i++) m[i] = jt.offsetMatrix[i] * (hand === 'right' ? MIRROR[i] : 1);
    qfromBasis(q, 0, m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]);
    qrot(t, 0, handQuat, 0, [m[12], m[13], m[14]], 0);
    for (let i = 0; i < 3; i++) pos[j * 3 + i] = t[i] + handPos[i];
    qmul(rot, j * 4, handQuat, 0, q, 0);
    radii[j] = jt.radius;
  }
  return { pos, rot, radii };
}

/** Applies a rigid bench -> world transform (bench origin at benchPos, rotated by benchQuat). */
export function benchToWorld(pose: HandPose, benchPos: V3, benchQuat: Quat): { pos: number[]; rot: number[] } {
  const pos: number[] = new Array(75);
  const rot: number[] = new Array(100);
  const t = [0, 0, 0];
  for (let j = 0; j < 25; j++) {
    qrot(t, 0, benchQuat, 0, pose.pos, j * 3);
    for (let i = 0; i < 3; i++) pos[j * 3 + i] = t[i] + benchPos[i];
    if (pose.rot) qmul(rot, j * 4, benchQuat, 0, pose.rot, j * 4);
    else for (let i = 0; i < 4; i++) rot[j * 4 + i] = benchQuat[i];
  }
  return { pos, rot };
}

/** Column-major 4x4 from a unit quaternion and a translation. */
export function matrixFromQuatPos(q: ArrayLike<number>, t: ArrayLike<number>): number[] {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    t[0], t[1], t[2], 1,
  ];
}

/**
 * In-page snippet (a JS function source) that registers and selects a custom
 * pose on IWER's emulated hand. Argument:
 *   { hand: 'left'|'right', poseId: string, pose: IwerHandPose,
 *     position?: [x,y,z], quaternion?: [x,y,z,w], device?: string }
 * (`device` names the global holding the IWER XRDevice; default 'IWER_DEVICE').
 * It also zeroes the pinch so the pose is not blended toward IWER's pinch,
 * and returns true on success.
 */
export const IWER_REGISTER_POSE_JS = `(arg) => {
  const dev = globalThis[arg.device || 'IWER_DEVICE'];
  const h = dev && dev.hands && dev.hands[arg.hand];
  if (!h) return false;
  const P = Object.getOwnPropertySymbols(h).find((s) => s.description === '@iwer/xr-hand-input');
  if (!P) return false;
  h[P].poses[arg.poseId] = arg.pose;
  h.poseId = arg.poseId;
  if (arg.position) h.position.set(arg.position[0], arg.position[1], arg.position[2]);
  if (arg.quaternion) h.quaternion.set(arg.quaternion[0], arg.quaternion[1], arg.quaternion[2], arg.quaternion[3]);
  h.setPinchValueImmediate(0);
  return h.poseId === arg.poseId;
}`;
