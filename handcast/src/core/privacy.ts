/**
 * Cast privacy: before a glass hand leaves the device it is RETARGETED onto
 * the canonical FK hand, so bone lengths, palm proportions and joint radii
 * (hand-size biometrics) are never published. Only the joint rotations (the
 * shape the player made) and the wrist position (where they put it) survive.
 *
 * For each bone parent -> child the canonical offset is expressed in the
 * parent's rest frame, offset = inv(R_parent_rest) * (p_child_rest -
 * p_parent_rest), and re-applied with the cast's own parent rotation:
 * p_child = p_parent + R_parent_cast * offset. An FK pose therefore maps to
 * itself. Poses without rotations fall back to keeping each bone's direction
 * and resetting its length. Pure, no three.js.
 */
import { castToPose, JOINT_PARENT, poseToCast } from './codec';
import { restPose } from './fk-hand';
import { DEFAULT_RADII } from './hand-bind';
import { qconj, qrot } from './math3';
import type { CastData, HandPose, Handedness } from './types';

interface Canon {
  /** Child offset in the parent's rest frame (75; wrist entry unused). */
  offset: Float64Array;
  /** Rest bone length per child joint (25; wrist entry unused). */
  length: Float64Array;
}

function buildCanon(hand: Handedness): Canon {
  const { pos, rot } = restPose(hand);
  const offset = new Float64Array(75);
  const length = new Float64Array(25);
  const inv = [0, 0, 0, 1];
  const d = [0, 0, 0];
  for (let j = 1; j < 25; j++) {
    const p = JOINT_PARENT[j];
    for (let i = 0; i < 3; i++) d[i] = pos[j * 3 + i] - pos[p * 3 + i];
    length[j] = Math.hypot(d[0], d[1], d[2]);
    qconj(inv, 0, rot, p * 4);
    qrot(offset, j * 3, inv, 0, d, 0);
  }
  return { offset, length };
}

let canon: Record<Handedness, Canon> | null = null;
function getCanon(hand: Handedness): Canon {
  canon ??= { right: buildCanon('right'), left: buildCanon('left') };
  return canon[hand];
}

const q = [0, 0, 0, 1];
const v = [0, 0, 0];

/**
 * Same hand shape on the canonical hand: keeps rotations and the wrist
 * position, rebuilds every other joint from canonical bone offsets, and
 * resets radii to the defaults. Allocates a new pose.
 */
export function retargetCast(pose: HandPose): HandPose {
  const c = getCanon(pose.hand);
  const out = new Float32Array(75);
  for (let i = 0; i < 3; i++) out[i] = pose.pos[i];
  const rot = pose.rot && pose.rot.length >= 100 ? pose.rot : null;
  // Joints are ordered so every parent precedes its children.
  for (let j = 1; j < 25; j++) {
    const p = JOINT_PARENT[j];
    if (rot) {
      const o = p * 4;
      const l = Math.hypot(rot[o], rot[o + 1], rot[o + 2], rot[o + 3]) || 1;
      for (let i = 0; i < 4; i++) q[i] = rot[o + i] / l;
      qrot(v, 0, q, 0, c.offset, j * 3);
    } else {
      for (let i = 0; i < 3; i++) v[i] = pose.pos[j * 3 + i] - pose.pos[p * 3 + i];
      const l = Math.hypot(v[0], v[1], v[2]);
      const s = l > 1e-9 ? c.length[j] / l : 0;
      for (let i = 0; i < 3; i++) v[i] *= s;
    }
    for (let i = 0; i < 3; i++) out[j * 3 + i] = out[p * 3 + i] + v[i];
  }
  const res: HandPose = { hand: pose.hand, pos: out, radii: Float32Array.from(DEFAULT_RADII) };
  if (rot) res.rot = Float32Array.from(rot as ArrayLike<number>);
  return res;
}

/** A cast safe to publish: retargeted to canonical proportions, tints kept, nothing else. */
export function anonymizeCast(cast: CastData): CastData {
  return poseToCast(retargetCast(castToPose(cast)), cast.tints);
}
