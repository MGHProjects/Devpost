/**
 * The HANDCAST campaign: a five-board prologue, five eight-board chapters and
 * a four-board finale (49 boards). The boards are generated offline from
 * campaign-specs.ts by scripts/gen-campaign.ts into levels/<chapter>.json
 * (each with a validated reference solution). Crystal notes are assigned
 * here from the chapter's chord progression (core/music.ts).
 */

import { withNotes } from '../core/music.js';
import type { LevelDef } from '../core/types.js';
import type { ContentLevel } from '../core/validate.js';
import prologue from './levels/prologue.json';
import fingers from './levels/fingers.json';
import catchCh from './levels/catch.json';
import mirror from './levels/mirror.json';
import relay from './levels/relay.json';
import colour from './levels/colour.json';
import finale from './levels/finale.json';

export interface Chapter {
  id: string;
  title: string;
  /** Index into MOVEMENT_MUSIC. */
  music: number;
  levels: LevelDef[];
}

interface ChapterFile {
  id: string;
  title: string;
  music: number;
  levels: ContentLevel[];
}

function load(file: ChapterFile, chapter: number): Chapter {
  return {
    id: file.id,
    title: file.title,
    music: file.music,
    levels: file.levels.map((l, index) => withNotes({ ...l, chapter, index }, file.music, index)),
  };
}

const FILES = [prologue, fingers, catchCh, mirror, relay, colour, finale] as unknown as ChapterFile[];

export const CHAPTERS: Chapter[] = FILES.map(load);

export function allLevels(): LevelDef[] {
  return CHAPTERS.flatMap((c) => c.levels);
}

export function levelById(id: string): LevelDef | undefined {
  for (const c of CHAPTERS) for (const l of c.levels) if (l.id === id) return l;
  return undefined;
}

/** The board after `id` in campaign order (crossing chapters), or undefined at the end. */
export function nextLevel(id: string): LevelDef | undefined {
  const all = allLevels();
  const i = all.findIndex((l) => l.id === id);
  return i >= 0 ? all[i + 1] : undefined;
}
