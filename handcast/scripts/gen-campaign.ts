/**
 * Offline campaign generation: turns src/content/campaign-specs.ts into
 * src/content/levels/<chapter>.json with the solution-first generator.
 *
 *   npx vite-node --config vitest.config.ts scripts/gen-campaign.ts [chapterId ...] [daily]
 *
 * With no arguments every chapter is rebuilt (not the Daily); `daily` rebuilds
 * levels/daily.json (one validated board per date, DAILY_FIRST..DAILY_LAST).
 *
 * (vite-node ships with vitest; the vitest config keeps the IWSDK dev plugin
 * out of the way.) For each board it tries a fixed list of seeds and keeps up
 * to CANDIDATES boards that pass validateBoard; per chapter it then ships the
 * mix of candidates that best combines a rising difficulty (Spearman rank
 * correlation with the board order) and robustness.
 * Deterministic: the same specs always produce the same JSON.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBoard, type GenResult } from '../src/core/board-gen';
import { hashString, type ContentLevel } from '../src/core/validate';
import { CHAPTER_SPECS } from '../src/content/campaign-specs';
import { DAILY_FIRST, DAILY_LAST, generateDaily } from '../src/content/daily';

const CANDIDATES = 4;
const SEEDS = 12;
const ATTEMPTS = 200;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/content/levels');

/** Rounds every float in the level for compact, stable JSON. */
function tidy(level: ContentLevel): ContentLevel {
  return JSON.parse(JSON.stringify(level, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v)));
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(xs: number[], ys: number[]): number {
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
  const n = xs.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

type Cand = { r: GenResult; seed: number };

/** One candidate per board: best mix of difficulty ramp (Spearman vs order) and robustness. */
function choose(cands: Cand[][]): number[] {
  let best: number[] = cands.map(() => 0);
  let bestScore = -Infinity;
  const pick = new Array<number>(cands.length).fill(0);
  const visit = (i: number): void => {
    if (i === cands.length) {
      const d = pick.map((k, j) => cands[j][k].r.result.difficulty);
      const rob = pick.reduce((s, k, j) => s + cands[j][k].r.result.robustness, 0) / pick.length;
      const score = spearman(d.map((_, j) => j), d) + 2 * rob;
      if (score > bestScore) {
        bestScore = score;
        best = pick.slice();
      }
      return;
    }
    for (let k = 0; k < cands[i].length; k++) {
      pick[i] = k;
      visit(i + 1);
    }
  };
  visit(0);
  return best;
}

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
for (const ch of CHAPTER_SPECS) {
  if (only.length && !only.includes(ch.id)) continue;
  const chapter = CHAPTER_SPECS.indexOf(ch);
  const all: Cand[][] = [];
  ch.boards.forEach((spec, index) => {
    const t0 = Date.now();
    const found: Cand[] = [];
    for (let k = 0; k < SEEDS && found.length < CANDIDATES; k++) {
      const seed = (hashString(spec.id) + k * 7919) >>> 0;
      const r = generateBoard({ ...spec, chapter, index }, seed, { attempts: ATTEMPTS });
      if (r) found.push({ r, seed });
    }
    console.log(`${spec.id}: ${found.length} candidates [${found.map((c) => `${c.r.result.difficulty.toFixed(3)}/${c.r.result.robustness.toFixed(2)}`).join(' ')}] (${Date.now() - t0} ms)`);
    if (!found.length) throw new Error(`${spec.id}: no valid board`);
    all.push(found);
  });
  const picks = choose(all);
  let levels = picks.map((k, j) => {
    const { r, seed } = all[j][k];
    const L = r.level;
    L.gen = { spec: ch.boards[j].id, seed, difficulty: r.result.difficulty, robustness: r.result.robustness, solveRate: r.result.solveRate };
    return tidy(L);
  });
  if (ch.reorder) {
    // Easiest first; boards marked `pin` (a chapter's capstone) keep their slot.
    const pinned = new Map<number, ContentLevel>();
    ch.boards.forEach((b, j) => { if (ch.pin?.includes(b.id)) pinned.set(j, levels[j]); });
    const rest = levels.filter((_, j) => !pinned.has(j)).sort((a, b) => a.gen!.difficulty - b.gen!.difficulty);
    levels = levels.map((_, j) => pinned.get(j) ?? rest.shift()!);
  }
  levels.forEach((l, j) => {
    l.id = `${ch.id}-${j + 1}`;
    l.index = j;
  });
  const rho = spearman(levels.map((_, j) => j), levels.map((l) => l.gen!.difficulty));
  console.log(`${ch.id}: spearman ${rho.toFixed(2)}; ` + levels.map((l) => `${l.id} d=${l.gen!.difficulty.toFixed(3)} r=${l.gen!.robustness.toFixed(2)}`).join(', '));
  writeFileSync(resolve(OUT, `${ch.id}.json`), JSON.stringify({ id: ch.id, title: ch.title, music: ch.music, levels }) + '\n');
}

if (only.includes('daily')) {
  const levels: Record<string, ContentLevel> = {};
  const day = new Date(`${DAILY_FIRST}T12:00:00Z`);
  const end = new Date(`${DAILY_LAST}T12:00:00Z`);
  for (; day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    const t0 = Date.now();
    const L = tidy(generateDaily(key));
    levels[key] = L;
    console.log(`${key}: ${L.name} d=${L.gen!.difficulty.toFixed(3)} r=${L.gen!.robustness.toFixed(2)} (${Date.now() - t0} ms)`);
  }
  writeFileSync(resolve(OUT, 'daily.json'), JSON.stringify({ first: DAILY_FIRST, last: DAILY_LAST, levels }) + '\n');
}
