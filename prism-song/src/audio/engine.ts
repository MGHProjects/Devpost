/**
 * Procedural, spatialised sound. Everything is synthesised with Web Audio:
 * FM glass bells for crystals, soft pads that sustain while a crystal is lit,
 * tactile ticks for hand interactions and a chord swell when a puzzle
 * resolves. No audio files, so the build stays tiny and nothing is licensed.
 */

import { midiToFreq } from '../game/music.js';

export type TickKind = 'pick' | 'place' | 'rotate' | 'return' | 'deny' | 'ui';

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

interface Sustain {
  gain: GainNode;
  oscs: OscillatorNode[];
  panner: PannerNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private sustains = new Map<number, Sustain>();
  private ambient: { gain: GainNode; oscs: OscillatorNode[] } | null = null;
  muted = false;

  /** Must be called from a user gesture (button press / XR session start). */
  unlock(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  private build(): void {
    const ctx = this.ctx!;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(comp).connect(ctx.destination);

    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.2, 2.4);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.42;
    this.wet.connect(reverb).connect(this.master);
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
      }
    }
    return buf;
  }

  private panner(pos?: Vec3Like): AudioNode {
    const ctx = this.ctx!;
    if (!pos) return this.dryWet(ctx.createGain());
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 0.4;
    p.rolloffFactor = 0.6;
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
    return this.dryWet(p);
  }

  private dryWet<T extends AudioNode>(node: T): T {
    node.connect(this.dry);
    node.connect(this.wet);
    return node;
  }

  setListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
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
  }

  /** Glass bell: two-operator FM with an inharmonic shimmer partial. */
  bell(midi: number, pos?: Vec3Like, velocity = 1, length = 2.6): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = midiToFreq(midi);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.32 * velocity, t + 0.006);
    out.gain.exponentialRampToValueAtTime(0.0001, t + length);
    out.connect(this.panner(pos));

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
    if (!this.ctx || this.sustains.has(id)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(this.muted ? 0.0001 : 0.05, t + 1.2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = midiToFreq(midi) * 3;
    filter.Q.value = 0.6;
    const panner = this.panner(pos) as PannerNode;
    gain.connect(filter).connect(panner);
    const oscs = [-6, 5].map((cents) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiToFreq(midi - 12);
      o.detune.value = cents;
      o.connect(gain);
      o.start(t);
      return o;
    });
    this.sustains.set(id, { gain, oscs, panner });
  }

  stopSustain(id: number): void {
    const s = this.sustains.get(id);
    if (!s || !this.ctx) return;
    const t = this.ctx.currentTime;
    s.gain.gain.cancelScheduledValues(t);
    s.gain.gain.setValueAtTime(Math.max(s.gain.gain.value, 0.0001), t);
    s.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    for (const o of s.oscs) o.stop(t + 0.7);
    this.sustains.delete(id);
  }

  stopAllSustains(): void {
    for (const id of [...this.sustains.keys()]) this.stopSustain(id);
  }

  /** Short tactile sounds for hand interactions. */
  tick(kind: TickKind, pos?: Vec3Like): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
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
    o.connect(g).connect(this.panner(pos));
    o.start(t);
    o.stop(t + len + 0.02);
  }

  /** The puzzle resolves: arpeggiate the chord, then swell the bass. */
  resolve(notes: number[], bass: number, pos?: Vec3Like): void {
    if (!this.ctx || this.muted) return;
    const sorted = [...notes].sort((a, b) => a - b);
    sorted.forEach((n, i) => {
      window.setTimeout(() => this.bell(n, pos, 0.9, 3.2), i * 110);
    });
    window.setTimeout(
      () => this.bell(sorted[sorted.length - 1] + 12, pos, 0.5, 4),
      sorted.length * 110 + 60,
    );
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
    g.connect(this.panner(pos));
    for (const n of [bass, bass + 12, ...sorted.map((s) => s - 12)]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiToFreq(n);
      o.connect(g);
      o.start(t);
      o.stop(t + 4.6);
    }
  }

  /** Very quiet room tone on the movement's tonic. */
  setAmbient(midi: number | null): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
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
    gain.connect(filter).connect(this.dryWet(ctx.createGain()));
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

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }
}
