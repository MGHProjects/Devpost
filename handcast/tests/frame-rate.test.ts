import { describe, expect, it } from 'vitest';
import { FrameRateGovernor } from '../src/hc/frame-rate.js';

function fakeSession(rates: number[] | null) {
  const asked: number[] = [];
  const session = {
    frameRate: 72,
    supportedFrameRates: rates ? new Float32Array(rates) : undefined,
    updateTargetFrameRate: (r: number) => {
      asked.push(r);
      session.frameRate = r;
      return Promise.resolve();
    },
  };
  return { session: session as unknown as XRSession, asked };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FrameRateGovernor', () => {
  it('asks for 90 Hz when offered and keeps it while frames hold', async () => {
    const { session, asked } = fakeSession([72, 80, 90, 120]);
    const g = new FrameRateGovernor();
    g.begin(session);
    await flush();
    for (let i = 0; i < 90 * 10; i++) g.sample(1 / 90);
    expect(asked).toEqual([90]);
    expect(g.rate).toBe(90);
  });

  it('falls back to 72 Hz when a window misses too many frames, once', async () => {
    const { session, asked } = fakeSession([72, 90]);
    const g = new FrameRateGovernor();
    g.begin(session);
    await flush();
    for (let i = 0; i < 90 * 4; i++) g.sample(1 / 90);
    // A heavy board: one frame in eight takes two vsyncs (about 12 %), for 7 s.
    for (let i = 0; i < 90 * 7; i++) g.sample(i % 8 === 0 ? 1 / 45 : 1 / 90);
    expect(asked).toEqual([90, 72]);
    expect(g.rate).toBe(72);
  });

  it('needs two failing windows in a row: one burst keeps 90 Hz', async () => {
    const { session, asked } = fakeSession([72, 90]);
    const g = new FrameRateGovernor();
    g.begin(session);
    await flush();
    // One 3 s window with 10 % misses (a board loading), then smooth play.
    for (let i = 0; i < 270; i++) g.sample(i % 10 === 0 ? 1 / 45 : 1 / 90);
    for (let i = 0; i < 90 * 9; i++) g.sample(1 / 90);
    expect(asked).toEqual([90]);
  });

  it('resetWindow drops frames sampled under the system menu', async () => {
    const { session, asked } = fakeSession([72, 90]);
    const g = new FrameRateGovernor();
    g.begin(session);
    await flush();
    // One failing window, then 2.5 s of slow frames under the system menu:
    // without the reset these would fail the second window and drop to 72 Hz.
    for (let i = 0; i < 270; i++) g.sample(i % 10 === 0 ? 1 / 45 : 1 / 90);
    for (let i = 0; i < 75; i++) g.sample(1 / 30);
    g.resetWindow();
    for (let i = 0; i < 90 * 6; i++) g.sample(1 / 90);
    expect(asked).toEqual([90]);
  });

  it('treats one long hitch as a single missed frame', async () => {
    const { session, asked } = fakeSession([72, 90]);
    const g = new FrameRateGovernor();
    g.begin(session);
    await flush();
    g.sample(0.4);
    for (let i = 0; i < 90 * 6; i++) g.sample(1 / 90);
    expect(asked).toEqual([90]);
  });

  it('does nothing when the browser has no frame-rate API or no 90 Hz', async () => {
    const none = fakeSession(null);
    const only72 = fakeSession([72]);
    for (const { session, asked } of [none, only72]) {
      const g = new FrameRateGovernor();
      g.begin(session);
      await flush();
      for (let i = 0; i < 400; i++) g.sample(1 / 30);
      expect(asked).toEqual([]);
    }
    const g = new FrameRateGovernor();
    g.begin(undefined);
    g.sample(1);
    expect(g.rate).toBe(0);
  });
});
