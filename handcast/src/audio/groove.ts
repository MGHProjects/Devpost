/**
 * The board's living score. Pure functions, no audio code.
 *
 * Every board runs on a slow beat clock. Each crystal that glass hands keep
 * lit adds one voice: its own note on its own Euclidean rhythm, so the more
 * of the board you hold, the more of the song plays, and a solved board is
 * the whole arrangement. With nothing lit only the room tone plays, which
 * keeps the thinking time quiet.
 */

/** Steps per bar (sixteenth notes in 4/4). */
export const STEPS = 16;

/** Euclidean rhythm: `hits` onsets spread as evenly as possible over `steps`, rotated by `rotate`. */
export function euclid(hits: number, steps = STEPS, rotate = 0): boolean[] {
  const out = new Array<boolean>(steps).fill(false);
  if (hits <= 0) return out;
  const k = Math.min(hits, steps);
  for (let i = 0; i < k; i++) out[(Math.floor((i * steps) / k) + rotate) % steps] = true;
  return out;
}

/**
 * One voice per crystal, chosen by its rank on the board so neighbours
 * interlock instead of doubling: sparse low voices, busier high ones.
 */
const VOICES: { hits: number; rotate: number; octave: number; accent: number }[] = [
  { hits: 3, rotate: 0, octave: 0, accent: 0 },
  { hits: 5, rotate: 2, octave: 0, accent: 6 },
  { hits: 4, rotate: 3, octave: 1, accent: 3 },
  { hits: 7, rotate: 1, octave: 1, accent: 0 },
  { hits: 2, rotate: 6, octave: 0, accent: 6 },
  { hits: 6, rotate: 5, octave: 1, accent: 5 },
];

export interface VoiceStep {
  midi: number;
  velocity: number;
}

/** What crystal voice `rank` with note `midi` plays on `step` (null for a rest). */
export function voiceStep(rank: number, midi: number, step: number): VoiceStep | null {
  const v = VOICES[rank % VOICES.length];
  const s = ((step % STEPS) + STEPS) % STEPS;
  if (!euclid(v.hits, STEPS, v.rotate)[s]) return null;
  // the voice's accent step rings an octave up, the rest stay on the note
  const up = s === v.accent ? 12 : 0;
  return { midi: midi + up - 12 * (1 - v.octave), velocity: s === v.accent ? 1 : s % 4 === 0 ? 0.8 : 0.6 };
}

/** The bass heartbeat under one or more held crystals: root on 1, fifth on the "and" of 2, root on 3. */
export function bassStep(root: number, step: number): VoiceStep | null {
  const s = ((step % STEPS) + STEPS) % STEPS;
  if (s === 0) return { midi: root, velocity: 1 };
  if (s === 6) return { midi: root + 7, velocity: 0.55 };
  if (s === 8) return { midi: root, velocity: 0.75 };
  return null;
}

/** Board tempo from its tonic: each key gets its own pace, all between 78 and 100 bpm. */
export function tempoFor(tonic: number): number {
  return 78 + ((((tonic % 12) + 12) % 12) * 2);
}

/** Seconds per sixteenth at `bpm`. */
export const stepSeconds = (bpm: number): number => 60 / bpm / 4;
