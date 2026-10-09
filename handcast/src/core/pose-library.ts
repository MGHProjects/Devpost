/**
 * Canonical hand shapes for the FK hand (core/fk-hand.ts): used by level
 * solutions, the generator, tests, demo/attract mode and the IWER emulator.
 *
 * Extension semantics (as the optics module measures them): a finger is
 * EXTENDED when |tip - knuckle| / (bone lengths knuckle..tip) > 0.88. Every
 * finger below with curl 0 (or the 'relaxed' 0.15) reads > 0.9; every curl
 * >= 0.45 reads < 0.75. EXTENDED lists the intended open set per pose.
 *
 * Lifts are chosen so the lowest joint sphere clears the bench by a few mm.
 */
import type { HandPose, Handedness, V2 } from './types';
import { fkPose, type PoseParams } from './fk-hand';

export type PoseName =
  | 'flat' | 'spread' | 'point' | 'peace' | 'three' | 'four' | 'L' | 'shaka'
  | 'rock' | 'thumb' | 'middle' | 'pinky' | 'fist' | 'blade' | 'relaxed' | 'claw';

export type PoseShape = Omit<PoseParams, 'hand' | 'at' | 'yaw'>;

export const POSES: Record<PoseName, PoseShape> = {
  // Palm-down light guides.
  flat: { curl: [0, 0, 0, 0, 0], spread: 0, thumbAbduct: -0.3, lift: 0.044 },
  spread: { curl: [0, 0, 0, 0, 0], spread: 1, thumbAbduct: 0.5, lift: 0.044 },
  point: { curl: [1, 0, 1, 1, 1], lift: 0.058 },
  peace: { curl: [1, 0, 0, 1, 1], spread: 1, lift: 0.058 },
  three: { curl: [1, 0, 0, 0, 1], spread: 0.6, lift: 0.055 },
  four: { curl: [1, 0, 0, 0, 0], spread: 0.6, lift: 0.055 },
  L: { curl: [0, 0, 1, 1, 1], thumbAbduct: 1, lift: 0.058 },
  shaka: { curl: [0, 1, 1, 1, 0], thumbAbduct: 0.8, spread: 0.6, lift: 0.065 },
  rock: { curl: [1, 0, 1, 1, 0], spread: 0.5, lift: 0.058 },
  thumb: { curl: [0, 1, 1, 1, 1], thumbAbduct: 0.6, lift: 0.065 },
  middle: { curl: [1, 1, 0, 1, 1], lift: 0.065 },
  pinky: { curl: [1, 1, 1, 1, 0], spread: 0.5, lift: 0.065 },
  // Absorber.
  fist: { curl: [1, 1, 1, 1, 1], lift: 0.065 },
  // Mirror: flat, fingers together, standing on the pinky edge.
  blade: { curl: [0, 0, 0, 0, 0], spread: 0, thumbAbduct: -1, roll: Math.PI / 2, lift: 0.049 },
  // Slight natural curl: everything still reads as extended.
  relaxed: { curl: [0.15, 0.15, 0.15, 0.15, 0.18], spread: 0.25, pitch: -0.2, lift: 0.05 },
  // Half-curled fingers: tips still ahead of the knuckles but low; nothing extended.
  claw: { curl: [0.45, 0.45, 0.45, 0.45, 0.45], spread: 0.3, lift: 0.076 },
};

/** Intended extended fingers (thumb..pinky) per pose, per the 0.88 rule. */
export const EXTENDED: Record<PoseName, [boolean, boolean, boolean, boolean, boolean]> = {
  flat: [true, true, true, true, true],
  spread: [true, true, true, true, true],
  point: [false, true, false, false, false],
  peace: [false, true, true, false, false],
  three: [false, true, true, true, false],
  four: [false, true, true, true, true],
  L: [true, true, false, false, false],
  shaka: [true, false, false, false, true],
  rock: [false, true, false, false, true],
  thumb: [true, false, false, false, false],
  middle: [false, false, true, false, false],
  pinky: [false, false, false, false, true],
  fist: [false, false, false, false, false],
  blade: [true, true, true, true, true],
  relaxed: [true, true, true, true, true],
  claw: [false, false, false, false, false],
};

export const POSE_NAMES = Object.keys(POSES) as PoseName[];

/**
 * A named pose for `hand` with its palm centre at `at` (bench [x, z]) and the
 * hand axis heading `yaw` (atan2(z, x); default -PI/2 = pointing away from
 * the player). `overrides` replace any shape parameter (e.g. lift, roll).
 */
export function canonicalPose(
  name: PoseName,
  hand: Handedness,
  at: V2,
  yaw?: number,
  overrides?: Partial<PoseShape>,
): HandPose {
  const shape = POSES[name];
  return fkPose({
    ...shape,
    ...overrides,
    curl: (overrides?.curl ?? shape.curl).slice() as PoseParams['curl'],
    hand,
    at,
    yaw,
  });
}
