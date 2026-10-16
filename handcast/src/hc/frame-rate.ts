/**
 * Quest Browser starts WebXR sessions at 72 Hz. Ask for 90 Hz when the headset
 * offers it, then step back to 72 Hz if the app cannot hold it: a steady 72 is
 * better than a 90 that keeps dropping frames.
 */

type RateSession = XRSession & {
  supportedFrameRates?: Float32Array;
  updateTargetFrameRate?: (rate: number) => Promise<void>;
};

const HIGH = 90;
const SAFE = 72;
/** Frames slower than this count as missed at 90 Hz (11.1 ms + slack). */
const SLOW_DT = 1 / 80;
/** Seconds per window, and the share of missed frames that fails one. */
const WINDOW = 3;
const FAIL_SHARE = 0.2;

export class FrameRateGovernor {
  private session: RateSession | null = null;
  private target = 0;
  private sampled = 0;
  private frames = 0;
  private slow = 0;
  private settled = false;

  /** Call on session start. Safe to call when the API is missing. */
  begin(session: XRSession | null | undefined): void {
    this.session = (session as RateSession) ?? null;
    this.target = 0;
    this.sampled = 0;
    this.frames = 0;
    this.slow = 0;
    this.settled = false;
    const s = this.session;
    const rates = s?.supportedFrameRates;
    if (!s?.updateTargetFrameRate || !rates || !Array.from(rates).includes(HIGH)) {
      this.settled = true;
      return;
    }
    s.updateTargetFrameRate(HIGH).then(
      () => (this.target = HIGH),
      () => (this.settled = true),
    );
  }

  end(): void {
    this.session = null;
    this.settled = true;
  }

  /**
   * Per-frame sample while immersive. Checked in rolling windows for the whole
   * session (the heavy boards come later than the first seconds); one failed
   * window drops to 72 Hz for the rest of it.
   */
  sample(dt: number): void {
    if (this.settled || this.target !== HIGH) return;
    this.sampled += dt;
    this.frames++;
    // Counted per frame, so one long hitch (a shader compile) is one miss.
    if (dt > SLOW_DT) this.slow++;
    if (this.sampled < WINDOW) return;
    if (this.slow / this.frames > FAIL_SHARE) {
      this.target = SAFE;
      this.settled = true;
      void this.session?.updateTargetFrameRate?.(SAFE).catch(() => undefined);
    }
    this.sampled = 0;
    this.frames = 0;
    this.slow = 0;
  }

  get rate(): number {
    return this.target || (this.session?.frameRate ?? 0);
  }
}
