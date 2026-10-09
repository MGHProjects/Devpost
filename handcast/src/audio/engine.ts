/**
 * Procedural, spatialised sound. Everything is synthesised with Web Audio:
 * FM glass bells for crystals, soft pads that sustain while a crystal is lit,
 * tactile ticks for hand interactions and a chord swell when a puzzle
 * resolves. No audio files, so the build stays tiny and nothing is licensed.
 *
 * Every public call can be logged with a timestamp and replayed into an
 * OfflineAudioContext, which is how the demo video's soundtrack is rendered
 * frame-accurately from the same code that plays live.
 */

import { GlassVoices } from './voices.js';

const midiToFreq = (m: number): number => 440 * 2 ** ((m - 69) / 12);

export type TickKind = 'pick' | 'place' | 'rotate' | 'return' | 'deny' | 'ui';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

interface Sustain {
  gain: GainNode;
  oscs: OscillatorNode[];
}

export interface AudioEvent {
  t: number;
  name: 'bell' | 'startSustain' | 'stopSustain' | 'stopAllSustains' | 'tick' | 'resolve' | 'song' | 'setAmbient' | 'voice';
  args: unknown[];
}

const v = (p?: Vec3Like) => (p ? { x: p.x, y: p.y, z: p.z } : undefined);

export type VoiceName =
  | 'moltenStart'
  | 'moltenHeat'
  | 'moltenStop'
  | 'crackle'
  | 'ting'
  | 'shatter'
  | 'pluck'
  | 'hushWake'
  | 'flowTone'
  | 'stopAll';

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private sustains = new Map<number, Sustain>();
  private ambient: { gain: GainNode; oscs: OscillatorNode[] } | null = null;
  /** Added to the context clock; used when replaying a log offline. */
  private offset = 0;
  muted = false;
  /** Glass-specific voices (molten, ting, shatter, pluck, hush, flow); null until attached. */
  voices: GlassVoices | null = null;

  /** When set, every sound call is appended here (see `renderOffline`). */
  log: AudioEvent[] | null = null;
  clock: () => number = () => performance.now() / 1000;

  private record(name: AudioEvent['name'], args: unknown[]): void {
    if (this.log) this.log.push({ t: this.clock(), name, args });
  }

  /** Must be called from a user gesture (button press / XR session start). */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.attach(new Ctor({ latencyHint: 'interactive' }));
    }
    const live = this.ctx as AudioContext;
    if (live.state === 'suspended' && live.resume) void live.resume();
  }

  attach(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(comp).connect(ctx.destination);
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.2, 2.4);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.42;
    this.wet.connect(reverb).connect(this.master);
    this.voices = new GlassVoices(ctx, this.dry, this.wet);
    this.voices.muted = this.muted;
  }

  get ready(): boolean {
    return this.ctx !== null && (this.ctx as AudioContext).state === 'running';
  }

  private now(delay = 0): number {
    return this.ctx!.currentTime + this.offset + delay;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    let seed = 1234567;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = rand() * (1 - i / len) ** decay;
    }
    return buf;
  }

  private output(pos?: Vec3Like): AudioNode {
    const ctx = this.ctx!;
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
    node.connect(this.dry);
    node.connect(this.wet);
    return node;
  }

  setListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    const l = this.ctx?.listener;
    if (!l || !l.positionX) return;
    l.positionX.value = pos.x;
    l.positionY.value = pos.y;
    l.positionZ.value = pos.z;
    l.forwardX.value = forward.x;
    l.forwardY.value = forward.y;
    l.forwardZ.value = forward.z;
    l.upX.value = up.x;
    l.upY.value = up.y;
    l.upZ.value = up.z;
  }

  /** Glass bell: two-operator FM with an inharmonic shimmer partial. */
  bell(midi: number, pos?: Vec3Like, velocity = 1, length = 2.6, delay = 0): void {
    this.record('bell', [midi, v(pos), velocity, length, delay]);
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = this.now(delay);
    const f = midiToFreq(midi);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.32 * velocity, t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + length);
    out.connect(this.output(pos));

    const carrier = ctx.createOscillator();
    carrier.frequency.value = f;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 3.5;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * 2.2, t);
    modGain.gain.exponentialRampToValueAtTime(f * 0.05, t + length * 0.6);
    mod.connect(modGain).connect(carrier.frequency);
    carrier.connect(out);

    const shimmer = ctx.createOscillator();
    shimmer.frequency.value = f * 2.76;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.12 * velocity, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + length * 0.35);
    shimmer.connect(sg).connect(out);

    for (const o of [carrier, mod, shimmer]) {
      o.start(t);
      o.stop(t + length + 0.05);
    }
  }

  /** Soft pad that holds while a crystal is lit. */
  startSustain(id: number, midi: number, pos: Vec3Like): void {
    this.record('startSustain', [id, midi, v(pos)]);
    if (!this.ctx || this.sustains.has(id)) return;
    const ctx = this.ctx;
    const t = this.now();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.setTargetAtTime(this.muted ? 0.0001 : 0.05, t, 0.35);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = midiToFreq(midi) * 3;
    filter.Q.value = 0.6;
    gain.connect(filter).connect(this.output(pos));
    const oscs = [-6, 5].map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiToFreq(midi - 12);
      o.detune.value = cents;
      o.connect(gain);
      o.start(t);
      return o;
    });
    this.sustains.set(id, { gain, oscs });
  }

  stopSustain(id: number): void {
    this.record('stopSustain', [id]);
    const s = this.sustains.get(id);
    if (!s || !this.ctx) return;
    const t = this.now();
    s.gain.gain.cancelScheduledValues(t);
    s.gain.gain.setTargetAtTime(0.0001, t, 0.15);
    for (const o of s.oscs) o.stop(t + 0.9);
    this.sustains.delete(id);
  }

  stopAllSustains(): void {
    this.record('stopAllSustains', []);
    const log = this.log;
    this.log = null;
    for (const id of [...this.sustains.keys()]) this.stopSustain(id);
    this.log = log;
  }

  /** Short tactile sounds for hand interactions. */
  tick(kind: TickKind, pos?: Vec3Like): void {
    this.record('tick', [kind, v(pos)]);
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = this.now();
    const spec: Record<TickKind, [number, number, number, OscillatorType]> = {
      pick: [880, 1320, 0.09, 'sine'],
      place: [660, 330, 0.12, 'sine'],
      rotate: [1500, 1400, 0.035, 'triangle'],
      return: [520, 260, 0.16, 'sine'],
      deny: [180, 150, 0.14, 'square'],
      ui: [990, 990, 0.05, 'sine'],
    };
    const [f0, f1, len, type] = spec[kind];
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + len);
    const g = ctx.createGain();
    const peak = kind === 'deny' ? 0.05 : kind === 'rotate' ? 0.08 : 0.14;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.output(pos));
    o.start(t);
    o.stop(t + len + 0.02);
  }

  /** The puzzle resolves: arpeggiate the chord, then swell the bass. */
  resolve(notes: number[], bass: number, pos?: Vec3Like, delay = 0): void {
    this.record('resolve', [notes, bass, v(pos), delay]);
    if (!this.ctx || this.muted) return;
    const log = this.log;
    this.log = null;
    const sorted = [...notes].sort((a, b) => a - b);
    sorted.forEach((n, i) => this.bell(n, pos, 0.9, 3.2, delay + i * 0.11));
    this.bell(sorted[sorted.length - 1] + 12, pos, 0.5, 4, delay + sorted.length * 0.11 + 0.06);
    this.log = log;
    const ctx = this.ctx;
    const t = this.now(delay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    g.connect(this.output(pos));
    for (const n of [bass, bass + 12, ...sorted.map((s) => s - 12)]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiToFreq(n);
      o.connect(g);
      o.start(t);
      o.stop(t + 4.6);
    }
  }

  /** Play a sequence of chords as rolled bells (a movement's song). */
  song(chords: number[][], pos?: Vec3Like, delay = 0, spacing = 0.62): void {
    this.record('song', [chords, v(pos), delay, spacing]);
    const log = this.log;
    this.log = null;
    chords.forEach((tones, i) =>
      tones.forEach((n, j) => this.bell(n, pos, 0.6, 2.4, delay + i * spacing + j * 0.09)),
    );
    this.log = log;
  }

  /** Very quiet room tone on the movement's tonic. */
  setAmbient(midi: number | null): void {
    this.record('setAmbient', [midi]);
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = this.now();
    if (this.ambient) {
      const old = this.ambient;
      old.gain.gain.setTargetAtTime(0.0001, t, 0.8);
      for (const o of old.oscs) o.stop(t + 4);
      this.ambient = null;
    }
    if (midi === null || this.muted) return;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.setTargetAtTime(0.018, t, 1.5);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    gain.connect(filter).connect(this.output());
    const oscs = [0, 7, 12].map((iv, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiToFreq(midi - 24 + iv);
      o.detune.value = (i - 1) * 4;
      o.connect(gain);
      o.start(t);
      return o;
    });
    this.ambient = { gain, oscs };
  }

  /** Calls a GlassVoices method, logged for offline rendering like every other sound. */
  voice<K extends VoiceName>(name: K, ...args: Parameters<GlassVoices[K]>): void {
    this.record('voice', [name, ...args]);
    const v = this.voices;
    if (!v) return;
    v.offset = this.offset;
    (v[name] as (...a: unknown[]) => void).apply(v, args);
  }

  stopVoices(): void {
    this.record('voice', ['stopAll']);
    this.voices?.stopAll();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.voices) this.voices.muted = muted;
    const ctx = this.ctx;
    if (!ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
  }

  /** Render a recorded event log to an AudioBuffer (for the demo video). */
  static async renderOffline(events: AudioEvent[], seconds: number, t0 = 0): Promise<AudioBuffer> {
    const rate = 48000;
    const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate);
    const engine = new AudioEngine();
    engine.attach(ctx);
    engine.setListener({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -0.5, z: -1 }, { x: 0, y: 1, z: 0 });
    for (const e of events) {
      const at = e.t - t0;
      if (at < 0 || at > seconds) continue;
      engine.offset = at;
      (engine[e.name] as (...a: unknown[]) => void).apply(engine, e.args);
    }
    return ctx.startRendering();
  }
}

/** 16-bit PCM WAV encoding of an AudioBuffer. */
export function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const out = new ArrayBuffer(44 + len * ch * 2);
  const dv = new DataView(out);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + len * ch * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return out;
}
