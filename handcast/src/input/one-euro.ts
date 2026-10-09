/**
 * One-Euro filter (Casiez et al. 2012) over a flat array of 3D points: an
 * adaptive low-pass whose cutoff rises with speed, so a resting hand is
 * steady while a moving hand stays responsive. The speed that drives the
 * cutoff is the length of each point's (filtered) velocity, so x, y and z of
 * one joint share one cutoff and the filter does not distort directions.
 *
 * Allocation-free per update; tolerates variable dt (dt <= 0 is ignored).
 */

export interface OneEuroOptions {
  /** Cutoff (Hz) at rest. Lower = steadier, laggier. */
  minCutoff?: number;
  /** Cutoff increase per m/s of speed. Higher = less lag when moving. */
  beta?: number;
  /** Cutoff (Hz) of the derivative low-pass. */
  dCutoff?: number;
}

export const ONE_EURO_DEFAULTS: Required<OneEuroOptions> = { minCutoff: 1.2, beta: 12, dCutoff: 1 };

/** Smoothing factor of a first-order low-pass with cutoff `fc` (Hz) at step `dt` (s). */
function alphaFor(fc: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * fc);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter3 {
  /** Number of 3D points. */
  readonly count: number;
  /** Filtered output, count x 3. */
  readonly value: Float32Array;
  minCutoff: number;
  beta: number;
  dCutoff: number;
  private readonly prevRaw: Float32Array;
  private readonly deriv: Float32Array;
  private primed = false;

  constructor(count: number, opts: OneEuroOptions = {}) {
    this.count = count;
    this.value = new Float32Array(count * 3);
    this.prevRaw = new Float32Array(count * 3);
    this.deriv = new Float32Array(count * 3);
    this.minCutoff = opts.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = opts.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = opts.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
  }

  /** True once the filter holds a value (after the first filter() or reset(x)). */
  get isPrimed(): boolean {
    return this.primed;
  }

  /**
   * Forget history. With `x`, snap the output to it (zero velocity);
   * otherwise the next filter() call snaps.
   */
  reset(x?: ArrayLike<number>): void {
    this.deriv.fill(0);
    if (x) {
      const n = this.count * 3;
      for (let i = 0; i < n; i++) {
        this.value[i] = x[i];
        this.prevRaw[i] = x[i];
      }
      this.primed = true;
    } else {
      this.primed = false;
    }
  }

  /** Feed one sample (count x 3) taken `dt` seconds after the previous one. Returns `value`. */
  filter(x: ArrayLike<number>, dt: number): Float32Array {
    if (!this.primed) {
      this.reset(x);
      return this.value;
    }
    if (!(dt > 0)) return this.value;
    const aD = alphaFor(this.dCutoff, dt);
    const val = this.value;
    const prev = this.prevRaw;
    const der = this.deriv;
    for (let p = 0, i = 0; p < this.count; p++, i += 3) {
      // Derivative of the raw signal, low-passed.
      let speed2 = 0;
      for (let k = 0; k < 3; k++) {
        const d = (x[i + k] - prev[i + k]) / dt;
        const ed = der[i + k] + aD * (d - der[i + k]);
        der[i + k] = ed;
        speed2 += ed * ed;
      }
      const a = alphaFor(this.minCutoff + this.beta * Math.sqrt(speed2), dt);
      for (let k = 0; k < 3; k++) {
        val[i + k] += a * (x[i + k] - val[i + k]);
        prev[i + k] = x[i + k];
      }
    }
    return val;
  }
}
