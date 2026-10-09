/**
 * Music theory for the crystals. Each puzzle is one chord of its movement's
 * progression; crystals take that chord's tones from left to right, so a
 * solved board literally plays its chord and a solved movement plays a song.
 */

import { LevelDef } from './types.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

interface MovementMusic {
  root: number; // MIDI note of the tonic
  scale: number[];
  /** Scale degrees (0-based) of each puzzle's chord root. */
  progression: number[];
}

export const MOVEMENT_MUSIC: MovementMusic[] = [
  { root: 60, scale: MAJOR, progression: [0, 4, 5, 3, 0, 1, 3, 4] }, // C
  { root: 62, scale: MAJOR, progression: [0, 5, 3, 4, 2, 5, 1, 4] }, // D
  { root: 57, scale: MINOR, progression: [0, 5, 2, 6, 3, 0, 4, 0] }, // Am
];

export const midiToFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** Triad (plus colour tone) on a scale degree, as MIDI notes. */
export function chordTones(music: MovementMusic, degree: number): number[] {
  const tone = (d: number) => {
    const oct = Math.floor(d / 7);
    return music.root + music.scale[d % 7] + 12 * oct;
  };
  return [tone(degree), tone(degree + 2), tone(degree + 4), tone(degree + 6)];
}

/**
 * MIDI note for each target in a level, keyed by board index. Crystals are
 * ordered left-to-right then near-to-far, and climb through the chord.
 */
export function targetNotes(
  level: LevelDef,
  movement: number,
  indexInMovement: number,
): Map<number, number> {
  const music = MOVEMENT_MUSIC[movement % MOVEMENT_MUSIC.length];
  const degree = music.progression[indexInMovement % music.progression.length];
  const chord = chordTones(music, degree).slice(0, 3);
  const targets = level.board
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.kind === 'target')
    .sort((a, b) => (a.p.x ?? 0) - (b.p.x ?? 0) || (a.p.y ?? 0) - (b.p.y ?? 0));
  const notes = new Map<number, number>();
  targets.forEach(({ i }, n) => {
    notes.set(i, chord[n % 3] + 12 * (1 + Math.floor(n / 3)));
  });
  return notes;
}

/** Bass note under a level's chord (for the resolution swell). */
export function chordBass(movement: number, indexInMovement: number): number {
  const music = MOVEMENT_MUSIC[movement % MOVEMENT_MUSIC.length];
  const degree = music.progression[indexInMovement % music.progression.length];
  return chordTones(music, degree)[0] - 12;
}
