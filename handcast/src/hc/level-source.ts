/**
 * Where boards come from: the 49-board campaign, the Daily, the Kiln, plus
 * the music that crystals play (each board is one chord of its chapter's
 * progression; core/music.ts).
 */

import { CHAPTERS, allLevels } from '../content/campaign.js';
import { dailyLevel } from '../content/daily.js';
import { kilnLevel } from '../content/kiln.js';
import { chordBass, MOVEMENT_MUSIC, targetNotes } from '../core/music.js';
import { LevelDef } from '../core/types.js';

/** Special board slots (negative levelIndex values). */
export const SLOT = { daily: -1, kiln: -2, hall: -3, studio: -4 } as const;

export interface LevelSource {
  levels(): LevelDef[];
  daily(date?: Date): LevelDef;
  kiln(tier: number, seed: number): LevelDef;
  notesFor(level: LevelDef, index: number): number[];
  tonic(level: LevelDef, index: number): number;
  bass(level: LevelDef, index: number): number;
  describe(level: LevelDef, index: number): { eyebrow: string };
  /** First campaign index of each chapter (for the menu). */
  chapterStarts(): number[];
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', ''];

/** Chapter music index and position within the chapter for a campaign board. */
function slot(level: LevelDef): { movement: number; pos: number } | null {
  if (level.chapter === undefined) return null;
  const ch = CHAPTERS[level.chapter];
  return { movement: ch ? ch.music : level.chapter, pos: level.index ?? 0 };
}

export function levelSource(): LevelSource {
  const levels = allLevels();
  const starts: number[] = [];
  let n = 0;
  for (const c of CHAPTERS) {
    starts.push(n);
    n += c.levels.length;
  }
  return {
    levels: () => levels,
    daily: (date) => dailyLevel(date),
    kiln: (tier, seed) => kilnLevel(Math.max(1, Math.min(3, Math.round(tier))) as 1 | 2 | 3, seed >>> 0),
    notesFor(level) {
      const s = slot(level);
      const fallback = targetNotes(level, s?.movement ?? 0, s?.pos ?? 0);
      return level.crystals.map((c, i) => c.note ?? fallback[i]);
    },
    tonic(level) {
      const s = slot(level);
      if (s) return MOVEMENT_MUSIC[s.movement % MOVEMENT_MUSIC.length].root;
      // Daily / Kiln / Hall boards carry notes: the lowest is an octave above the chord root.
      const notes = level.crystals.map((c) => c.note).filter((x): x is number => typeof x === 'number');
      return notes.length ? Math.min(...notes) - 12 : 60;
    },
    bass(level) {
      const s = slot(level);
      if (s) return chordBass(s.movement, s.pos);
      const notes = level.crystals.map((c) => c.note).filter((x): x is number => typeof x === 'number');
      return notes.length ? Math.min(...notes) - 24 : 48;
    },
    describe(level, index) {
      if (index === SLOT.daily) return { eyebrow: 'DAILY - ONE HAND' };
      if (index === SLOT.kiln) return { eyebrow: 'THE KILN - FRESH FROM THE FIRE' };
      if (index === SLOT.hall) return { eyebrow: level.author ? `HALL OF HANDS - BY ${level.author.toUpperCase()}` : 'HALL OF HANDS' };
      if (index === SLOT.studio) return { eyebrow: 'STUDIO' };
      const ch = level.chapter !== undefined ? CHAPTERS[level.chapter] : undefined;
      if (!ch) return { eyebrow: `BOARD ${index + 1} / ${levels.length}` };
      const num = ROMAN[level.chapter!] ? `${ROMAN[level.chapter!]}. ` : '';
      return { eyebrow: `${num}${ch.title.toUpperCase()} - ${(level.index ?? 0) + 1} / ${ch.levels.length}` };
    },
    chapterStarts: () => starts,
  };
}
