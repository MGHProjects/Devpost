/** Local progress: solved puzzles, last puzzle, daily streak, settings. */

export interface Progress {
  solved: string[];
  current: string | null;
  dailyStreak: number;
  lastDaily: number | null;
  muted: boolean;
}

const KEY = 'prism-song/progress/v1';

const fresh = (): Progress => ({
  solved: [],
  current: null,
  dailyStreak: 0,
  lastDaily: null,
  muted: false,
});

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    return { ...fresh(), ...(JSON.parse(raw) as Partial<Progress>) };
  } catch {
    return fresh();
  }
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode or storage disabled: progress simply isn't kept.
  }
}

/** Record today's daily solve; consecutive days extend the streak. */
export function recordDaily(p: Progress, seed: number, yesterdaySeed: number): void {
  if (p.lastDaily === seed) return;
  p.dailyStreak = p.lastDaily === yesterdaySeed ? p.dailyStreak + 1 : 1;
  p.lastDaily = seed;
}
