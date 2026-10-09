/**
 * Procedural puzzle generator. Builds a *solution first* (emitters, then
 * optics dropped onto live beams, then crystals where the light ends up),
 * derives every crystal's colour from that solution, and finally strips the
 * player's pieces back into the tray. Every generated level is therefore
 * solvable by construction; validation rejects trivial or redundant ones.
 */

import { Rng } from './rng.js';
import {
  BeamSegment,
  PuzzleState,
  applySolution,
  createPuzzle,
  inBounds,
  pieceAt,
  trace,
} from './trace.js';
import {
  Color,
  ColorMask,
  DIR_DX,
  DIR_DY,
  LevelDef,
  Piece,
  PieceKind,
  PieceSpec,
  mod8,
} from './types.js';

export interface GenOptions {
  size: number;
  emitters: number;
  /** Kinds the player has to place (filters get a colour automatically). */
  tray: PieceKind[];
  /** Extra mirrors that start on the board, locked in place but turnable. */
  rotateLocked?: number;
  walls?: number;
  targets: [number, number];
  palette: ColorMask[];
}

const bitCount = (m: number): number =>
  (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1);

interface Candidate {
  x: number;
  y: number;
  dir: number;
  color: ColorMask;
}

/** Empty cells a segment passes through, with the beam's direction there. */
function segmentCells(
  state: PuzzleState,
  seg: BeamSegment,
  out: Candidate[],
): void {
  const dx = Math.sign(seg.x1 - seg.x0);
  const dy = Math.sign(seg.y1 - seg.y0);
  const dir = DIR_DX.findIndex((v, i) => v === dx && DIR_DY[i] === dy);
  if (dir < 0) return;
  let x = seg.x0 + dx;
  let y = seg.y0 + dy;
  while (inBounds(state, x, y)) {
    if (x === seg.x1 && y === seg.y1) break;
    if (!pieceAt(state, x, y)) out.push({ x, y, dir, color: seg.color });
    x += dx;
    y += dy;
  }
}

function beamCells(state: PuzzleState): Candidate[] {
  const out: Candidate[] = [];
  for (const seg of trace(state).segments) segmentCells(state, seg, out);
  return out;
}

function addPiece(state: PuzzleState, piece: Omit<Piece, 'id'>): Piece {
  const p: Piece = { ...piece, id: state.pieces.length };
  state.pieces.push(p);
  return p;
}

function inwardDirs(size: number, x: number, y: number): number[] {
  const dirs: number[] = [];
  for (let d = 0; d < 8; d++) {
    const nx = x + DIR_DX[d] * 2;
    const ny = y + DIR_DY[d] * 2;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) dirs.push(d);
  }
  return dirs;
}

function tryGenerate(
  id: string,
  name: string,
  rng: Rng,
  opts: GenOptions,
): LevelDef | null {
  const { size } = opts;
  const state: PuzzleState = { size, pieces: [] };
  const roles = new Map<number, 'board' | 'tray' | 'rotate'>();

  // 1. Emitters on the border, pointing inward.
  const border: [number, number][] = [];
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      const corner = (x === 0 || x === size - 1) && (y === 0 || y === size - 1);
      if (edge && !corner) border.push([x, y]);
    }
  }
  rng.shuffle(border);
  for (let i = 0; i < opts.emitters; i++) {
    const [x, y] = border[i];
    const dirs = inwardDirs(size, x, y);
    const straight = dirs.filter((d) => d % 2 === 0);
    const dir =
      straight.length > 0 && rng.next() < 0.75
        ? rng.pick(straight)
        : rng.pick(dirs);
    const p = addPiece(state, {
      kind: 'emitter',
      x,
      y,
      rot: dir,
      color: rng.pick(opts.palette),
      lock: 'fixed',
      onBoard: true,
    });
    roles.set(p.id, 'board');
  }

  // 2. Drop optics onto live beams, one at a time.
  const kinds: { kind: PieceKind; role: 'tray' | 'rotate' }[] = [
    ...opts.tray.map((kind) => ({ kind, role: 'tray' as const })),
    ...Array.from({ length: opts.rotateLocked ?? 0 }, () => ({
      kind: 'mirror' as PieceKind,
      role: 'rotate' as const,
    })),
  ];
  rng.shuffle(kinds);
  for (const { kind, role } of kinds) {
    let placed = false;
    const cells = rng.shuffle(beamCells(state));
    for (const c of cells) {
      let rot = 0;
      let color: ColorMask = Color.W;
      if (kind === 'mirror' || kind === 'splitter') {
        const options: number[] = [];
        for (let r = 0; r < 8; r++) {
          const out = mod8(r - c.dir);
          if (out === c.dir || out === mod8(c.dir + 4)) continue;
          const nx = c.x + DIR_DX[out];
          const ny = c.y + DIR_DY[out];
          if (!inBounds(state, nx, ny)) continue;
          // Bias toward right-angle turns; they read better on a tabletop.
          options.push(r);
          if (out % 2 === 0) options.push(r, r);
        }
        if (options.length === 0) continue;
        rot = rng.pick(options);
      } else if (kind === 'prism') {
        if (bitCount(c.color) < 2 && rng.next() < 0.8) continue;
        if (c.color === Color.G) continue;
      } else if (kind === 'filter') {
        if (bitCount(c.color) < 2) continue;
        const subsets = [1, 2, 3, 4, 5, 6].filter(
          (m) => (m & c.color) === m && m !== c.color,
        );
        color = rng.pick(subsets);
      }
      const p = addPiece(state, {
        kind,
        x: c.x,
        y: c.y,
        rot,
        color,
        lock: role === 'rotate' ? 'rotate' : 'free',
        onBoard: true,
      });
      roles.set(p.id, role);
      placed = true;
      break;
    }
    if (!placed) return null;
  }

  // 3. Crystals where beams leave the board.
  const ends: Candidate[] = [];
  for (const seg of trace(state).segments) {
    const fx = seg.x1 - Math.sign(seg.x1 - seg.x0) * 0.5;
    const fy = seg.y1 - Math.sign(seg.y1 - seg.y0) * 0.5;
    if (!Number.isInteger(seg.x1) || !Number.isInteger(seg.y1)) {
      if (
        inBounds(state, fx, fy) &&
        !pieceAt(state, fx, fy) &&
        (fx !== seg.x0 || fy !== seg.y0)
      ) {
        ends.push({ x: fx, y: fy, dir: 0, color: seg.color });
      }
    }
  }
  rng.shuffle(ends);
  const want =
    opts.targets[0] + rng.int(opts.targets[1] - opts.targets[0] + 1);
  const targets: Piece[] = [];
  for (const e of ends) {
    if (targets.length >= want) break;
    if (pieceAt(state, e.x, e.y)) continue;
    const p = addPiece(state, {
      kind: 'target',
      x: e.x,
      y: e.y,
      rot: 0,
      color: Color.W,
      lock: 'fixed',
      onBoard: true,
    });
    roles.set(p.id, 'board');
    targets.push(p);
  }
  if (targets.length < opts.targets[0]) return null;
  const solved = trace(state);
  for (const t of targets) {
    const got = solved.received.get(t.id) ?? 0;
    if (got === 0) return null;
    t.color = got;
  }

  // 4. Walls on cells no solution beam touches.
  const lit = new Set(beamCells(state).map((c) => c.y * size + c.x));
  const free: [number, number][] = [];
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (!pieceAt(state, x, y) && !lit.has(y * size + x)) free.push([x, y]);
    }
  }
  rng.shuffle(free);
  for (let i = 0; i < (opts.walls ?? 0) && i < free.length; i++) {
    const p = addPiece(state, {
      kind: 'wall',
      x: free[i][0],
      y: free[i][1],
      rot: 0,
      color: 0,
      lock: 'fixed',
      onBoard: true,
    });
    roles.set(p.id, 'board');
  }

  // 5. Split into board / tray / solution.
  const board: PieceSpec[] = [];
  const tray: PieceSpec[] = [];
  const solution: LevelDef['solution'] = { tray: [], rotations: {} };
  for (const p of state.pieces) {
    const role = roles.get(p.id);
    if (role === 'tray') {
      tray.push({ kind: p.kind, color: p.kind === 'filter' ? p.color : undefined });
      solution.tray.push({ x: p.x, y: p.y, rot: p.rot });
    } else if (role === 'rotate') {
      let scrambled = rng.int(8);
      if (scrambled === p.rot) scrambled = mod8(p.rot + 2 + rng.int(4));
      solution.rotations![board.length] = p.rot;
      board.push({ kind: p.kind, x: p.x, y: p.y, rot: scrambled, lock: 'rotate' });
    } else {
      board.push({ kind: p.kind, x: p.x, y: p.y, rot: p.rot, color: p.color });
    }
  }
  const level: LevelDef = { id, name, size, board, tray, solution };
  return validateLevel(level) ? level : null;
}

/** Reject levels that are unsolvable, already solved, or have spare pieces. */
export function validateLevel(level: LevelDef): boolean {
  const sol = applySolution(level);
  if (!trace(sol).solved) return false;
  const start = trace(createPuzzle(level));
  if (start.solved) return false;
  for (const s of start.targetState.values()) if (s === 'lit') return false;

  const n = level.board.length;
  for (let i = 0; i < level.tray.length; i++) {
    const without = applySolution(level);
    without.pieces[n + i].onBoard = false;
    if (trace(without).solved) return false;
  }
  for (const idx of Object.keys(level.solution.rotations ?? {})) {
    const scrambled = applySolution(level);
    scrambled.pieces[Number(idx)].rot = level.board[Number(idx)].rot ?? 0;
    if (trace(scrambled).solved) return false;
  }
  return true;
}

export function generateLevel(
  id: string,
  name: string,
  seed: number,
  opts: GenOptions,
  maxAttempts = 4000,
): LevelDef {
  const rng = new Rng(seed);
  for (let i = 0; i < maxAttempts; i++) {
    const level = tryGenerate(id, name, rng, opts);
    if (level) return level;
  }
  throw new Error(`generator failed for ${id} (seed ${seed})`);
}
