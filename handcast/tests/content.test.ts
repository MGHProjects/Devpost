import { describe, expect, it } from 'vitest';
import { generateBoard, Rng, randomSpec } from '../src/core/board-gen.js';
import { MOVEMENT_MUSIC, targetNotes } from '../src/core/music.js';
import { decodeCast, encodeCast, validateBoard, type ContentLevel, type ValidationResult } from '../src/core/validate.js';
import { canonicalPose } from '../src/core/pose-library.js';
import { allLevels, CHAPTERS } from '../src/content/campaign.js';
import { CHAPTER_SPECS } from '../src/content/campaign-specs.js';
import { DAILY_FIRST, dailyKey, dailyLevel } from '../src/content/daily.js';
import { KILN_VALIDATE, kilnLevel } from '../src/content/kiln.js';

const SLOW = 180_000;

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/** Geometry of a board (what the generator decides), for determinism checks. */
function geometry(l: ContentLevel): unknown {
  const crystals = l.crystals.map((c) => ({ p: c.p, color: c.color }));
  return JSON.parse(JSON.stringify({ lamps: l.lamps, wells: l.wells, crystals, hush: l.hush, walls: l.walls, solution: l.solution },
    (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v)));
}

describe('campaign', () => {
  it('has 6 chapters + finale, 49 boards, unique ids', () => {
    expect(CHAPTERS.map((c) => c.levels.length)).toEqual([5, 8, 8, 8, 8, 8, 4]);
    expect(CHAPTERS.map((c) => c.title)).toEqual(['First Light', 'Fingers', 'Catch', 'Mirror Palm', 'Relay', 'Colour', 'Count to Ten']);
    const all = allLevels();
    expect(all.length).toBe(49);
    expect(new Set(all.map((l) => l.id)).size).toBe(49);
    for (const c of CHAPTERS) expect(c.music).toBeLessThan(MOVEMENT_MUSIC.length);
  });

  it('every board has a name, a hint, a budget-fitting solution and noted crystals', () => {
    CHAPTERS.forEach((c, ci) => c.levels.forEach((l, i) => {
      expect(l.name.length).toBeGreaterThan(1);
      expect(l.hint && l.hint.length).toBeTruthy();
      expect(l.chapter).toBe(ci);
      expect(l.index).toBe(i);
      expect(l.solution!.length).toBeLessThanOrEqual(l.budget);
      expect(l.crystals.every((k) => typeof k.note === 'number')).toBe(true);
      expect(l.bench).toEqual({ w: 0.44, d: 0.3 });
    }));
    // The prologue is right-handed; the finale uses both hands.
    for (const l of CHAPTERS[0].levels) expect(l.solution!.every((s) => s.hand === 'right')).toBe(true);
    for (const l of CHAPTERS[6].levels) expect(new Set(l.solution!.map((s) => s.hand))).toEqual(new Set(['left', 'right']));
    expect(CHAPTERS[6].levels[3].crystals.length).toBeGreaterThanOrEqual(8);
  });

  const results = new Map<string, ValidationResult>();
  it('every board passes validateBoard (solution, unsolved bench, robustness, anti-trivial, plausibility)', () => {
    for (const l of allLevels() as ContentLevel[]) {
      const r = validateBoard(l);
      results.set(l.id, r);
      expect.soft(r.reasons, l.id).toEqual([]);
      expect.soft(r.robustness, l.id).toBeGreaterThanOrEqual(0.8);
    }
  }, SLOW);

  it('only the first board is exempt from the anti-trivial rule', () => {
    const tagged = (allLevels() as ContentLevel[]).filter((l) => l.tags?.includes('allowAnySpread')).map((l) => l.id);
    expect(tagged).toEqual(['prologue-1']);
  });

  it('difficulty rises within each chapter (Spearman > 0.3)', () => {
    for (const c of CHAPTERS) {
      const d = c.levels.map((l) => results.get(l.id)?.difficulty ?? validateBoard(l).difficulty);
      const rho = spearman(d.map((_, i) => i), d);
      expect.soft(rho, `${c.id}: ${d.map((x) => x.toFixed(3)).join(' ')}`).toBeGreaterThan(0.3);
    }
  }, SLOW);

  it('multi-cast boards rank above every one-cast board', () => {
    const one = allLevels().filter((l) => l.solution!.length === 1).map((l) => results.get(l.id)!.difficulty);
    const many = allLevels().filter((l) => l.solution!.length > 1).map((l) => results.get(l.id)!.difficulty);
    expect(Math.max(...one)).toBeLessThanOrEqual(1);
    expect(Math.min(...many)).toBeGreaterThan(1);
  });

  it('regenerates from its spec and seed (generator determinism)', () => {
    for (const id of ['prologue-3', 'catch-6', 'mirror-6', 'relay-8']) {
      const level = allLevels().find((l) => l.id === id) as ContentLevel;
      const ci = CHAPTERS.findIndex((c) => c.levels.includes(level));
      const specIndex = CHAPTER_SPECS[ci].boards.findIndex((b) => b.id === level.gen!.spec);
      const spec = CHAPTER_SPECS[ci].boards[specIndex];
      const r = generateBoard({ ...spec, chapter: ci, index: specIndex }, level.gen!.seed, { attempts: 200 });
      expect(r, id).not.toBeNull();
      expect(geometry(r!.level), id).toEqual(geometry(level));
    }
  }, SLOW);
});

describe('generator', () => {
  it('is deterministic for a seed', () => {
    const spec = randomSpec(new Rng(7), 1, 'det');
    const a = generateBoard(spec, 99);
    const b = generateBoard(spec, 99);
    expect(a).not.toBeNull();
    expect(JSON.stringify(a!.level)).toBe(JSON.stringify(b!.level));
  }, SLOW);

  it('round-trips casts through CastData', () => {
    const pose = canonicalPose('peace', 'left', [-0.05, 0.06], -1.2);
    const back = decodeCast(encodeCast(pose));
    for (let i = 0; i < 75; i++) expect(Math.abs(back.pos[i] - pose.pos[i])).toBeLessThan(6e-4);
    for (let i = 0; i < 100; i++) expect(Math.abs(back.rot![i] - pose.rot![i])).toBeLessThan(2e-4);
  });
});

describe('daily', () => {
  it('is the same board for the same date and validates for 30 consecutive days', () => {
    const start = new Date(`${DAILY_FIRST}T12:00:00`);
    for (let k = 0; k < 30; k++) {
      const date = new Date(start);
      date.setDate(start.getDate() + k);
      const l = dailyLevel(date) as ContentLevel;
      expect(l.id).toBe(`daily-${dailyKey(date)}`);
      expect(l.budget).toBe(1);
      expect(l.solution!.length).toBe(1);
      expect(dailyLevel(new Date(date.getTime() + 3600_000))).toBe(l);
      const r = validateBoard(l);
      expect.soft(r.reasons, l.id).toEqual([]);
    }
  }, SLOW);

  it('falls back to runtime generation outside the precomputed range', () => {
    const l = dailyLevel(new Date('2027-06-01T12:00:00')) as ContentLevel;
    expect(l.id).toBe('daily-2027-06-01');
    expect(validateBoard(l, KILN_VALIDATE).ok).toBe(true);
  }, SLOW);
});

describe('kiln', () => {
  it('generates valid boards for every tier, deterministically and fast', () => {
    for (const tier of [1, 2, 3] as const) {
      const times: number[] = [];
      for (let seed = 1; seed <= 8; seed++) {
        const t0 = performance.now();
        const l = kilnLevel(tier, seed * 7919) as ContentLevel;
        times.push(performance.now() - t0);
        const r = validateBoard(l, KILN_VALIDATE);
        expect.soft(r.reasons, l.id).toEqual([]);
        expect(l.solution!.length).toBeLessThanOrEqual(l.budget);
        expect(targetNotes(l, 0, 0).length).toBe(l.crystals.length);
        expect(l.crystals.every((c) => typeof c.note === 'number')).toBe(true);
      }
      times.sort((a, b) => a - b);
      // Median well under the 300 ms budget (generous bound: CI machines vary).
      expect(times[4], `tier ${tier} times ${times.map((t) => t.toFixed(0)).join(',')}`).toBeLessThan(300);
    }
    expect(JSON.stringify(kilnLevel(3, 4242))).toBe(JSON.stringify(kilnLevel(3, 4242)));
  }, SLOW);
});
