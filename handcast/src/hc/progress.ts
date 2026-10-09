/** Local progress and settings for HANDCAST (browser storage, best effort). */

export interface Progress {
  solved: string[];
  current: string | null;
  dailyStreak: number;
  lastDaily: number | null;
  muted: boolean;
  /** Longer, more forgiving hold-still for tremor (accessibility). */
  steady: boolean;
  /** The table has been found once (skip the "rest your hand" step). */
  calibrated: boolean;
}

const KEY = 'handcast/progress/v1';

const fresh = (): Progress => ({
  solved: [],
  current: null,
  dailyStreak: 0,
  lastDaily: null,
  muted: false,
  steady: false,
  calibrated: false,
});

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...fresh(), ...(JSON.parse(raw) as Partial<Progress>) } : fresh();
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
