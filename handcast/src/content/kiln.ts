/**
 * The Kiln: endless generated boards in three tiers, made at runtime from a
 * seed (same seed, same board). Tier 1 = one hand, one light source; tier 2 =
 * one hand mixing colours or a blade mirror; tier 3 = two casts relaying light.
 * Validation is lighter than the campaign's (16 wobbles, no difficulty
 * search) to stay well under 300 ms; if a tier's recipe cannot be placed in
 * its few attempts, the next seed variant and then the tier below are tried.
 */

import { generateBoard, randomSpec, Rng } from '../core/board-gen.js';
import { MOVEMENT_MUSIC, withNotes } from '../core/music.js';
import type { LevelDef } from '../core/types.js';
import type { ContentLevel, ValidateOptions } from '../core/validate.js';
import { boardName } from './names.js';

export type KilnTier = 1 | 2 | 3;

export const KILN_VALIDATE: ValidateOptions = { robustSamples: 16, robustMin: 0.75, difficulty: false };
const ATTEMPTS: Record<KilnTier, number> = { 1: 8, 2: 8, 3: 10 };
const VARIANTS = 3;

/** One try of a tier from a seed (null when the recipe could not be placed). */
export function tryKiln(tier: KilnTier, seed: number): ContentLevel | null {
  const id = `kiln-${tier}-${seed >>> 0}`;
  for (let v = 0; v < VARIANTS; v++) {
    const s = (seed + v * 0x9e3779b1 + tier * 0x85ebca6b) >>> 0;
    const rng = new Rng(s);
    const spec = randomSpec(rng, tier, id);
    spec.name = boardName(rng);
    const r = generateBoard(spec, s, { attempts: ATTEMPTS[tier], effort: 0.5, validate: KILN_VALIDATE });
    if (r) return r.level;
  }
  return null;
}

/** A Kiln board for `tier` and `seed`; always returns a board (falls back to lower tiers). */
export function kilnLevel(tier: KilnTier, seed: number): LevelDef {
  for (let t = tier; t >= 1; t--) {
    const level = tryKiln(t as KilnTier, seed);
    if (level) return withNotes(level, (seed >>> 0) % MOVEMENT_MUSIC.length, (seed >>> 0) % 8);
  }
  // Tier 1 failing three seed variants is very unlikely; walk to the next seed.
  return kilnLevel(1, (seed + 1) >>> 0);
}
