/**
 * HANDCAST core contracts. Pure data, no three.js, no DOM: shared by the
 * runtime, the generator, the community Worker and the tests.
 *
 * COORDINATES
 * - "Bench space": right-handed, metres. Origin = centre of the bench top
 *   (the real table surface). +X to the player's right, +Y up, +Z toward the
 *   player. The bench spans x in [-w/2, w/2], z in [-d/2, d/2].
 * - The light sheet is the bench plane seen from above: 2D points are
 *   [x, z] in bench space (so "forward, away from the player" is -Z).
 * - Angles in the 2D plane: atan2(z, x) convention, i.e. direction
 *   (cos a, sin a) in (x, z). Forward (away from the player) is -PI/2.
 */

/** Light colour as an additive RGB bitmask (Prism Song convention). */
export const Color = { R: 1, G: 2, B: 4, Y: 3, M: 5, C: 6, W: 7 } as const;
export type ColorMask = number;

export type V2 = [number, number];
export type V3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export type Handedness = 'left' | 'right';

/**
 * A full hand pose in bench space. Positions are required; orientations are
 * needed only to skin the glass mesh (they follow the WebXR joint convention:
 * joint -Z points along the bone toward the fingertip, +Y out of the back of
 * the hand / finger).
 */
export interface HandPose {
  hand: Handedness;
  /** 25 joints x 3 (x, y, z), bench space, metres. Order = core/joints.ts. */
  pos: Float32Array | number[];
  /** 25 joints x 4 (x, y, z, w), bench space. Optional. */
  rot?: Float32Array | number[];
  /** 25 joint radii in metres. Optional (defaults from the FK hand). */
  radii?: Float32Array | number[];
}

/** Per-finger colour filter applied to light leaving that finger. 0 = blocks. */
export type FingerTints = [ColorMask, ColorMask, ColorMask, ColorMask, ColorMask];
export const NO_TINT: FingerTints = [7, 7, 7, 7, 7];

/** How a hand behaves as an optic, decided from its shape. */
export type HandMode =
  | 'fan' // glass light-guide: light entering one open end leaves every other open fingertip
  | 'blade' // silver mirror: the palm edge (hand standing on its pinky side) reflects
  | 'stone' // fist: absorbs everything it covers
  | 'none'; // not shaped as anything (e.g. palm vertical with curled fingers): absorbs

export type PortKind = 'finger' | 'wrist';

/** An "open end" of a glass hand in the light sheet. */
export interface Port {
  kind: PortKind;
  /** 0..4 for fingers (thumb..pinky); -1 for the wrist. */
  finger: number;
  /** Centre of the catch circle, 2D bench coords. */
  p: V2;
  /** Unit direction light leaves along (fingers) or arrives from (wrist: points away from fingers). */
  dir: V2;
  /** Catch radius in metres. */
  r: number;
  /** Whether this port is open (extended finger). Wrist is always open (receive only). */
  open: boolean;
  /** Height of the port above the bench (m), for drawing beams from real fingertips. */
  y?: number;
}

/** 2D capsule (stadium) for hand body occlusion. */
export interface Capsule2 {
  a: V2;
  b: V2;
  r: number;
}

/** The optical abstraction of one hand (live or cast), in the light sheet. */
export interface HandOptic {
  id: string; // stable id, e.g. 'cast-3' or 'live-right'
  hand: Handedness;
  mode: HandMode;
  live: boolean;
  /** Ports: index 0..4 = fingers thumb..pinky (present even if closed), 5 = wrist. */
  ports: Port[];
  /** Body silhouette: capsules for bones + palm, absorbs light that misses ports. */
  body: Capsule2[];
  /** Palm polygon (convex, CCW) in 2D. Part of the body. */
  palm: V2[];
  /** Blade mode: the mirror segment. */
  mirror?: { a: V2; b: V2 };
  /** Palm centre in 2D (the "foot" of a cast, used for nudging). */
  center: V2;
  /** Height of the palm centre above the bench (m). */
  height: number;
  tints: FingerTints;
}

// ----------------------------------------------------------------- levels

export interface Lamp {
  p: V2;
  /** Direction angle (radians, atan2(z, x) convention). */
  a: number;
  color: ColorMask;
}

/** A pool of light on the bench: any port (or the palm centre) inside receives it. */
export interface Well {
  p: V2;
  r: number;
  color: ColorMask;
}

export interface Crystal {
  p: V2;
  color: ColorMask;
  /** MIDI note override; otherwise assigned from the chapter chord. */
  note?: number;
}

/** Must stay dark. Any light wakes it and blocks the solve. */
export interface Hush {
  p: V2;
}

export interface Segment {
  a: V2;
  b: V2;
}

/** Ink pot: touching a fingertip to it tints that finger (P1). */
export interface Ink {
  p: V2;
  color: ColorMask;
}

/** A frozen hand stored in a level (proof of solve, maker's hand, ghost). */
export interface CastData {
  hand: Handedness;
  /** 75 numbers: joint positions in millimetres (bench space), rounded. */
  pos: number[];
  /** 100 numbers: joint quaternions * 10000, rounded. Optional. */
  rot?: number[];
  tints?: number[];
}

export interface LevelDef {
  v: 1;
  id: string;
  name: string;
  /** Bench size in metres (x width, z depth). Typical 0.44 x 0.30. */
  bench: { w: number; d: number };
  /** Maximum number of glass hands. */
  budget: number;
  lamps: Lamp[];
  wells: Well[];
  crystals: Crystal[];
  hush: Hush[];
  walls: Segment[];
  mirrors: Segment[];
  inks?: Ink[];
  /** Reference solution (glass hands that solve it). */
  solution?: CastData[];
  hint?: string;
  author?: string;
  /** Chapter/music context. */
  chapter?: number;
  index?: number;
}

// ----------------------------------------------------------------- tracing

export type TargetState = 'off' | 'partial' | 'lit' | 'wrong';

export interface BeamSeg {
  a: V2;
  b: V2;
  color: ColorMask;
  /** Path length (m) from the light source to `a`, for reveal animation. */
  d0: number;
  /** True if this beam passed through a live (not yet cast) hand. */
  live: boolean;
  /** Set when aim assist bent this ray onto a target. */
  assisted?: boolean;
  /** Beam heights above the bench at a / b when they differ from the light sheet (hand ports). */
  ya?: number;
  yb?: number;
}

export interface HandIO {
  id: string;
  /** Colour received by each port (index as HandOptic.ports). */
  inMask: number[];
  /** Colour emitted by each port. */
  outMask: number[];
  /** Total colour carried inside the hand. */
  carried: ColorMask;
}

export interface TraceResult {
  segments: BeamSeg[];
  crystals: { received: ColorMask; state: TargetState }[];
  hush: { received: ColorMask; awake: boolean }[];
  hands: HandIO[];
  /** All crystals lit, no hush awake (ignores the budget). */
  solved: boolean;
}

export interface TraceOptions {
  /** Aim-assist cone half-angle in radians (default 6 deg). 0 disables. */
  assist?: number;
  /** Maximum ray bounces/transfers per path (default 12). */
  maxDepth?: number;
}
