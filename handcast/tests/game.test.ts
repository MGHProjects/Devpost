import { describe, expect, it } from 'vitest';
import { validateLevel } from '../src/game/generator.js';
import { ALL_LEVELS, CAMPAIGN, dailyLevel } from '../src/game/levels.js';
import { applySolution, createPuzzle, trace } from '../src/game/trace.js';
import { Color, Piece } from '../src/game/types.js';

const piece = (p: Partial<Piece> & Pick<Piece, 'kind' | 'x' | 'y'>): Piece => ({
  id: 0,
  rot: 0,
  color: Color.W,
  lock: 'fixed',
  onBoard: true,
  ...p,
});

describe('beam tracer', () => {
  it('reflects off a 45° mirror', () => {
    const state = {
      size: 5,
      pieces: [
        piece({ id: 0, kind: 'emitter', x: 0, y: 2, rot: 0, color: Color.R }),
        piece({ id: 1, kind: 'mirror', x: 2, y: 2, rot: 2 }),
        piece({ id: 2, kind: 'target', x: 2, y: 4, color: Color.R }),
      ],
    };
    const r = trace(state);
    expect(r.solved).toBe(true);
    expect(r.segments).toHaveLength(2);
  });

  it('passes beams parallel to a mirror', () => {
    const state = {
      size: 5,
      pieces: [
        piece({ id: 0, kind: 'emitter', x: 0, y: 2, rot: 0, color: Color.R }),
        piece({ id: 1, kind: 'mirror', x: 2, y: 2, rot: 0 }),
        piece({ id: 2, kind: 'target', x: 4, y: 2, color: Color.R }),
      ],
    };
    expect(trace(state).solved).toBe(true);
  });

  it('splits white light in a prism and mixes at targets', () => {
    const state = {
      size: 5,
      pieces: [
        piece({ id: 0, kind: 'emitter', x: 0, y: 2, rot: 0, color: Color.W }),
        piece({ id: 1, kind: 'prism', x: 2, y: 2 }),
        piece({ id: 2, kind: 'target', x: 4, y: 4, color: Color.R }),
        piece({ id: 3, kind: 'target', x: 4, y: 2, color: Color.G }),
        piece({ id: 4, kind: 'target', x: 4, y: 0, color: Color.Y }),
      ],
    };
    const r = trace(state);
    expect(r.targetState.get(2)).toBe('lit');
    expect(r.targetState.get(3)).toBe('lit');
    expect(r.targetState.get(4)).toBe('wrong'); // received blue, needs yellow
  });

  it('reports partial light', () => {
    const state = {
      size: 5,
      pieces: [
        piece({ id: 0, kind: 'emitter', x: 0, y: 2, rot: 0, color: Color.R }),
        piece({ id: 1, kind: 'target', x: 4, y: 2, color: Color.Y }),
      ],
    };
    expect(trace(state).targetState.get(1)).toBe('partial');
  });

  it('terminates on mirror loops', () => {
    const state = {
      size: 4,
      pieces: [
        piece({ id: 0, kind: 'emitter', x: 0, y: 0, rot: 0, color: Color.B }),
        piece({ id: 1, kind: 'splitter', x: 2, y: 0, rot: 2 }),
        piece({ id: 2, kind: 'mirror', x: 2, y: 2, rot: 6 }),
        piece({ id: 3, kind: 'mirror', x: 3, y: 2, rot: 6 }),
      ],
    };
    expect(() => trace(state)).not.toThrow();
  });
});

describe('campaign', () => {
  it('has three movements of eight puzzles', () => {
    expect(CAMPAIGN.map((m) => m.length)).toEqual([8, 8, 8]);
    expect(new Set(ALL_LEVELS.map((l) => l.id)).size).toBe(ALL_LEVELS.length);
  });

  for (const level of ALL_LEVELS) {
    it(`${level.id} "${level.name}" is valid`, () => {
      expect(trace(applySolution(level)).solved).toBe(true);
      expect(trace(createPuzzle(level)).solved).toBe(false);
      expect(validateLevel(level)).toBe(true);
    });
  }

  it('builds a valid daily puzzle for a year of days', () => {
    const day = new Date(2026, 9, 1);
    for (let i = 0; i < 365; i++) {
      const level = dailyLevel(day);
      expect(validateLevel(level)).toBe(true);
      day.setDate(day.getDate() + 1);
    }
  });
});
