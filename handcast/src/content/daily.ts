/**
 * "One Hand": the Daily board. One cast allowed, moderate difficulty, the same
 * board for everyone on a given calendar date (the player's local date).
 * Boards for 2026-10-15 .. 2027-01-31 are precomputed with full validation
 * into levels/daily.json (scripts/gen-campaign.ts daily); full validation
 * takes ~0.2-1 s, too slow for the frame budget. Other dates fall back to
 * runtime generation with the Kiln's lighter validation, cached per date.
 */

import { generateBoard, randomSpec, Rng } from '../core/board-gen.js';
import { MOVEMENT_MUSIC, withNotes } from '../core/music.js';
import type { LevelDef } from '../core/types.js';
import type { ContentLevel, ValidateOptions } from '../core/validate.js';
import pack from './levels/daily.json';
import { boardName } from './names.js';

export const DAILY_FIRST = '2026-10-15';
export const DAILY_LAST = '2027-01-31';
/** Difficulty band the precomputed Daily aims for (validateBoard's one-cast scale). */
export const DAILY_BAND: [number, number] = [0.93, 0.995];

const PACK = pack as unknown as { first: string; last: string; levels: Record<string, ContentLevel> };
const cache = new Map<string, LevelDef>();

/** Local calendar date as YYYY-MM-DD. */
export function dailyKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** 2026-10-15 -> 20261015. */
export function dailySeed(key: string): number {
  return Number(key.replace(/-/g, ''));
}

/**
 * Generates the Daily for a date key. Tier 1 (one source) on most days, tier 2
 * (mixing / blade) on Fridays and weekends; among a few seed variants the
 * first whose difficulty falls in DAILY_BAND wins (else the one nearest it).
 * Pass `validate` to trade the difficulty search for speed (runtime fallback).
 */
export function generateDaily(key: string, validate?: ValidateOptions): ContentLevel {
  const seed = dailySeed(key);
  const [y, mo, d] = key.split('-').map(Number);
  const weekday = new Date(y, mo - 1, d).getDay();
  const tier = weekday === 0 || weekday >= 5 ? 2 : 1;
  let best: ContentLevel | null = null;
  let bestGap = Infinity;
  for (let v = 0; v < 8; v++) {
    const s = (seed * 31 + v * 1000003) >>> 0;
    const rng = new Rng(s);
    const spec = randomSpec(rng, tier, `daily-${key}`);
    spec.name = boardName(rng);
    spec.budget = 1;
    spec.hint = 'One hand. Make it count.';
    const r = generateBoard(spec, s, { attempts: 20, validate });
    if (!r) continue;
    const diff = r.result.difficulty;
    const gap = validate?.difficulty === false ? 0 : Math.max(0, DAILY_BAND[0] - diff, diff - DAILY_BAND[1]);
    if (gap < bestGap) {
      best = r.level;
      bestGap = gap;
      best.gen = { seed: s, difficulty: diff, robustness: r.result.robustness, solveRate: r.result.solveRate };
    }
    if (gap === 0) break;
  }
  if (!best) throw new Error(`no daily board for ${key}`);
  return best;
}

/** The Daily for `date` (local calendar day). Same board for everyone on that date. */
export function dailyLevel(date = new Date()): LevelDef {
  const key = dailyKey(date);
  let level = cache.get(key);
  if (!level) {
    const seed = dailySeed(key);
    const base = PACK.levels[key] ?? generateDaily(key, { robustSamples: 16, robustMin: 0.8, difficulty: false });
    level = withNotes(base, seed % MOVEMENT_MUSIC.length, seed % 7);
    cache.set(key, level);
  }
  return level;
}
