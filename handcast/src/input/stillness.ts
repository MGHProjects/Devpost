/**
 * Stillness detector for "hold still to cast". Keeps a ring buffer of the
 * palm centre, the five fingertips and the palm normal over a trailing time
 * window. The hand is "still" when, across that window, the palm and every
 * tip stay within their tolerance of the window mean and the palm normal
 * stays within `tolAngle` of its mean direction (one outlier sample is
 * forgiven, so a single tracking glitch does not break a hold).
 *
 * Progress is leaky: it rises at `rise` per second while still and falls at
 * `fall` per second while moving (it does not snap to 0), so a brief wobble
 * costs a little time instead of the whole hold.
 *
 * A pure drift of speed v deviates v * window / 2 from the window mean, so
 * with the defaults (0.6 s, 7 mm) drifts slower than ~2.3 cm/s count as still.
 * Allocation-free per feed().
 */

export interface StillnessOptions {
  /** Trailing window length (s). Default 0.6. */
  window?: number;
  /** Palm centre tolerance from the window mean (m). Default 0.007. */
  tolPalm?: number;
  /** Fingertip tolerance from the window mean (m). Default 0.010. */
  tolTip?: number;
  /** Max palm-normal deviation from the window mean direction (rad). Default 4 deg. */
  tolAngle?: number;
  /** Progress gained per second while still. Default 1 / 0.7. */
  rise?: number;
  /** Progress lost per second while moving. Default 2 * rise. */
  fall?: number;
  /** Samples allowed to break tolerance inside the window. Default 1. */
  outliers?: number;
  /** Minimum samples before stillness can be judged. Default 4. */
  minSamples?: number;
}

type V3Like = ArrayLike<number>;

/** Ring capacity per second of window: covers update rates up to 240 Hz. */
const MAX_RATE = 240;

export class StillnessDetector {
  readonly window: number;
  readonly tolPalm: number;
  readonly tolTip: number;
  readonly tolAngle: number;
  readonly rise: number;
  readonly fall: number;
  readonly outliers: number;
  readonly minSamples: number;

  private readonly cap: number;
  private readonly palmBuf: Float32Array;
  private readonly tipBuf: Float32Array;
  private readonly nrmBuf: Float32Array;
  private readonly dtBuf: Float32Array;
  private head = 0; // next write slot
  private count = 0;
  private readonly mean = new Float64Array(3 + 15 + 3);
  private _progress = 0;
  private _still = false;

  constructor(opts: StillnessOptions = {}) {
    this.window = opts.window ?? 0.6;
    this.tolPalm = opts.tolPalm ?? 0.007;
    this.tolTip = opts.tolTip ?? 0.01;
    this.tolAngle = opts.tolAngle ?? (4 * Math.PI) / 180;
    this.rise = opts.rise ?? 1 / 0.7;
    this.fall = opts.fall ?? 2 * this.rise;
    this.outliers = opts.outliers ?? 1;
    this.minSamples = opts.minSamples ?? 4;
    this.cap = Math.ceil(this.window * MAX_RATE) + 2;
    this.palmBuf = new Float32Array(this.cap * 3);
    this.tipBuf = new Float32Array(this.cap * 15);
    this.nrmBuf = new Float32Array(this.cap * 3);
    this.dtBuf = new Float32Array(this.cap);
  }

  /** Hold progress 0..1 (1 = held long enough to cast). */
  get progress(): number {
    return this._progress;
  }

  /** Whether the latest window was judged still. */
  get still(): boolean {
    return this._still;
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this._progress = 0;
    this._still = false;
  }

  /**
   * Add one frame: palm centre (3), fingertips (5 x 3), palm normal (3, unit),
   * and the time since the previous frame. Returns the updated progress.
   */
  feed(palm: V3Like, tips: ArrayLike<number>, normal: V3Like, dt: number): number {
    if (!(dt > 0)) return this._progress;
    const s = this.head;
    for (let k = 0; k < 3; k++) {
      this.palmBuf[s * 3 + k] = palm[k];
      this.nrmBuf[s * 3 + k] = normal[k];
    }
    for (let k = 0; k < 15; k++) this.tipBuf[s * 15 + k] = tips[k];
    this.dtBuf[s] = dt;
    this.head = (s + 1) % this.cap;
    if (this.count < this.cap) this.count++;

    this._still = this.judge();
    const p = this._progress + (this._still ? this.rise : -this.fall) * dt;
    this._progress = p < 0 ? 0 : p > 1 ? 1 : p;
    return this._progress;
  }

  /** Number of newest samples whose age (time since they were taken) is within the window. */
  private windowSamples(): number {
    let n = 0;
    let age = 0;
    let slot = this.head;
    while (n < this.count) {
      slot = slot === 0 ? this.cap - 1 : slot - 1;
      if (age > this.window) break;
      n++;
      age += this.dtBuf[slot];
    }
    return n;
  }

  private judge(): boolean {
    const n = this.windowSamples();
    if (n < this.minSamples) return false;
    const m = this.mean;
    m.fill(0);
    // Pass 1: means (palm 0..2, tips 3..17, normal 18..20).
    for (let i = 0, slot = this.head; i < n; i++) {
      slot = slot === 0 ? this.cap - 1 : slot - 1;
      for (let k = 0; k < 3; k++) {
        m[k] += this.palmBuf[slot * 3 + k];
        m[18 + k] += this.nrmBuf[slot * 3 + k];
      }
      for (let k = 0; k < 15; k++) m[3 + k] += this.tipBuf[slot * 15 + k];
    }
    for (let k = 0; k < 18; k++) m[k] /= n;
    const nl = Math.hypot(m[18], m[19], m[20]) || 1;
    m[18] /= nl;
    m[19] /= nl;
    m[20] /= nl;

    // Pass 2: count samples that break any tolerance.
    const tp2 = this.tolPalm * this.tolPalm;
    const tt2 = this.tolTip * this.tolTip;
    const cosTol = Math.cos(this.tolAngle);
    let bad = 0;
    for (let i = 0, slot = this.head; i < n; i++) {
      slot = slot === 0 ? this.cap - 1 : slot - 1;
      const pi = slot * 3;
      let ok =
        sq(this.palmBuf[pi] - m[0]) + sq(this.palmBuf[pi + 1] - m[1]) + sq(this.palmBuf[pi + 2] - m[2]) <= tp2;
      if (ok) {
        const nx = this.nrmBuf[pi], ny = this.nrmBuf[pi + 1], nz = this.nrmBuf[pi + 2];
        const len = Math.hypot(nx, ny, nz) || 1;
        ok = (nx * m[18] + ny * m[19] + nz * m[20]) / len >= cosTol;
      }
      for (let t = 0; ok && t < 5; t++) {
        const ti = slot * 15 + t * 3;
        const mi = 3 + t * 3;
        ok =
          sq(this.tipBuf[ti] - m[mi]) + sq(this.tipBuf[ti + 1] - m[mi + 1]) + sq(this.tipBuf[ti + 2] - m[mi + 2]) <= tt2;
      }
      if (!ok && ++bad > this.outliers) return false;
    }
    return true;
  }
}

function sq(x: number): number {
  return x * x;
}
