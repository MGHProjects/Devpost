/**
 * Core puzzle data model. Pure data, no rendering, no DOM: shared by the
 * runtime, the level generator and the test suite.
 *
 * Grid coordinates: `x` grows to the player's right, `y` grows away from the
 * player. Directions are multiples of 45°, counter-clockwise from +x:
 * 0 = E, 1 = NE, 2 = N (away), 3 = NW, 4 = W, 5 = SW, 6 = S (toward player), 7 = SE.
 */

/** Light colour as an additive RGB bitmask. */
export const Color = {
  R: 1,
  G: 2,
  B: 4,
  Y: 3, // R + G
  M: 5, // R + B
  C: 6, // G + B
  W: 7, // R + G + B
} as const;
export type ColorMask = number;

export type PieceKind =
  | 'emitter'
  | 'target'
  | 'wall'
  | 'mirror'
  | 'splitter'
  | 'prism'
  | 'filter';

/**
 * How the player may interact with a piece already on the board.
 * - `fixed`: cannot move or rotate.
 * - `rotate`: stays on its cell but can be turned.
 * - `free`: can be picked up, moved and turned (tray pieces are always free).
 */
export type Lock = 'fixed' | 'rotate' | 'free';

export interface Piece {
  id: number;
  kind: PieceKind;
  x: number;
  y: number;
  /**
   * Emitters: beam direction 0..7 (45° steps).
   * Mirrors / splitters: mirror-line angle 0..7 in 22.5° steps.
   * Others: ignored.
   */
  rot: number;
  /** Emitter colour, filter pass colour or target required colour. */
  color: ColorMask;
  lock: Lock;
  /** `false` while the piece is waiting in the tray. */
  onBoard: boolean;
}

export interface PieceSpec {
  kind: PieceKind;
  x?: number;
  y?: number;
  rot?: number;
  color?: ColorMask;
  lock?: Lock;
}

export interface LevelDef {
  id: string;
  name: string;
  /** Board is size × size cells. */
  size: number;
  /** Pieces that start on the board. */
  board: PieceSpec[];
  /** Pieces the player must place (kind + colour; orientation is free). */
  tray: PieceSpec[];
  /**
   * A known solution: final positions/rotations for every tray piece (in tray
   * order) and rotations for `rotate`-locked board pieces (by board index).
   * Used by tests and the hint system; never shown wholesale.
   */
  solution: {
    tray: { x: number; y: number; rot: number }[];
    rotations?: Record<number, number>;
  };
  /** Optional one-line coaching shown on the first attempt. */
  hint?: string;
}

/** Directions as grid deltas, indexed by direction 0..7. */
export const DIR_DX = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DIR_DY = [0, 1, 1, 1, 0, -1, -1, -1] as const;

export const mod8 = (n: number): number => ((n % 8) + 8) % 8;

export function colorName(mask: ColorMask): string {
  switch (mask) {
    case Color.R:
      return 'red';
    case Color.G:
      return 'green';
    case Color.B:
      return 'blue';
    case Color.Y:
      return 'yellow';
    case Color.M:
      return 'magenta';
    case Color.C:
      return 'cyan';
    case Color.W:
      return 'white';
    default:
      return 'dark';
  }
}

/** Pieces whose orientation matters (and can therefore be turned). */
export const isRotatable = (kind: PieceKind): boolean =>
  kind === 'mirror' || kind === 'splitter';
