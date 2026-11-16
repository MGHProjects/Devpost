/**
 * WebXR Hand Input joint order (XRHand iteration order), shared by the live
 * tracker, the FK hand, casts, the glTF hand skeleton and the share codec.
 */

export const JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

export type JointName = (typeof JOINTS)[number];
export const JOINT_COUNT = 25;

/** Joint indices by name. */
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;

/** Finger ids: 0 thumb, 1 index, 2 middle, 3 ring, 4 pinky. */
export type FingerId = 0 | 1 | 2 | 3 | 4;
export const FINGERS: readonly FingerId[] = [0, 1, 2, 3, 4];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;

/**
 * Joint index chains per finger, from the base joint to the tip.
 * Thumb: metacarpal, proximal, distal, tip (4 joints).
 * Others: metacarpal, proximal (= MCP knuckle), intermediate, distal, tip (5 joints).
 */
export const FINGER_CHAINS: readonly (readonly number[])[] = [
  [1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
];

/** Tip joint per finger. */
export const TIP = [4, 9, 14, 19, 24] as const;
/** Knuckle (MCP, the "phalanx-proximal" joint) per finger; thumb uses its proximal joint. */
export const KNUCKLE = [2, 6, 11, 16, 21] as const;

/** Bones as joint index pairs (parent -> child), wrist to each metacarpal included. */
export const BONES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24],
];
