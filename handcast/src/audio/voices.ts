/**
 * Procedural glass voices for HANDCAST, plugged into an existing Web Audio
 * graph (the integrator connects `out` to the engine's dry bus and `wet` to
 * its reverb bus): the bubbling sizzle of molten glass while a cast forms,
 * the crackle of cooling, free-bar "tings", shattering, Karplus-Strong glass
 * tines for plucked fingers, the sour cluster of a waking hush stone and a
 * glass-harmonica pad per lit cast.
 *
 * Everything is synthesised (no files) and scheduled from `ctx.currentTime +
 * offset + delay`, never from wall-clock timers, so the same calls render
 * identically into an OfflineAudioContext.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

// ------------------------------------------------------------ pure helpers

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Small deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Modal frequency ratios of a free-free bar (glass rod / bar chime). */
export const GLASS_BAR_PARTIALS = [1, 2.76, 5.4, 8.93] as const;
const PARTIAL_AMPS = [1, 0.55, 0.32, 0.18];
const PARTIAL_DECAYS = [1.7, 0.95, 0.5, 0.28];

/** Fundamental of a ting: small pieces ring high, big ones low (2600 Hz .. 650 Hz). */
export function tingFundamental(sizeNorm: number): number {
  const s = Math.min(1, Math.max(0, sizeNorm));
  return 2600 * Math.pow(2, -2 * s);
}

export interface Partial {
  freq: number;
  amp: number;
  /** Seconds to fall ~60 dB. */
  decay: number;
}

/** The partial set of a glass free-bar of normalised size (0 = sliver, 1 = whole hand). */
export function tingPartials(sizeNorm: number, length = 1): Partial[] {
  const f0 = tingFundamental(sizeNorm);
  const s = Math.min(1, Math.max(0, sizeNorm));
  return GLASS_BAR_PARTIALS.map((r, i) => ({
    freq: f0 * r,
    amp: PARTIAL_AMPS[i],
    decay: PARTIAL_DECAYS[i] * (0.55 + 0.75 * s) * length,
  })).filter((p) => p.freq < 18000);
}

export interface KarplusOptions {
  /** Seconds for the string to fall 60 dB at its fundamental. */
  t60?: number;
  /** 0..1: brightness of the excitation (1 = white noise burst). */
  brightness?: number;
  seed?: number;
}

/**
 * Karplus-Strong plucked tine: a noise burst circulating in a delay line with
 * a two-point averaging lowpass and an allpass for fractional tuning.
 */
export function karplusStrong(freq: number, sampleRate: number, seconds: number, opts: KarplusOptions = {}): Float32Array {
  const t60 = opts.t60 ?? 1.8;
  const bright = Math.min(1, Math.max(0, opts.brightness ?? 0.8));
  const rand = mulberry32(opts.seed ?? 7);
  const out = new Float32Array(Math.max(1, Math.floor(sampleRate * seconds)));
  // averaging filter adds half a sample of delay
  const D = Math.max(2, sampleRate / freq - 0.5);
  // keep the allpass fraction in [0.1, 1.1) so its pole stays clear of z = -1
  const N = Math.max(1, Math.floor(D - 0.1));
  const frac = D - N;
  const C = (1 - frac) / (1 + frac);
  const line = new Float32Array(N);
  // excitation: noise, lowpassed for darker plucks, then DC-removed
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < N; i++) {
    lp += (rand() * 2 - 1 - lp) * (0.15 + 0.85 * bright);
    line[i] = lp;
    mean += lp;
  }
  mean /= N;
  for (let i = 0; i < N; i++) line[i] -= mean;
  const rho = Math.pow(0.001, 1 / (freq * t60));
  let idx = 0;
  let prev = 0;
  let apIn = 0;
  let apOut = 0;
  for (let n = 0; n < out.length; n++) {
    const cur = line[idx];
    const avg = 0.5 * (cur + prev) * rho;
    prev = cur;
    // first-order allpass (fractional delay)
    const y = C * avg + apIn - C * apOut;
    apIn = avg;
    apOut = y;
    line[idx] = y;
    out[n] = cur;
    idx = idx + 1 >= N ? 0 : idx + 1;
  }
  return out;
}

/**
 * A loopable train of viscous bubbles (rising-pitch damped sines, after
 * Minnaert / van den Doel) for molten glass.
 */
export function bubbleTrain(sampleRate: number, seconds: number, seed = 11): Float32Array {
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  const rand = mulberry32(seed);
  const count = Math.floor(seconds * 14);
  for (let b = 0; b < count; b++) {
    const f0 = 140 + Math.pow(rand(), 2) * 760;
    const tau = 0.012 + rand() * 0.05;
    const amp = 0.25 + rand() * 0.75;
    const dur = tau * 5;
    const start = Math.floor(rand() * (seconds - dur) * sampleRate);
    let phase = 0;
    const n = Math.floor(dur * sampleRate);
    for (let i = 0; i < n && start + i < out.length; i++) {
      const t = i / sampleRate;
      const f = f0 * (1 + (0.9 * t) / tau);
      phase += (2 * Math.PI * f) / sampleRate;
      const env = Math.exp(-t / tau) * Math.min(1, t * 800);
      out[start + i] += Math.sin(phase) * env * amp * 0.5;
    }
  }
  return out;
}

/** Granular cooling crackle: sparse clicks and tiny tinks that thin out over time. */
export function crackleGrains(sampleRate: number, seconds: number, seed = 5): Float32Array {
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  const rand = mulberry32(seed);
  const grains = 46;
  for (let g = 0; g < grains; g++) {
    // denser at the start, thinning out (cooling)
    const t0 = Math.pow(rand(), 1.8) * (seconds - 0.05);
    const start = Math.floor(t0 * sampleRate);
    const amp = (0.2 + rand() * 0.8) * (1 - (0.6 * t0) / seconds);
    if (rand() < 0.75) {
      // click: a few ms of decaying, highpassed noise
      const len = Math.floor((0.0008 + rand() * 0.003) * sampleRate);
      let last = 0;
      for (let i = 0; i < len && start + i < out.length; i++) {
        const x = rand() * 2 - 1;
        out[start + i] += (x - last) * amp * Math.exp((-6 * i) / len) * 0.6;
        last = x;
      }
    } else {
      // tink: a short high damped sine
      const f = 2800 + rand() * 4200;
      const len = Math.floor(0.02 * sampleRate);
      for (let i = 0; i < len && start + i < out.length; i++) {
        out[start + i] += Math.sin((2 * Math.PI * f * i) / sampleRate) * amp * 0.35 * Math.exp((-5 * i) / len);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ voices

interface Molten {
  out: GainNode;
  bubbles: AudioBufferSourceNode;
  noise: AudioBufferSourceNode;
  lfo: OscillatorNode;
  bubbleFilter: BiquadFilterNode;
  sizzleFilter: BiquadFilterNode;
  sizzleGain: GainNode;
  lfoDepth: GainNode;
}

interface Flow {
  out: GainNode;
  oscs: OscillatorNode[];
  vibrato: OscillatorNode;
  midi: number;
}

export class GlassVoices {
  /** Added to the context clock (seconds), e.g. when replaying a log offline. */
  offset = 0;
  muted = false;
  private molten = new Map<string, Molten>();
  private flows = new Map<string, Flow>();
  private noiseBuf: AudioBuffer;
  private bubbleBuf: AudioBuffer;
  private crackleBufs: AudioBuffer[];
  private pluckBufs = new Map<number, AudioBuffer>();
  private rand = mulberry32(0x5eed);

  constructor(
    private ctx: BaseAudioContext,
    private out: AudioNode,
    private wet: AudioNode,
  ) {
    const sr = ctx.sampleRate;
    const rand = mulberry32(99);
    const noise = new Float32Array(Math.floor(sr * 2));
    for (let i = 0; i < noise.length; i++) noise[i] = rand() * 2 - 1;
    this.noiseBuf = this.buffer(noise);
    this.bubbleBuf = this.buffer(bubbleTrain(sr, 3));
    this.crackleBufs = [5, 6, 7].map((s) => this.buffer(crackleGrains(sr, 0.9, s)));
  }

  private buffer(data: Float32Array): AudioBuffer {
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.getChannelData(0).set(data);
    return buf;
  }

  private now(delay = 0): number {
    return this.ctx.currentTime + this.offset + delay;
  }

  /** A sink at `pos` (HRTF) or centred, feeding dry and (scaled) wet buses. */
  private output(pos: Vec3Like | undefined, wetAmount: number): AudioNode {
    const ctx = this.ctx;
    let node: AudioNode;
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 0.4;
      p.rolloffFactor = 0.6;
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
      node = p;
    } else {
      node = ctx.createGain();
    }
    node.connect(this.out);
    const send = ctx.createGain();
    send.gain.value = wetAmount;
    node.connect(send).connect(this.wet);
    return node;
  }

  private env(gain: AudioParam, t: number, peak: number, attack: number, decay: number): void {
    gain.setValueAtTime(0.0001, t);
    gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // ------------------------------------------------------------- molten

  /** Start the molten-glass bubbling/sizzle loop for a forming cast. */
  moltenStart(id: string, pos?: Vec3Like, delay = 0): void {
    if (this.muted || this.molten.has(id)) return;
    const ctx = this.ctx;
    const t = this.now(delay);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.setTargetAtTime(0.5, t, 0.08);
    out.connect(this.output(pos, 0.25));

    const bubbles = ctx.createBufferSource();
    bubbles.buffer = this.bubbleBuf;
    bubbles.loop = true;
    bubbles.playbackRate.value = 0.8;
    const bubbleFilter = ctx.createBiquadFilter();
    bubbleFilter.type = 'lowpass';
    bubbleFilter.frequency.value = 900;
    bubbleFilter.Q.value = 0.9;
    bubbles.connect(bubbleFilter).connect(out);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    noise.loop = true;
    const sizzleFilter = ctx.createBiquadFilter();
    sizzleFilter.type = 'bandpass';
    sizzleFilter.frequency.value = 2200;
    sizzleFilter.Q.value = 0.8;
    const sizzleGain = ctx.createGain();
    sizzleGain.gain.value = 0.05;
    // LFO wobbles the sizzle level: a seething, boiling texture
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 7.5;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.03;
    lfo.connect(lfoDepth).connect(sizzleGain.gain);
    noise.connect(sizzleFilter).connect(sizzleGain).connect(out);

    const off = this.rand() * 2;
    bubbles.start(t, off);
    noise.start(t, off);
    lfo.start(t);
    this.molten.set(id, { out, bubbles, noise, lfo, bubbleFilter, sizzleFilter, sizzleGain, lfoDepth });
    this.moltenHeat(id, 0.3, delay);
  }

  /** 0..1: brightens and quickens the bubbling as the glass flows to the fingertips. */
  moltenHeat(id: string, heat: number, delay = 0): void {
    const m = this.molten.get(id);
    if (!m) return;
    const h = Math.min(1, Math.max(0, heat));
    const t = this.now(delay);
    m.bubbles.playbackRate.setTargetAtTime(0.7 + 0.7 * h, t, 0.05);
    m.bubbleFilter.frequency.setTargetAtTime(500 + 2600 * h, t, 0.05);
    m.sizzleFilter.frequency.setTargetAtTime(1500 + 5200 * h * h, t, 0.05);
    m.sizzleGain.gain.setTargetAtTime(0.02 + 0.09 * h, t, 0.05);
    m.lfoDepth.gain.setTargetAtTime(0.015 + 0.05 * h, t, 0.05);
    m.lfo.frequency.setTargetAtTime(5 + 9 * h, t, 0.1);
  }

  moltenStop(id: string, delay = 0): void {
    const m = this.molten.get(id);
    if (!m) return;
    this.molten.delete(id);
    const t = this.now(delay);
    m.out.gain.cancelScheduledValues(t);
    m.out.gain.setTargetAtTime(0.0001, t, 0.07);
    for (const s of [m.bubbles, m.noise, m.lfo]) s.stop(t + 0.6);
  }

  // ------------------------------------------------------------ one-shots

  /** Granular crackle of glass cooling into a cast. */
  crackle(pos?: Vec3Like, delay = 0): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const t = this.now(delay);
    const src = ctx.createBufferSource();
    src.buffer = this.crackleBufs[Math.floor(this.rand() * this.crackleBufs.length)];
    src.playbackRate.value = 0.85 + this.rand() * 0.3;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.value = 0.55;
    src.connect(hp).connect(g).connect(this.output(pos, 0.3));
    src.start(t);
  }

  /** A struck glass free-bar; `sizeNorm` 0 = tiny sliver (high), 1 = a whole hand (low). */
  ting(sizeNorm: number, pos?: Vec3Like, delay = 0, velocity = 1, length = 1): void {
    if (this.muted) return;
    this.tingInto(this.output(pos, 0.45), sizeNorm, this.now(delay), velocity, length);
  }

  private tingInto(dest: AudioNode, sizeNorm: number, t: number, velocity: number, length: number): void {
    const ctx = this.ctx;
    const detune = (this.rand() - 0.5) * 30;
    for (const p of tingPartials(sizeNorm, length)) {
      const o = ctx.createOscillator();
      o.frequency.value = p.freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      this.env(g.gain, t, 0.11 * p.amp * velocity, 0.0015, p.decay);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + p.decay + 0.05);
    }
  }

  /** Breaking a cast: a bright noise burst, resonant clinks and shards ticking as they settle. */
  shatter(pos?: Vec3Like, delay = 0): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const t = this.now(delay);
    const dest = this.output(pos, 0.5);

    const burst = ctx.createBufferSource();
    burst.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(5000, t);
    hp.frequency.exponentialRampToValueAtTime(1800, t + 0.3);
    const bg = ctx.createGain();
    this.env(bg.gain, t, 0.45, 0.002, 0.38);
    burst.connect(hp).connect(bg).connect(dest);
    burst.start(t, this.rand());
    burst.stop(t + 0.5);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(120, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const tg = ctx.createGain();
    this.env(tg.gain, t, 0.25, 0.003, 0.14);
    thump.connect(tg).connect(dest);
    thump.start(t);
    thump.stop(t + 0.2);

    for (let i = 0; i < 7; i++) {
      this.tingInto(dest, this.rand() * 0.55, t + this.rand() * 0.22, 0.55 + this.rand() * 0.35, 0.6);
    }
    // shards: scattered around the source, thinning over ~1.6 s
    for (let i = 0; i < 22; i++) {
      const at = t + 0.15 + Math.pow(this.rand(), 1.6) * 1.5;
      let shardDest = dest;
      if (pos) {
        const a = this.rand() * Math.PI * 2;
        const r = 0.05 + this.rand() * 0.15;
        shardDest = this.output({ x: pos.x + Math.cos(a) * r, y: pos.y, z: pos.z + Math.sin(a) * r }, 0.4);
      } else {
        const pan = ctx.createStereoPanner();
        pan.pan.value = this.rand() * 1.6 - 0.8;
        pan.connect(dest);
        shardDest = pan;
      }
      this.tingInto(shardDest, this.rand() * 0.25, at, 0.4 * (1 - (at - t) / 2), 0.12);
    }
  }

  /** A plucked glass finger (kalimba-like tine). */
  pluck(midi: number, pos?: Vec3Like, delay = 0, velocity = 1): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const t = this.now(delay);
    const key = Math.round(midi);
    let buf = this.pluckBufs.get(key);
    if (!buf) {
      buf = this.buffer(karplusStrong(midiToFreq(key), ctx.sampleRate, 2.2, { t60: 2, brightness: 0.75, seed: key }));
      this.pluckBufs.set(key, buf);
    }
    const dest = this.output(pos, 0.4);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.detune.value = (midi - key) * 100;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 110;
    const g = ctx.createGain();
    g.gain.value = 0.55 * velocity;
    src.connect(hp).connect(g).connect(dest);
    src.start(t);
    // glassy "tink" on the attack: the bar's inharmonic upper mode
    const f = midiToFreq(midi);
    const o = ctx.createOscillator();
    o.frequency.value = Math.min(f * 5.4, 16000);
    const og = ctx.createGain();
    this.env(og.gain, t, 0.05 * velocity, 0.001, 0.18);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.25);
  }

  /** A hush stone wakes: a sour, wilting cluster. */
  hushWake(pos?: Vec3Like, delay = 0): void {
    if (this.muted) return;
    const ctx = this.ctx;
    const t = this.now(delay);
    const dest = this.output(pos, 0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(1500, t + 0.12);
    lp.frequency.exponentialRampToValueAtTime(420, t + 1.4);
    const g = ctx.createGain();
    this.env(g.gain, t, 0.09, 0.06, 1.5);
    lp.connect(g).connect(dest);
    const base = 54; // F#3
    for (const [k, iv] of [0, 1, 6, 11].entries()) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToFreq(base + iv);
      o.detune.setValueAtTime((k % 2 ? 9 : -7), t);
      o.detune.linearRampToValueAtTime((k % 2 ? 9 : -7) - 35, t + 1.5); // wilts flat
      o.connect(lp);
      o.start(t);
      o.stop(t + 1.7);
    }
  }

  // --------------------------------------------------------------- pads

  /** Glass-harmonica pad that holds while a cast carries light; `on=false` releases it. */
  flowTone(id: string, midi: number, on: boolean, pos?: Vec3Like, delay = 0): void {
    const ctx = this.ctx;
    const t = this.now(delay);
    const cur = this.flows.get(id);
    if (!on) {
      if (!cur) return;
      this.flows.delete(id);
      cur.out.gain.cancelScheduledValues(t);
      cur.out.gain.setTargetAtTime(0.0001, t, 0.25);
      for (const o of cur.oscs) o.stop(t + 1.6);
      cur.vibrato.stop(t + 1.6);
      return;
    }
    if (cur) {
      if (cur.midi !== midi) {
        cur.midi = midi;
        const f = midiToFreq(midi);
        cur.oscs.forEach((o, i) => o.frequency.setTargetAtTime(f * (i + 1), t, 0.06));
      }
      return;
    }
    if (this.muted) return;
    const f = midiToFreq(midi);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.setTargetAtTime(0.04, t, 0.25);
    out.connect(this.output(pos, 0.6));
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 4.6 + this.rand() * 1.2;
    const oscs: OscillatorNode[] = [];
    [1, 0.22, 0.06].forEach((amp, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f * (i + 1);
      const depth = ctx.createGain();
      depth.gain.value = f * (i + 1) * 0.004;
      vibrato.connect(depth).connect(o.frequency);
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(out);
      o.start(t);
      oscs.push(o);
    });
    vibrato.start(t);
    this.flows.set(id, { out, oscs, vibrato, midi });
  }

  /** Release every held voice (scene change). */
  stopAll(delay = 0): void {
    for (const id of [...this.molten.keys()]) this.moltenStop(id, delay);
    for (const id of [...this.flows.keys()]) this.flowTone(id, 0, false, undefined, delay);
  }
}
