/**
 * Forward-kinematics hand: builds full 25-joint WebXR hand poses (positions,
 * joint orientations, radii) in bench space from a handful of parameters
 * (per-finger curl, spread, placement on the bench, yaw / roll / pitch).
 *
 * The rest pose comes from the bind pose of the WebXR generic-hand GLBs
 * (core/hand-bind.ts), re-expressed in the CANONICAL HAND FRAME: wrist at the
 * origin, palm down (back of the hand +Y, palm normal -Y), the hand axis
 * wrist -> middle knuckle along -Z, right thumb on -X (left thumb on +X). The
 * frame is fitted from the data: the hand axis maps to -Z and the palm normal
 * (K_index - W) x (K_pinky - W) (negated for the left hand) maps to -Y. The
 * fingers are then straightened along -Z from their knuckles (parallel, no
 * splay) and the thumb laid near the palm plane, so curl = 0, spread = 0 is a
 * flat hand.
 *
 * Kinematics run in "ideal" joint frames (-Z along the bone, +Y dorsal,
 * so flexion is a rotation about local -X). The reported orientation of each
 * joint is ideal * rollOffset, where rollOffset is the constant difference to
 * the GLB bind frame (mostly a small roll about the bone), so a mesh skinned
 * with the GLB's inverse bind matrices deforms correctly with these poses.
 *
 * Pure TS (no three.js). fkPoseInto() reuses its output buffers and module
 * scratch arrays: it does not allocate.
 */
import type { HandPose, Handedness, V2, V3 } from './types';
import { BIND_LEFT_POS, BIND_LEFT_ROT, BIND_RIGHT_POS, BIND_RIGHT_ROT, DEFAULT_RADII } from './hand-bind';
import { FINGER_CHAINS } from './joints';
import {
  qaxis, qconj, qfromBasis, qfromTo, qlook, qmul, qrot, v3cross, v3norm,
} from './math3';

export type Curl5 = [number, number, number, number, number];

export interface PoseParams {
  hand: Handedness;
  /** Per finger, thumb..pinky: 0 straight .. 1 fully curled. */
  curl: Curl5;
  /** 0 fingers together .. 1 wide. Also abducts the thumb a little. */
  spread?: number;
  /** Palm-centre position in the bench plane, [x, z]. */
  at: V2;
  /**
   * Heading of the hand axis (wrist -> middle knuckle) projected on the bench,
   * atan2(z, x) convention. Default -PI/2 = fingers pointing away from the player.
   */
  yaw?: number;
  /**
   * Rotation about the hand axis, mirrored per hand so that positive roll
   * always lowers the PINKY edge: 0 = palm down, +PI/2 = BLADE (hand standing
   * on its pinky edge, palm facing the thumb's original side: -X for a right
   * hand pointing forward, +X for a left hand), PI = palm up.
   */
  roll?: number;
  /** Fingers tilted down toward the bench (+), radians, about the hand's lateral axis. */
  pitch?: number;
  /** Palm-centre height above the bench, metres. Default 0.035. */
  lift?: number;
  /** Extra thumb abduction away from the index in the palm plane: -1 tucked .. 0 natural .. 1 wide ("L"). */
  thumbAbduct?: number;
}

export const DEFAULT_LIFT = 0.035;
const DEG = Math.PI / 180;

/** Max flexion at curl = 1 (radians). Fingers: MCP, PIP, DIP. */
const MCP_MAX = 85 * DEG;
const PIP_MAX = 100 * DEG;
const DIP_MAX = 70 * DEG;
/** Thumb: CMC opposition (roll under the palm), CMC adduction, MCP, IP. */
const THUMB_OPP_MAX = 55 * DEG;
const THUMB_ADD_MAX = 20 * DEG;
const THUMB_MCP_MAX = 45 * DEG;
const THUMB_IP_MAX = 105 * DEG;
/** Finger abduction at spread = 1, thumb..pinky (+ = away from the thumb). */
const SPREAD_MAX = [0, -14 * DEG, 0, 11 * DEG, 18 * DEG];
const THUMB_SPREAD = 25 * DEG;
const THUMB_ABDUCT = 40 * DEG;
/** Rest thumb heading: angle from the hand axis toward the thumb side, and downward tilt. */
const THUMB_REST_YAW = 38 * DEG;
const THUMB_REST_TILT = 4 * DEG;

/**
 * Curl easing: joints flex faster early, so a finger reads clearly as curled
 * (|tip - knuckle| / chain length < 0.8) from curl ~0.35 and as extended
 * (> 0.88) below ~0.2, while curl = 1 hits the max angles above.
 */
export function curlEase(c: number): number {
  const k = c < 0 ? 0 : c > 1 ? 1 : c;
  return 1 - (1 - k) * (1 - k);
}

interface Rig {
  /** Joint offset in the parent's ideal frame (75); wrist entry unused. */
  localPos: Float64Array;
  /** Ideal rest frame relative to the parent's ideal rest frame (100). */
  localRot: Float64Array;
  /** Reported orientation = ideal * rollOffset (100). */
  rollOffset: Float64Array;
  /** Rest pose in the canonical hand frame (75 / 100, reported orientations). */
  restPos: Float64Array;
  restRot: Float64Array;
  /** Thumb CMC axes in the thumb's ideal rest frame: palm normal (+Y hand) and hand axis (+Z hand). */
  thumbYLocal: Float64Array;
  thumbZLocal: Float64Array;
  /** Palm centre (wrist + middle knuckle) / 2 in the canonical frame. */
  palmCenter: Float64Array;
}

const PARENT = new Int8Array(25).fill(-1);
for (const chain of FINGER_CHAINS) chain.forEach((j, i) => (PARENT[j] = i === 0 ? 0 : chain[i - 1]));

function buildRig(hand: Handedness): Rig {
  const bp = hand === 'right' ? BIND_RIGHT_POS : BIND_LEFT_POS;
  const br = hand === 'right' ? BIND_RIGHT_ROT : BIND_LEFT_ROT;
  const side = hand === 'right' ? 1 : -1; // thumb is on -side * X
  const rel = (j: number): number[] => [bp[j * 3] - bp[0], bp[j * 3 + 1] - bp[1], bp[j * 3 + 2] - bp[2]];

  // Canonical frame from the data: hand axis -> -Z, palm normal -> -Y.
  const axis = rel(11);
  v3norm(axis, 0, axis, 0);
  const n = [0, 0, 0];
  v3cross(n, 0, rel(6), 0, rel(21), 0);
  v3norm(n, 0, n, 0);
  const d = n[0] * axis[0] + n[1] * axis[1] + n[2] * axis[2];
  const up = [0, 1, 2].map((i) => -side * (n[i] - d * axis[i])); // back of the hand
  v3norm(up, 0, up, 0);
  const ez = axis.map((v) => -v);
  const ex = [0, 0, 0];
  v3cross(ex, 0, up, 0, ez, 0);
  const qBasis = [0, 0, 0, 1];
  qfromBasis(qBasis, 0, ex[0], ex[1], ex[2], up[0], up[1], up[2], ez[0], ez[1], ez[2]);
  const qc = [0, 0, 0, 1];
  qconj(qc, 0, qBasis, 0);

  // Bind pose in the canonical frame.
  const cp = new Float64Array(75);
  const cr = new Float64Array(100);
  for (let j = 0; j < 25; j++) {
    const p = rel(j);
    qrot(cp, j * 3, qc, 0, p, 0);
    qmul(cr, j * 4, qc, 0, br, j * 4);
  }

  const restPos = new Float64Array(75);
  const restRot = new Float64Array(100);
  const ideal = new Float64Array(100);
  const bindDir = [0, 0, 0];
  const newDir = [0, 0, 0];
  const swing = [0, 0, 0, 1];
  const yUp = [0, 1, 0];
  const setDir = (o: number[], from: number, to: number): void => {
    for (let i = 0; i < 3; i++) o[i] = cp[to * 3 + i] - cp[from * 3 + i];
    v3norm(o, 0, o, 0);
  };

  // Wrist: position origin, orientation from the bind.
  for (let i = 0; i < 4; i++) restRot[i] = cr[i];
  ideal[3] = 1;

  for (let f = 0; f < 5; f++) {
    const chain = FINGER_CHAINS[f];
    if (f === 0) {
      // Thumb: keep the CMC (metacarpal joint) position; lay the thumb straight
      // along a heading near the palm plane, swinging each bind frame onto it.
      const t = THUMB_REST_YAW;
      newDir[0] = -side * Math.sin(t) * Math.cos(THUMB_REST_TILT);
      newDir[1] = -Math.sin(THUMB_REST_TILT);
      newDir[2] = -Math.cos(t) * Math.cos(THUMB_REST_TILT);
      let pj = chain[0];
      for (let i = 0; i < 3; i++) restPos[pj * 3 + i] = cp[pj * 3 + i];
      for (let k = 0; k < chain.length; k++) {
        const j = chain[k];
        if (k > 0) {
          const len = Math.hypot(cp[j * 3] - cp[pj * 3], cp[j * 3 + 1] - cp[pj * 3 + 1], cp[j * 3 + 2] - cp[pj * 3 + 2]);
          for (let i = 0; i < 3; i++) restPos[j * 3 + i] = restPos[pj * 3 + i] + newDir[i] * len;
        }
        const isTip = k === chain.length - 1;
        if (isTip) {
          for (let i = 0; i < 4; i++) restRot[j * 4 + i] = restRot[pj * 4 + i];
        } else {
          setDir(bindDir, j, chain[k + 1]);
          qfromTo(swing, 0, bindDir, 0, newDir, 0);
          qmul(restRot, j * 4, swing, 0, cr, j * 4);
        }
        pj = j;
      }
      // Thumb ideal frame: the metacarpal's rest frame, shared by the straight chain.
      for (const j of chain) for (let i = 0; i < 4; i++) ideal[j * 4 + i] = restRot[chain[0] * 4 + i];
      continue;
    }
    // Fingers: metacarpal as bound; phalanges straight along -Z from the knuckle.
    const m = chain[0];
    const kn = chain[1];
    for (let i = 0; i < 3; i++) {
      restPos[m * 3 + i] = cp[m * 3 + i];
      restPos[kn * 3 + i] = cp[kn * 3 + i];
    }
    for (let i = 0; i < 4; i++) restRot[m * 4 + i] = cr[m * 4 + i];
    setDir(bindDir, m, kn);
    qlook(ideal, m * 4, bindDir, 0, yUp, 0);
    newDir[0] = 0;
    newDir[1] = 0;
    newDir[2] = -1;
    for (let k = 1; k < chain.length; k++) {
      const j = chain[k];
      if (k > 1) {
        const pj = chain[k - 1];
        const len = Math.hypot(cp[j * 3] - cp[pj * 3], cp[j * 3 + 1] - cp[pj * 3 + 1], cp[j * 3 + 2] - cp[pj * 3 + 2]);
        restPos[j * 3] = restPos[pj * 3];
        restPos[j * 3 + 1] = restPos[pj * 3 + 1];
        restPos[j * 3 + 2] = restPos[pj * 3 + 2] - len;
      }
      if (k === chain.length - 1) {
        for (let i = 0; i < 4; i++) restRot[j * 4 + i] = restRot[chain[k - 1] * 4 + i];
      } else {
        setDir(bindDir, j, chain[k + 1]);
        qfromTo(swing, 0, bindDir, 0, newDir, 0);
        qmul(restRot, j * 4, swing, 0, cr, j * 4);
      }
      ideal[j * 4 + 3] = 1; // identity
    }
  }

  // Local (parent-relative) ideal transforms and roll offsets.
  const localPos = new Float64Array(75);
  const localRot = new Float64Array(100);
  const rollOffset = new Float64Array(100);
  const inv = [0, 0, 0, 1];
  const tmp = [0, 0, 0];
  for (let j = 0; j < 25; j++) {
    qconj(inv, 0, ideal, j * 4);
    qmul(rollOffset, j * 4, inv, 0, restRot, j * 4);
    const p = PARENT[j];
    if (p < 0) continue;
    qconj(inv, 0, ideal, p * 4);
    for (let i = 0; i < 3; i++) tmp[i] = restPos[j * 3 + i] - restPos[p * 3 + i];
    qrot(localPos, j * 3, inv, 0, tmp, 0);
    qmul(localRot, j * 4, inv, 0, ideal, j * 4);
  }

  const thumbYLocal = new Float64Array(3);
  const thumbZLocal = new Float64Array(3);
  qconj(inv, 0, ideal, 4);
  qrot(thumbYLocal, 0, inv, 0, [0, 1, 0], 0);
  qrot(thumbZLocal, 0, inv, 0, [0, 0, 1], 0);

  const palmCenter = new Float64Array(3);
  for (let i = 0; i < 3; i++) palmCenter[i] = (restPos[i] + restPos[33 + i]) / 2;

  return { localPos, localRot, rollOffset, restPos, restRot, thumbYLocal, thumbZLocal, palmCenter };
}

const RIGS: Record<Handedness, Rig> = { right: buildRig('right'), left: buildRig('left') };

/** Rest pose (curl 0, spread 0) in the canonical hand frame: wrist at the origin. */
export function restPose(hand: Handedness): { pos: Float64Array; rot: Float64Array } {
  const r = RIGS[hand];
  return { pos: r.restPos, rot: r.restRot };
}

// ------------------------------------------------------------------ scratch
const sIdeal = new Float64Array(100);
const sPos = new Float64Array(75);
const sArt = new Float64Array(4);
const sTmpQ = new Float64Array(4);
const sTmpQ2 = new Float64Array(4);
const sTmpV = new Float64Array(3);
const sGlobal = new Float64Array(4);
const sRoll = new Float64Array(4);
const sPitch = new Float64Array(4);
const sYaw = new Float64Array(4);
const sCenter = new Float64Array(3);
/** Per joint articulation angles: flexion (about local -X) and abduction (about local +Y). */
const sFlex = new Float64Array(25);
const sAbd = new Float64Array(25);

/** Q_j = Q_parent * localRot_j * art; P_j = P_parent + Q_parent * localPos_j. */
function placeJoint(rig: Rig, j: number, art: Float64Array): void {
  const p = PARENT[j];
  qmul(sTmpQ, 0, sIdeal, p * 4, rig.localRot, j * 4);
  qmul(sIdeal, j * 4, sTmpQ, 0, art, 0);
  qrot(sTmpV, 0, sIdeal, p * 4, rig.localPos, j * 3);
  sPos[j * 3] = sPos[p * 3] + sTmpV[0];
  sPos[j * 3 + 1] = sPos[p * 3 + 1] + sTmpV[1];
  sPos[j * 3 + 2] = sPos[p * 3 + 2] + sTmpV[2];
}

/** art = Ry(abd) * Rx(-flex) in the joint's ideal frame. */
function articulation(flex: number, abd: number): Float64Array {
  qaxis(sTmpQ2, 0, 0, 1, 0, abd);
  qaxis(sArt, 0, 1, 0, 0, -flex);
  qmul(sArt, 0, sTmpQ2, 0, sArt, 0);
  return sArt;
}

/** Allocates a pose with the right buffer sizes (for fkPoseInto). */
export function createHandPose(hand: Handedness): HandPose & { pos: Float32Array; rot: Float32Array; radii: Float32Array } {
  return { hand, pos: new Float32Array(75), rot: new Float32Array(100), radii: Float32Array.from(DEFAULT_RADII) };
}

/** Builds a bench-space hand pose. Allocates the result; see fkPoseInto for the no-allocation variant. */
export function fkPose(p: PoseParams): HandPose {
  return fkPoseInto(p, createHandPose(p.hand));
}

/**
 * Writes the pose for `p` into `out` (pos 75, rot 100, radii 25 must be
 * preallocated, e.g. by createHandPose). Sets out.hand. Returns out.
 */
export function fkPoseInto<T extends HandPose>(p: PoseParams, out: T): T {
  const rig = RIGS[p.hand];
  const side = p.hand === 'right' ? 1 : -1;
  const spread = p.spread ?? 0;

  // Articulation angles.
  for (let f = 1; f < 5; f++) {
    const e = curlEase(p.curl[f]);
    const chain = FINGER_CHAINS[f];
    sFlex[chain[1]] = MCP_MAX * e;
    sFlex[chain[2]] = PIP_MAX * e;
    sFlex[chain[3]] = DIP_MAX * e;
    // + = away from the thumb: about +Y that is toward +X for a right hand.
    sAbd[chain[1]] = -side * SPREAD_MAX[f] * spread;
  }
  const tc = p.curl[0] < 0 ? 0 : p.curl[0] > 1 ? 1 : p.curl[0];
  const te = curlEase(tc);
  sFlex[2] = THUMB_MCP_MAX * te;
  sFlex[3] = THUMB_IP_MAX * curlEase(Math.min(1, tc / 0.6));

  // Wrist.
  sIdeal[0] = 0; sIdeal[1] = 0; sIdeal[2] = 0; sIdeal[3] = 1;
  sPos[0] = 0; sPos[1] = 0; sPos[2] = 0;

  // Thumb CMC: abduct in the palm plane (about hand +Y), then roll under the
  // palm (about the hand axis), both in hand space, expressed in the thumb frame.
  const abd = side * (THUMB_SPREAD * spread + THUMB_ABDUCT * (p.thumbAbduct ?? 0) - THUMB_ADD_MAX * te);
  const ty = rig.thumbYLocal;
  const tz = rig.thumbZLocal;
  qaxis(sArt, 0, tz[0], tz[1], tz[2], side * THUMB_OPP_MAX * te);
  qaxis(sTmpQ2, 0, ty[0], ty[1], ty[2], abd);
  qmul(sArt, 0, sArt, 0, sTmpQ2, 0);
  placeJoint(rig, 1, sArt);
  placeJoint(rig, 2, articulation(sFlex[2], 0));
  placeJoint(rig, 3, articulation(sFlex[3], 0));
  placeJoint(rig, 4, articulation(0, 0));

  for (let f = 1; f < 5; f++) {
    const chain = FINGER_CHAINS[f];
    placeJoint(rig, chain[0], articulation(0, 0));
    placeJoint(rig, chain[1], articulation(sFlex[chain[1]], sAbd[chain[1]]));
    placeJoint(rig, chain[2], articulation(sFlex[chain[2]], 0));
    placeJoint(rig, chain[3], articulation(sFlex[chain[3]], 0));
    placeJoint(rig, chain[4], articulation(0, 0));
  }

  // Global: roll about the hand axis (pinky edge down for +roll), pitch the
  // fingers down, yaw the heading, then put the palm centre at (at, lift).
  qaxis(sRoll, 0, 0, 0, -side, p.roll ?? 0);
  qaxis(sPitch, 0, 1, 0, 0, -(p.pitch ?? 0));
  qaxis(sYaw, 0, 0, 1, 0, -Math.PI / 2 - (p.yaw ?? -Math.PI / 2));
  qmul(sGlobal, 0, sPitch, 0, sRoll, 0);
  qmul(sGlobal, 0, sYaw, 0, sGlobal, 0);
  qrot(sCenter, 0, sGlobal, 0, rig.palmCenter, 0);
  const tx = p.at[0] - sCenter[0];
  const ty2 = (p.lift ?? DEFAULT_LIFT) - sCenter[1];
  const tz2 = p.at[1] - sCenter[2];

  const pos = out.pos;
  const rot = out.rot;
  for (let j = 0; j < 25; j++) {
    qrot(sTmpV, 0, sGlobal, 0, sPos, j * 3);
    pos[j * 3] = sTmpV[0] + tx;
    pos[j * 3 + 1] = sTmpV[1] + ty2;
    pos[j * 3 + 2] = sTmpV[2] + tz2;
    if (!rot) continue;
    qmul(sTmpQ, 0, sIdeal, j * 4, rig.rollOffset, j * 4);
    qmul(sTmpQ, 0, sGlobal, 0, sTmpQ, 0);
    // Keep w >= 0 for stable serialisation.
    const sgn = sTmpQ[3] < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) rot[j * 4 + i] = sTmpQ[i] * sgn;
  }
  if (out.radii) for (let j = 0; j < 25; j++) out.radii[j] = DEFAULT_RADII[j];
  out.hand = p.hand;
  return out;
}

/** Palm centre: (wrist + middle knuckle) / 2, bench space. */
export function palmCenter(pose: HandPose): V3 {
  const a = pose.pos;
  return [(a[0] + a[33]) / 2, (a[1] + a[34]) / 2, (a[2] + a[35]) / 2];
}
