/**
 * Where boards come from: the campaign, the Daily, the Kiln, plus the music
 * that crystals play (each board is one chord of its chapter's progression).
 */

import { LevelDef } from '../core/types.js';
import { devLevels } from './dev-levels.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MUSIC = [
  { root: 60, scale: MAJOR, prog: [0, 4, 5, 3, 0, 1, 3, 4] },
  { root: 62, scale: MAJOR, prog: [0, 5, 3, 4, 2, 5, 1, 4] },
  { root: 57, scale: MINOR, prog: [0, 5, 2, 6, 3, 0, 4, 0] },
  { root: 64, scale: MINOR, prog: [0, 3, 6, 2, 5, 1, 4, 0] },
  { root: 65, scale: MAJOR, prog: [0, 3, 4, 0, 5, 1, 4, 0] },
  { root: 55, scale: MAJOR, prog: [0, 4, 5, 2, 3, 0, 3, 4] },
  { root: 59, scale: MINOR, prog: [0, 6, 5, 4, 3, 2, 4, 0] },
];

function tone(m: (typeof MUSIC)[number], d: number): number {
  return m.root + m.scale[d % 7] + 12 * Math.floor(d / 7);
}

export interface LevelSource {
  levels(): LevelDef[];
  daily(date?: Date): LevelDef;
  kiln(tier: number, seed: number): LevelDef;
  notesFor(level: LevelDef, index: number): number[];
  tonic(level: LevelDef, index: number): number;
  bass(level: LevelDef, index: number): number;
  describe(level: LevelDef, index: number): { eyebrow: string };
}

/** Chapter music index and position within the chapter for a board. */
function slot(level: LevelDef, index: number): { chapter: number; pos: number } {
  if (level.chapter !== undefined) return { chapter: level.chapter, pos: level.index ?? 0 };
  return { chapter: Math.max(0, index) % MUSIC.length, pos: Math.max(0, index) };
}

export function levelSource(): LevelSource {
  const levels = devLevels();
  const music = (level: LevelDef, index: number) => {
    const s = slot(level, index);
    const m = MUSIC[s.chapter % MUSIC.length];
    return { m, degree: m.prog[s.pos % m.prog.length] };
  };
  return {
    levels: () => levels,
    daily: () => levels[0],
    kiln: () => levels[(Math.random() * levels.length) | 0],
    notesFor(level, index) {
      const { m, degree } = music(level, index);
      const chord = [tone(m, degree), tone(m, degree + 2), tone(m, degree + 4)];
      const order = level.crystals.map((c, i) => ({ i, x: c.p[0], z: c.p[1] })).sort((a, b) => a.x - b.x || a.z - b.z);
      const notes: number[] = new Array(level.crystals.length);
      order.forEach(({ i }, n) => {
        notes[i] = level.crystals[i].note ?? chord[n % 3] + 12 * (1 + Math.floor(n / 3));
      });
      return notes;
    },
    tonic(level, index) {
      return music(level, index).m.root;
    },
    bass(level, index) {
      const { m, degree } = music(level, index);
      return tone(m, degree) - 12;
    },
    describe(level, index) {
      if (index === -1) return { eyebrow: 'DAILY - ONE HAND' };
      if (index === -2) return { eyebrow: 'THE KILN' };
      if (index < 0) return { eyebrow: 'HALL OF HANDS' };
      return { eyebrow: `BOARD ${index + 1} / ${levels.length}` };
    },
  };
}
