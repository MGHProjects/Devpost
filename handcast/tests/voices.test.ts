import { describe, expect, it } from 'vitest';
import {
  bubbleTrain,
  crackleGrains,
  GLASS_BAR_PARTIALS,
  GlassVoices,
  karplusStrong,
  midiToFreq,
  tingFundamental,
  tingPartials,
} from '../src/audio/voices.js';

/** Dominant period (samples) by autocorrelation over a window. */
function periodOf(x: Float32Array, start: number, win: number, minLag: number, maxLag: number): number {
  let best = 0;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = start; i < start + win; i++) s += x[i] * x[i + lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return bestLag;
}

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

describe('pure helpers', () => {
  it('free-bar partial ratios', () => {
    expect([...GLASS_BAR_PARTIALS]).toEqual([1, 2.76, 5.4, 8.93]);
    const p = tingPartials(0.5);
    expect(p[0].freq).toBeCloseTo(tingFundamental(0.5));
    expect(p[1].freq / p[0].freq).toBeCloseTo(2.76);
    // decays shorten for higher partials
    for (let i = 1; i < p.length; i++) expect(p[i].decay).toBeLessThan(p[i - 1].decay);
  });

  it('bigger glass rings lower', () => {
    expect(tingFundamental(1)).toBeLessThan(tingFundamental(0.5));
    expect(tingFundamental(0.5)).toBeLessThan(tingFundamental(0));
    expect(tingFundamental(0)).toBeCloseTo(2600);
    expect(tingFundamental(1)).toBeCloseTo(650);
    // partials above hearing are dropped
    for (const p of tingPartials(0)) expect(p.freq).toBeLessThan(18000);
  });

  it('midiToFreq', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(81)).toBeCloseTo(880);
  });

  it('Karplus-Strong is in tune, decays and stays finite', () => {
    const sr = 48000;
    for (const midi of [60, 72, 84]) {
      const f = midiToFreq(midi);
      const x = karplusStrong(f, sr, 1.5, { t60: 1.5 });
      const lag = periodOf(x, 2000, 2048, Math.floor((sr / f) * 0.8), Math.ceil((sr / f) * 1.25));
      // integer-lag autocorrelation: within one sample of the true period
      expect(Math.abs(lag - sr / f)).toBeLessThan(1.01);
      expect(x.every(Number.isFinite)).toBe(true);
      expect(rms(x, sr, sr + 4800)).toBeLessThan(rms(x, 0, 4800) * 0.3);
    }
  });

  it('deterministic textures', () => {
    const a = bubbleTrain(8000, 1, 3);
    const b = bubbleTrain(8000, 1, 3);
    expect(a).toEqual(b);
    expect(rms(a, 0, a.length)).toBeGreaterThan(0.01);
    const c = crackleGrains(8000, 0.9, 5);
    expect(c.every(Number.isFinite)).toBe(true);
    expect(rms(c, 0, c.length)).toBeGreaterThan(0.001);
  });
});

// ------------------------------------------------- strict mock audio graph

class MockParam {
  value = 0;
  events: [string, number, number][] = [];
  private check(v: number, t: number) {
    expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
  }
  setValueAtTime(v: number, t: number) {
    this.check(v, t);
    this.events.push(['set', v, t]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.check(v, t);
    this.events.push(['lin', v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.check(v, t);
    expect(v).toBeGreaterThan(0); // Web Audio throws on <= 0
    this.events.push(['exp', v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number, k: number) {
    this.check(v, t);
    expect(k).toBeGreaterThan(0);
    this.events.push(['target', v, t]);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.check(0, t);
    return this;
  }
}

class MockNode {
  outputs: MockNode[] = [];
  started: number[] = [];
  stopped: number[] = [];
  constructor(public kind: string) {
    return new Proxy(this, {
      get(target, key, recv) {
        if (key in target || typeof key === 'symbol') return Reflect.get(target, key, recv);
        // any unknown property is an AudioParam (gain, frequency, positionX, ...)
        const p = new MockParam();
        (target as unknown as Record<string, unknown>)[key] = p;
        return p;
      },
    });
  }
  connect<T>(n: T): T {
    this.outputs.push(n as unknown as MockNode);
    return n;
  }
  disconnect() {}
  start(t = 0) {
    expect(Number.isFinite(t)).toBe(true);
    this.started.push(t);
  }
  stop(t = 0) {
    expect(Number.isFinite(t)).toBe(true);
    this.stopped.push(t);
  }
}

class MockCtx {
  currentTime = 10;
  sampleRate = 8000;
  nodes: MockNode[] = [];
  private make(kind: string) {
    const n = new MockNode(kind);
    this.nodes.push(n);
    return n;
  }
  createGain() {
    return this.make('gain');
  }
  createOscillator() {
    return this.make('osc');
  }
  createBufferSource() {
    return this.make('buffer');
  }
  createBiquadFilter() {
    return this.make('biquad');
  }
  createPanner() {
    return this.make('panner');
  }
  createStereoPanner() {
    return this.make('stereo');
  }
  createBuffer(ch: number, len: number, sr: number) {
    const data = [...Array(ch)].map(() => new Float32Array(len));
    return { length: len, sampleRate: sr, numberOfChannels: ch, getChannelData: (c: number) => data[c] };
  }
}

function rig() {
  const ctx = new MockCtx();
  const dry = new MockNode('dry');
  const wet = new MockNode('wet');
  const v = new GlassVoices(ctx as unknown as BaseAudioContext, dry as unknown as AudioNode, wet as unknown as AudioNode);
  return { ctx, v };
}

/** Every scheduled source starts at or after the context clock. */
function startsNotBefore(ctx: MockCtx, t: number) {
  for (const n of ctx.nodes) for (const s of n.started) expect(s).toBeGreaterThanOrEqual(t - 1e-9);
}

describe('GlassVoices on a mock context', () => {
  it('builds every voice without real-time dependencies', () => {
    const { ctx, v } = rig();
    const pos = { x: 0.1, y: 0.02, z: -0.1 };
    v.moltenStart('c1', pos);
    v.moltenHeat('c1', 0.8);
    v.moltenStop('c1');
    v.crackle(pos);
    v.ting(0.3, pos);
    v.ting(1);
    v.shatter(pos);
    v.shatter();
    v.pluck(72, pos);
    v.pluck(72.4);
    v.hushWake(pos);
    v.flowTone('c2', 64, true, pos);
    v.flowTone('c2', 67, true, pos);
    v.flowTone('c2', 67, false);
    startsNotBefore(ctx, 10);
    expect(ctx.nodes.some((n) => n.kind === 'panner')).toBe(true);
    // every started source is eventually stopped, except one-shot buffers that end by themselves
    for (const n of ctx.nodes) if (n.kind === 'osc' && n.started.length) expect(n.stopped.length).toBe(1);
  });

  it('honours offset and delay for offline replay', () => {
    const { ctx, v } = rig();
    v.offset = 5;
    v.ting(0.5, undefined, 0.25);
    const starts = ctx.nodes.flatMap((n) => n.started);
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) expect(s).toBeCloseTo(15.25);
  });

  it('pans with HRTF when a position is given', () => {
    const { ctx, v } = rig();
    v.ting(0.2, { x: 1, y: 0, z: 0 });
    const p = ctx.nodes.find((n) => n.kind === 'panner') as unknown as { panningModel: string; positionX: MockParam };
    expect(p.panningModel).toBe('HRTF');
    expect(p.positionX.value).toBe(1);
  });

  it('molten and flow voices are idempotent per id and stopAll releases them', () => {
    const { ctx, v } = rig();
    v.moltenStart('a');
    const n = ctx.nodes.length;
    v.moltenStart('a');
    expect(ctx.nodes.length).toBe(n);
    v.flowTone('f', 60, true);
    v.stopAll();
    const sources = ctx.nodes.filter((x) => (x.kind === 'osc' || x.kind === 'buffer') && x.started.length);
    for (const s of sources) expect(s.stopped.length).toBe(1);
    v.moltenHeat('a', 1); // no-op after stop
  });
});
