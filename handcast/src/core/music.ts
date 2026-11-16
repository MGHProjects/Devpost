/**
 * Music theory for the crystals.
 * Each chapter has a key and a chord progression; each board is one chord.
 * Crystals take that chord's tones from left to right (then far to near), so
 * a solved board plays its chord and a solved chapter replays as a song.
 * Pure TS, no audio code.
 */

import type { LevelDef } from './types.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

export interface MovementMusic {
  /** Key name, for UI / debugging. */
  key: string;
  /** MIDI note of the tonic. */
  root: number;
  scale: number[];
  /** Scale degrees (0-based) of each board's chord root, by board index. */
  progression: number[];
}

/** One entry per chapter: prologue, Fingers, Catch, Mirror Palm, Relay, Colour, finale. */
export const MOVEMENT_MUSIC: MovementMusic[] = [
  { key: 'C', root: 60, scale: MAJOR, progression: [0, 3, 4, 5, 0] }, // I IV V vi I
  { key: 'G', root: 55, scale: MAJOR, progression: [0, 4, 5, 3, 0, 1, 3, 4] },
  { key: 'D', root: 62, scale: MAJOR, progression: [0, 5, 3, 4, 2, 5, 1, 4] },
  { key: 'Am', root: 57, scale: MINOR, progression: [0, 5, 2, 6, 3, 0, 4, 0] },
  { key: 'F', root: 53, scale: MAJOR, progression: [0, 3, 1, 4, 5, 2, 3, 4] },
  { key: 'Em', root: 52, scale: MINOR, progression: [0, 5, 2, 6, 0, 3, 4, 0] },
  { key: 'C', root: 60, scale: MAJOR, progression: [0, 3, 4, 0] }, // the finale comes home
];

export const midiToFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

function musicFor(movement: number): MovementMusic {
  const n = MOVEMENT_MUSIC.length;
  return MOVEMENT_MUSIC[((movement % n) + n) % n];
}

/** Triad plus seventh on a scale degree, as MIDI notes. */
export function chordTones(music: MovementMusic, degree: number): number[] {
  const tone = (d: number): number => music.root + music.scale[d % 7] + 12 * Math.floor(d / 7);
  return [tone(degree), tone(degree + 2), tone(degree + 4), tone(degree + 6)];
}

/** Scale degree of a board's chord. */
export function chordDegree(movement: number, indexInMovement: number): number {
  const music = musicFor(movement);
  return music.progression[indexInMovement % music.progression.length];
}

/** The board's chord (triad, root position) as MIDI notes. */
export function boardChord(movement: number, indexInMovement: number): number[] {
  const music = musicFor(movement);
  return chordTones(music, chordDegree(movement, indexInMovement)).slice(0, 3);
}

/**
 * MIDI note per crystal (same order as level.crystals). Crystals are ranked
 * left to right (then far to near) and climb through the chord, one octave
 * per three crystals, starting an octave above the chord root.
 */
export function targetNotes(level: Pick<LevelDef, 'crystals'>, movement: number, indexInMovement: number): number[] {
  const chord = boardChord(movement, indexInMovement);
  const order = level.crystals
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.p[0] - b.c.p[0] || a.c.p[1] - b.c.p[1]);
  const notes = new Array<number>(level.crystals.length);
  order.forEach(({ i }, n) => {
    notes[i] = chord[n % 3] + 12 * (1 + Math.floor(n / 3));
  });
  return notes;
}

/** Bass note under a board's chord (for the resolution swell). */
export function chordBass(movement: number, indexInMovement: number): number {
  return boardChord(movement, indexInMovement)[0] - 12;
}

/** A chapter replayed as a song: one chord (bass + triad) per board, in order. */
export function chapterSong(movement: number, boards: number): { bass: number; chord: number[] }[] {
  return Array.from({ length: boards }, (_, i) => ({ bass: chordBass(movement, i), chord: boardChord(movement, i) }));
}

/** Copy of a level with a note on every crystal that has none (from the board's chord). */
export function withNotes<T extends LevelDef>(level: T, movement: number, indexInMovement: number): T {
  const notes = targetNotes(level, movement, indexInMovement);
  return { ...level, crystals: level.crystals.map((c, i) => ({ ...c, note: c.note ?? notes[i] })) };
}
