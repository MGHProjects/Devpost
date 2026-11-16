import { describe, expect, it } from 'vitest';
import { bassStep, euclid, STEPS, stepSeconds, tempoFor, voiceStep } from '../src/audio/groove.js';
import { AudioEngine } from '../src/audio/engine.js';

describe('groove', () => {
  it('spreads Euclidean onsets evenly', () => {
    expect(euclid(4).map(Number).join('')).toBe('1000100010001000');
    expect(euclid(3).filter(Boolean)).toHaveLength(3);
    expect(euclid(0).some(Boolean)).toBe(false);
    expect(euclid(5, STEPS, 2)[2]).toBe(true);
  });

  it('gives neighbouring crystals interlocking voices', () => {
    const steps = (rank: number) => Array.from({ length: STEPS }, (_, s) => voiceStep(rank, 72, s) !== null);
    for (let r = 0; r < 5; r++) expect(steps(r)).not.toEqual(steps(r + 1));
    // each voice stays on its crystal's pitch class
    for (let s = 0; s < STEPS; s++) {
      const n = voiceStep(2, 74, s);
      if (n) expect(((n.midi - 74) % 12 + 12) % 12).toBe(0);
    }
  });

  it('plays the bass heartbeat on 1, the and of 2, and 3', () => {
    const hits = Array.from({ length: STEPS }, (_, s) => bassStep(48, s)?.midi ?? null);
    expect(hits.filter((x) => x !== null)).toEqual([48, 55, 48]);
    expect(bassStep(48, 16)?.midi).toBe(48);
  });

  it('keeps every key between 78 and 100 bpm', () => {
    for (let m = 40; m < 80; m++) {
      expect(tempoFor(m)).toBeGreaterThanOrEqual(78);
      expect(tempoFor(m)).toBeLessThanOrEqual(100);
    }
    expect(stepSeconds(90)).toBeCloseTo(60 / 90 / 4);
  });

  it('logs each scheduled groove note so the capture WAV replays it', () => {
    const engine = new AudioEngine();
    engine.log = [];
    engine.mallet(60, 1, 0.1, 'bass');
    expect(engine.log[0]).toMatchObject({ name: 'mallet', args: [60, 1, 0.1, 'bass', undefined] });
    // without an audio context, pumping is a no-op
    engine.setGroove(60, 48);
    engine.setLayer(0, 72, 0);
    engine.pump();
    expect(engine.log).toHaveLength(1);
  });
});
