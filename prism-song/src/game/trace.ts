/**
 * Beam tracer: walks every emitter's light across the grid, applying mirrors,
 * splitters, prisms and filters, and reports which colours reach each target.
 * Deterministic and allocation-light enough to run on every board change.
 */

import {
  Color,
  ColorMask,
  DIR_DX,
  DIR_DY,
  LevelDef,
  mod8,
  Piece,
} from './types.js';

export interface BeamSegment {
  /** Grid-space start/end (cell centres, or half a cell past the edge). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: ColorMask;
  /** Path length (in cells) from the emitter to this segment's start. */
  d0: number;
}

export type TargetState = 'off' | 'partial' | 'lit' | 'wrong';

export interface TraceResult {
  segments: BeamSegment[];
  /** Colour mask arriving at each target, keyed by piece id. */
  received: Map<number, ColorMask>;
  targetState: Map<number, TargetState>;
  solved: boolean;
}

export interface PuzzleState {
  size: number;
  pieces: Piece[];
}

const MAX_RAYS = 512;

export function pieceAt(
  state: PuzzleState,
  x: number,
  y: number,
): Piece | undefined {
  for (const p of state.pieces) {
    if (p.onBoard && p.x === x && p.y === y) return p;
  }
  return undefined;
}

export function inBounds(state: PuzzleState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < state.size && y < state.size;
}

export function targetStateFor(need: ColorMask, got: ColorMask): TargetState {
  if (got === 0) return 'off';
  if (got === need) return 'lit';
  if ((got & ~need) !== 0) return 'wrong';
  return 'partial';
}

interface Ray {
  x: number;
  y: number;
  dir: number;
  color: ColorMask;
  dist: number;
}

export function trace(state: PuzzleState): TraceResult {
  const { size } = state;
  const grid: (Piece | undefined)[] = new Array(size * size);
  for (const p of state.pieces) {
    if (p.onBoard && inBounds(state, p.x, p.y)) grid[p.y * size + p.x] = p;
  }

  const segments: BeamSegment[] = [];
  const received = new Map<number, ColorMask>();
  const visited = new Set<number>();
  const queue: Ray[] = [];

  let dist = 0;
  const push = (x: number, y: number, dir: number, color: ColorMask) => {
    if (color === 0) return;
    const key = ((y * size + x) * 8 + dir) * 8 + color;
    if (visited.has(key) || visited.size > MAX_RAYS) return;
    visited.add(key);
    queue.push({ x, y, dir, color, dist });
  };

  for (const p of state.pieces) {
    if (p.onBoard && p.kind === 'emitter') push(p.x, p.y, mod8(p.rot), p.color);
  }
  for (const p of state.pieces) {
    if (p.onBoard && p.kind === 'target') received.set(p.id, 0);
  }

  while (queue.length > 0) {
    const ray = queue.shift()!;
    const dx = DIR_DX[ray.dir];
    const dy = DIR_DY[ray.dir];
    const step = ray.dir % 2 === 0 ? 1 : Math.SQRT2;
    let cx = ray.x;
    let cy = ray.y;
    let steps = 0;
    for (;;) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) {
        segments.push({
          x0: ray.x,
          y0: ray.y,
          x1: cx + dx * 0.5,
          y1: cy + dy * 0.5,
          color: ray.color,
          d0: ray.dist,
        });
        break;
      }
      steps++;
      const hit = grid[ny * size + nx];
      if (hit === undefined) {
        cx = nx;
        cy = ny;
        continue;
      }
      segments.push({
        x0: ray.x,
        y0: ray.y,
        x1: nx,
        y1: ny,
        color: ray.color,
        d0: ray.dist,
      });
      dist = ray.dist + steps * step;
      interact(hit, ray.dir, ray.color, push, received);
      break;
    }
  }

  const targetState = new Map<number, TargetState>();
  let solved = received.size > 0;
  for (const p of state.pieces) {
    if (!p.onBoard || p.kind !== 'target') continue;
    const s = targetStateFor(p.color, received.get(p.id) ?? 0);
    targetState.set(p.id, s);
    if (s !== 'lit') solved = false;
  }
  return { segments, received, targetState, solved };
}

function interact(
  p: Piece,
  dir: number,
  color: ColorMask,
  push: (x: number, y: number, dir: number, color: ColorMask) => void,
  received: Map<number, ColorMask>,
): void {
  switch (p.kind) {
    case 'target':
      received.set(p.id, (received.get(p.id) ?? 0) | color);
      return;
    case 'mirror': {
      const out = mod8(p.rot - dir);
      push(p.x, p.y, out, color);
      return;
    }
    case 'splitter': {
      const out = mod8(p.rot - dir);
      push(p.x, p.y, dir, color);
      if (out !== dir) push(p.x, p.y, out, color);
      return;
    }
    case 'prism':
      if (color & Color.R) push(p.x, p.y, mod8(dir + 1), Color.R);
      if (color & Color.G) push(p.x, p.y, dir, Color.G);
      if (color & Color.B) push(p.x, p.y, mod8(dir - 1), Color.B);
      return;
    case 'filter':
      push(p.x, p.y, dir, color & p.color);
      return;
    case 'emitter':
    case 'wall':
    default:
      return;
  }
}

/** Instantiate a level: board pieces first (ids 0..n-1), then the tray. */
export function createPuzzle(level: LevelDef): PuzzleState {
  const pieces: Piece[] = [];
  let id = 0;
  for (const spec of level.board) {
    pieces.push({
      id: id++,
      kind: spec.kind,
      x: spec.x ?? 0,
      y: spec.y ?? 0,
      rot: spec.rot ?? 0,
      color: spec.color ?? Color.W,
      lock: spec.lock ?? 'fixed',
      onBoard: true,
    });
  }
  for (const spec of level.tray) {
    pieces.push({
      id: id++,
      kind: spec.kind,
      x: -1,
      y: -1,
      rot: spec.rot ?? 0,
      color: spec.color ?? Color.W,
      lock: 'free',
      onBoard: false,
    });
  }
  return { size: level.size, pieces };
}

/** Return a copy of the puzzle with the level's reference solution applied. */
export function applySolution(level: LevelDef): PuzzleState {
  const state = createPuzzle(level);
  const n = level.board.length;
  level.solution.tray.forEach((s, i) => {
    const p = state.pieces[n + i];
    p.x = s.x;
    p.y = s.y;
    p.rot = s.rot;
    p.onBoard = true;
  });
  for (const [idx, rot] of Object.entries(level.solution.rotations ?? {})) {
    state.pieces[Number(idx)].rot = rot;
  }
  return state;
}

export function clonePuzzle(state: PuzzleState): PuzzleState {
  return { size: state.size, pieces: state.pieces.map((p) => ({ ...p })) };
}
