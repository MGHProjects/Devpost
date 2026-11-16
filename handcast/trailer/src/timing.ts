import beats from './beats.json';
import shots from './shots.json';

export const FPS = 30;
export const W = 1920;
export const H = 1080;
export const DURATION_S = 75;

/** Seconds of the measured grid at beat b. */
export const T = (b: number) => beats.offset + b * beats.period;
/** Frame at beat b. */
export const F = (b: number) => Math.round(T(b) * FPS);
/** Beat at frame f (fractional). */
export const B = (f: number) => (f / FPS - beats.offset) / beats.period;

export type Shot = { id: string; b0: number; b1: number; src: number };
export const SHOTS = shots as Shot[];
export const shot = (id: string) => SHOTS.find((s) => s.id === id)!;
/** Clips are cut with this much padding before b0 (scripts/cut-clips.py). */
export const PAD_S = 1;

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const prog = (u: number, a: number, b: number) => clamp((u - a) / (b - a));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = {
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inExpo: (t: number) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
};

/** Damped spring step from 0 to 1 starting at beat b0 (closed form, pure in time). */
export function springB(u: number, b0: number, stiffness = 380, damping = 30): number {
  const t = (u - b0) * beats.period;
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness), z = damping / (2 * w0);
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}
export const SNAPPY = [380, 30] as const;
export const BOUNCY = [260, 13] as const;
export const GENTLE = [120, 20] as const;

/** Seeded hash in [0,1). */
export function hash01(i: number, seed = 1): number {
  let a = (i * 374761393 + seed * 668265263) | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Decaying camera shake offset [x, y] after beat u0. */
export function shake(u: number, u0: number, amp: number, decay = 0.12): [number, number] {
  if (u < u0) return [0, 0];
  const a = amp * Math.exp(-(u - u0) / decay);
  const n = (x: number, s: number) => {
    const i = Math.floor(x), f = x - i, k = f * f * (3 - 2 * f);
    return lerp(hash01(i, s), hash01(i + 1, s), k) * 2 - 1;
  };
  return [a * n(u * 48, 3), a * n(u * 48, 12)];
}
