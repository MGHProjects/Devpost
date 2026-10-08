/** Text rendering of a board, for tests and level debugging. */

import { PuzzleState, trace } from './trace.js';
import { colorName } from './types.js';

const GLYPH: Record<string, string> = {
  emitter: 'E',
  target: 'T',
  wall: '#',
  mirror: '/',
  splitter: '%',
  prism: '^',
  filter: 'F',
};

export function renderAscii(state: PuzzleState): string {
  const rows: string[] = [];
  const result = trace(state);
  for (let y = state.size - 1; y >= 0; y--) {
    let row = '';
    for (let x = 0; x < state.size; x++) {
      const p = state.pieces.find((q) => q.onBoard && q.x === x && q.y === y);
      row += p ? GLYPH[p.kind] : '.';
    }
    rows.push(row);
  }
  const notes = state.pieces
    .filter((p) => p.onBoard && p.kind !== 'wall')
    .map((p) => {
      const extra =
        p.kind === 'target'
          ? ` needs ${colorName(p.color)} -> ${result.targetState.get(p.id)}`
          : p.kind === 'emitter' || p.kind === 'filter'
            ? ` ${colorName(p.color)} rot ${p.rot}`
            : ` rot ${p.rot}`;
      return `${GLYPH[p.kind]} (${p.x},${p.y})${extra}`;
    });
  return [...rows, ...notes, result.solved ? 'SOLVED' : 'unsolved'].join('\n');
}
