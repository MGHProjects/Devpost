/**
 * HANDCAST game system: ties hand tracking, hand optics, the light tracer,
 * glass casting, physical interactions, sound and the HUD together.
 *
 * The loop, per frame (XR):
 *  1. Track both hands (25 joints) in bench space.
 *  2. Every hand resting over the bench is a live optic: light entering one
 *     open end leaves through every other open fingertip.
 *  3. Trace the board with the glass hands plus the live hands (display) and
 *     with the glass hands only (the solve check).
 *  4. A lit hand that holds still is coated in molten glass from wrist to
 *     fingertips and freezes into a glass hand.
 *  5. Glass hands can be pinched by the foot and slid / twisted, knocked over
 *     with a fist (shatter + refund) and plucked like kalimba tines.
 */

import {
  Color as ThreeColor,
  createSystem,
  Entity,
  Group,
  Matrix4,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { AudioEngine, encodeWav } from '../audio/engine.js';
import { computeOptic, FeatureState } from '../core/hand-features.js';
import { benchToWorld, iwerPoseFromWorld, IWER_REGISTER_POSE_JS } from '../core/iwer-pose.js';
import { canonicalPose, PoseName } from '../core/pose-library.js';
import type { PoseShape } from '../core/pose-library.js';
import { traceLevel } from '../core/trace2d.js';
import { HandOptic, HandPose, LevelDef, TraceResult, V2 } from '../core/types.js';
import { TableAnchor } from '../input/anchor.js';
import { isKnock, pinchGrabs, pluckCrossing, twistAngle, unwrapAngle, GESTURE } from '../input/gestures.js';
import { HandTracker25, TrackedHand } from '../input/hand-tracker.js';
import { Ambience } from '../render/bench/ambience.js';
import { BeamRenderer2D } from '../render/bench/beams2d.js';
import { BenchView } from '../render/bench/bench-view.js';
import { lightColor } from '../render/bench/props.js';
import { CastView } from '../render/glass/cast-view.js';
import { CoatMesh, createCoatMesh } from '../render/glass/coat-material.js';
import { HandTemplate, loadHandTemplates } from '../render/glass/hand-model.js';
import { Shatter } from '../render/glass/shatter.js';
import { castToPose, footOf, poseToCast, transformPose } from './pose-ops.js';
import { Hud, HudHandlers } from './hud.js';
import { LevelSource, levelSource } from './level-source.js';
import { loadProgress, Progress, saveProgress } from './progress.js';

const FWD = -Math.PI / 2;
const SLAB_HEIGHT = 0.11; // a hand participates when its palm is this close to the bench
const BENCH_MARGIN = 0.06;
const WITHDRAW = 0.07; // after casting, move this far before the same hand can cast again
const PLUCK_NOTES = [74, 69, 67, 71, 76];

interface Cast {
  id: number;
  base: HandPose; // pose when created
  baseFoot: V2;
  yaw: number; // rotation about the foot since creation
  offset: V2; // translation since creation
  pose: HandPose; // current pose
  optic: HandOptic;
  view: CastView;
  cooling: number; // 1 -> 0 after creation
  flowing: boolean;
  kind: 'glass' | 'ghost';
}

interface Grab {
  cast: Cast;
  startQuat: Float32Array;
  startYaw: number;
  twist: number;
  grip: V2; // foot - pinch point at grab start
}

interface Live {
  hand: TrackedHand;
  feat: FeatureState;
  optic: HandOptic | null;
  coat: CoatMesh | null;
  coatFor: SkinnedMesh | null;
  progress: number;
  lockFoot: V2 | null;
  grab: Grab | null;
  prevTip: Float32Array;
  hadTip: boolean;
  sizzle: boolean;
  lastKnock: number;
}

type Mode = 'calibrate' | 'play' | 'studio' | 'demo';

export class HandcastSystem extends createSystem({}) {
  private audio = new AudioEngine();
  private tracker = new HandTracker25();
  private progress: Progress = loadProgress();
  private hud!: Hud;
  private source: LevelSource = levelSource();
  private templates: { left: HandTemplate; right: HandTemplate } | null = null;

  private benchRoot = new Group();
  private benchEntity!: Entity;
  private ambience = new Ambience();
  private bench: BenchView | null = null;
  private beams: BeamRenderer2D | null = null;
  private table = new TableAnchor();

  private mode: Mode = 'play';
  private level!: LevelDef;
  private levelIndex = 0; // into source.levels(), -1 daily, -2 kiln, -3 shared/hall
  private casts: Cast[] = [];
  private ghosts: Cast[] = [];
  private shatters: Shatter[] = [];
  private nextCastId = 1;
  private castsDirty = true;
  private castsResult: TraceResult | null = null;
  private display: TraceResult | null = null;
  private prevCrystal: string[] = [];
  private prevHush: boolean[] = [];
  private solved = false;
  private notes: number[] = [];
  private gazeSung = new Set<number>();
  private gazed = -1;
  private gazeTime = 0;
  private hintUntil = 0;
  private boost = 0;
  private time = 0;
  private placed = false;
  private pendingPlace = false;
  private calibrating = false;
  private calibHold = 0;
  private demoT = 0;
  private demoStep = 0;
  private backdrop = new ThreeColor(0x07090f);

  private live: Live[] = [];

  // scratch
  private m1 = new Matrix4();
  private worldToBench = new Matrix4();
  private v1 = new Vector3();
  private v2 = new Vector3();
  private headPos = new Vector3();
  private headFwd = new Vector3();
  private headUp = new Vector3();
  private q1 = new Quaternion();
  private col = new ThreeColor();

  init(): void {
    this.benchRoot.name = 'bench-root';
    this.benchEntity = this.world.createTransformEntity(this.benchRoot, { persistent: true });
    this.world.scene.add(this.ambience.group);
    this.audio.setMuted(this.progress.muted);
    this.audio.clock = () => this.time;
    for (const hand of this.tracker.hands) {
      this.live.push({
        hand,
        feat: { extended: [false, false, false, false, false] },
        optic: null,
        coat: null,
        coatFor: null,
        progress: 0,
        lockFoot: null,
        grab: null,
        prevTip: new Float32Array(3),
        hadTip: false,
        sizzle: false,
        lastKnock: -10,
      });
    }

    this.hud = new Hud(this.world, this.hudHandlers());
    this.cleanupFuncs.push(() => this.hud.dispose());

    const unlock = () => this.audio.unlock();
    const canvas = this.world.renderer.domElement;
    canvas.addEventListener('pointerdown', unlock);
    this.cleanupFuncs.push(() => canvas.removeEventListener('pointerdown', unlock));

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((vs) => {
        const immersive = vs !== VisibilityState.NonImmersive;
        this.world.scene.background = immersive ? null : this.backdrop;
        if (immersive) {
          this.audio.unlock();
          this.enterXR();
        } else {
          this.exitXR();
        }
      }),
    );

    void loadHandTemplates().then((t) => {
      this.templates = t;
      this.loadIndex(this.startIndex());
    });
    this.layoutDesktop();
    this.exposeDebug();
  }

  // ------------------------------------------------------------------ HUD

  private guard(fn: () => void): () => void {
    return () => {
      // A pinch on a glass hand can also fire the hand ray at the HUD.
      if (this.live.some((l) => l.grab || l.progress > 0.25)) return;
      this.audio.unlock();
      this.audio.tick('ui');
      fn();
    };
  }

  private hudHandlers(): HudHandlers {
    const g = (fn: () => void) => this.guard(fn);
    return {
      undo: g(() => this.undoCast()),
      reset: g(() => this.resetBoard()),
      hint: g(() => this.showHint()),
      menu: g(() => this.openMenu()),
      next: g(() => this.nextBoard()),
      back: g(() => this.hud.show(this.mode === 'studio' ? 'studio' : 'play')),
      pick: (i) => g(() => this.loadIndex(i))(),
      daily: g(() => this.loadSpecial(this.source.daily(), -1)),
      kiln: g(() => this.loadSpecial(this.source.kiln(1 + ((this.progress.solved.length / 8) | 0) % 3, (Math.random() * 1e9) | 0), -2)),
      studio: g(() => this.setStatus('The Studio opens in the next build.')),
      hall: g(() => this.setStatus('The Hall of Hands opens in the next build.')),
      sound: g(() => {
        this.progress.muted = !this.progress.muted;
        this.audio.setMuted(this.progress.muted);
        saveProgress(this.progress);
        this.openMenu();
      }),
      assist: g(() => {
        this.progress.steady = !this.progress.steady;
        saveProgress(this.progress);
        this.openMenu();
      }),
      recenter: g(() => {
        this.hud.show('play');
        this.startCalibration();
      }),
      tool: () => {},
      drop: () => {},
      publish: () => {},
      studioExit: g(() => this.hud.show('play')),
      hallTab: () => {},
      hallPick: () => {},
    };
  }

  private openMenu(): void {
    const levels = this.source.levels();
    this.hud.setMenuState(
      levels.map((l) => (this.progress.solved.includes(l.id) ? 'solved' : 'open')),
      this.levelIndex,
      {
        daily: this.progress.dailyStreak > 0 ? `Daily x${this.progress.dailyStreak}` : 'Daily',
        sound: this.progress.muted ? 'Muted' : 'Sound',
        assist: this.progress.steady ? 'Steady on' : 'Steady',
      },
    );
    this.hud.show('menu');
  }

  private setStatus(s: string): void {
    this.hud.setStatus(s);
  }

  // ------------------------------------------------------------------ boards

  private startIndex(): number {
    const levels = this.source.levels();
    const cur = levels.findIndex((l) => l.id === this.progress.current);
    if (cur >= 0) return cur;
    const first = levels.findIndex((l) => !this.progress.solved.includes(l.id));
    return first >= 0 ? first : 0;
  }

  private loadIndex(i: number): void {
    const levels = this.source.levels();
    const idx = Math.max(0, Math.min(levels.length - 1, i));
    this.levelIndex = idx;
    this.loadLevel(levels[idx]);
    this.progress.current = levels[idx].id;
    saveProgress(this.progress);
  }

  private loadSpecial(level: LevelDef, index: number): void {
    this.levelIndex = index;
    this.loadLevel(level);
  }

  loadLevel(level: LevelDef): void {
    this.clearBoard();
    this.level = level;
    this.solved = false;
    this.castsDirty = true;
    this.prevCrystal = level.crystals.map(() => 'off');
    this.prevHush = level.hush.map(() => false);
    this.gazeSung.clear();
    this.notes = this.source.notesFor(level, this.levelIndex);

    const bench = (this.bench = new BenchView(level));
    this.benchRoot.add(bench.root);
    this.beams = new BeamRenderer2D();
    bench.root.add(this.beams.group);

    const info = this.source.describe(level, this.levelIndex);
    this.hud.setBoard(info.eyebrow, level.name, level.hint ?? this.defaultHint());
    this.hud.setSolved(false, this.hasNext());
    this.hud.setBudget(level.budget, level.budget);
    this.hud.show(this.mode === 'studio' ? 'studio' : 'play');
    this.audio.setAmbient(this.source.tonic(level, this.levelIndex));
    if (this.mode === 'demo') this.demoT = 0;
  }

  private defaultHint(): string {
    if (this.level.wells.length) return 'Rest your palm in the light. Hold still to turn it to glass.';
    return 'Catch the beam with a fingertip or your wrist, then hold still.';
  }

  private clearBoard(): void {
    for (const c of [...this.casts, ...this.ghosts]) c.view.dispose();
    this.casts = [];
    this.ghosts = [];
    for (const s of this.shatters) s.dispose();
    this.shatters = [];
    this.beams?.dispose();
    this.bench?.dispose();
    this.bench = null;
    this.beams = null;
    this.audio.stopAllSustains();
    this.audio.stopVoices();
    this.castsResult = null;
    this.display = null;
    for (const l of this.live) {
      l.progress = 0;
      l.lockFoot = null;
      l.grab = null;
    }
  }

  private resetBoard(): void {
    this.loadLevel(this.level);
  }

  private hasNext(): boolean {
    return this.levelIndex >= 0 && this.levelIndex < this.source.levels().length - 1;
  }

  private nextBoard(): void {
    if (this.hasNext()) this.loadIndex(this.levelIndex + 1);
    else this.loadSpecial(this.source.daily(), -1);
  }

  // ------------------------------------------------------------------ casts

  private castsLeft(): number {
    return this.level.budget - this.casts.length;
  }

  addCast(pose: HandPose, kind: 'glass' | 'ghost' = 'glass', animate = true): Cast | null {
    if (!this.templates || !this.bench) return null;
    const view = new CastView(this.templates, pose, kind, kind === 'ghost' ? { subdivide: 0 } : {});
    this.bench.root.add(view.root);
    const cast: Cast = {
      id: this.nextCastId++,
      base: pose,
      baseFoot: footOf(pose),
      yaw: 0,
      offset: [0, 0],
      pose,
      optic: computeOptic(pose, { id: `cast-${this.nextCastId}`, live: false }),
      view,
      cooling: animate ? 1 : 0,
      flowing: false,
      kind,
    };
    if (kind === 'ghost') {
      this.ghosts.push(cast);
      view.setOpacity(0);
      return cast;
    }
    view.setMolten(1, animate ? 1 : 0);
    this.casts.push(cast);
    this.castsDirty = true;
    this.hud.setBudget(this.castsLeft(), this.level.budget);
    return cast;
  }

  private moveCast(c: Cast, yaw: number, offset: V2): void {
    c.yaw = yaw;
    c.offset = offset;
    c.pose = transformPose(c.base, c.baseFoot, yaw, offset[0], offset[1]);
    c.optic = computeOptic(c.pose, { id: c.optic.id, live: false });
    c.view.root.position.set(c.baseFoot[0] + offset[0], 0, c.baseFoot[1] + offset[1]);
    c.view.root.rotation.y = yaw;
    this.castsDirty = true;
  }

  private shatterCast(c: Cast): void {
    const i = this.casts.indexOf(c);
    if (i < 0) return;
    this.casts.splice(i, 1);
    const s = c.view.shatter();
    this.shatters.push(s);
    c.view.dispose();
    this.castsDirty = true;
    this.audio.voice('flowTone', `cast-${c.id}`, 0, false);
    this.audio.voice('shatter', this.benchPos(c.view.root.position, this.v1));
    for (const l of this.live) if (l.grab?.cast === c) l.grab = null;
    this.hud.setBudget(this.castsLeft(), this.level.budget);
    if (this.solved) {
      this.solved = false;
      this.hud.setSolved(false, this.hasNext());
    }
  }

  private undoCast(): void {
    const last = this.casts[this.casts.length - 1];
    if (last) this.shatterCast(last);
  }

  // ------------------------------------------------------------------ tracing

  private retrace(): void {
    if (!this.bench || !this.beams) return;
    const castOptics = this.casts.map((c) => c.optic);
    if (this.castsDirty) {
      this.castsResult = traceLevel(this.level, castOptics);
      this.castsDirty = false;
    }
    const lives: HandOptic[] = [];
    for (const l of this.live) if (l.optic) lives.push(l.optic);
    const display = (this.display = lives.length ? traceLevel(this.level, [...castOptics, ...lives]) : this.castsResult!);
    this.beams.setSegments(display.segments);

    const meter: (string | null)[] = [];
    display.crystals.forEach((c, i) => {
      this.bench!.setCrystal(i, c.state, c.received);
      const was = this.prevCrystal[i];
      const pos = this.benchPos(this.bench!.worldOf('crystal', i, this.v1), this.v1);
      const note = this.notes[i];
      if (c.state === 'lit' && was !== 'lit') this.audio.bell(note, pos, 0.75);
      const committed = this.castsResult!.crystals[i].state === 'lit';
      if (committed) this.audio.startSustain(i, note, pos);
      else this.audio.stopSustain(i);
      this.prevCrystal[i] = c.state;
      meter.push(committed ? `#${lightColor(this.level.crystals[i].color).getHexString()}` : null);
    });
    display.hush.forEach((h, i) => {
      this.bench!.setHush(i, h.awake);
      if (h.awake && !this.prevHush[i]) {
        this.audio.voice('hushWake', this.benchPos(this.bench!.worldOf('hush', i, this.v1), this.v1));
      }
      this.prevHush[i] = h.awake;
    });
    this.hud.setMeter(meter);

    // Light inside glass: each finger glows with what it carries.
    for (const c of this.casts) {
      const io = display.hands.find((h) => h.id === c.optic.id);
      let carried = 0;
      for (let f = 0; f < 5; f++) {
        const m = io ? io.outMask[f] | io.inMask[f] : 0;
        carried |= m;
        c.view.setFingerLight(f, m ? lightColor(m) : null);
      }
      if (io && io.inMask[5]) carried |= io.inMask[5];
      const on = carried !== 0;
      if (on !== c.flowing) {
        c.flowing = on;
        this.audio.voice('flowTone', `cast-${c.id}`, this.notes[0] ?? 60, on, this.benchPos(c.view.root.position, this.v1));
      }
    }
    for (const l of this.live) {
      if (!l.coat || !l.optic) continue;
      const io = display.hands.find((h) => h.id === l.optic!.id);
      for (let f = 0; f < 5; f++) {
        const m = io ? io.outMask[f] | io.inMask[f] : 0;
        l.coat.setFingerLight(f, m ? lightColor(m) : null);
      }
    }

    if (this.castsResult!.solved && !this.solved && this.casts.length <= this.level.budget) this.onSolved();
  }

  private onSolved(): void {
    this.solved = true;
    this.bench!.pulseSolved();
    this.boost = 1;
    const center = this.benchRoot.getWorldPosition(this.v2);
    const sorted = [...this.notes].sort((a, b) => a - b);
    this.audio.resolve(sorted, this.source.bass(this.level, this.levelIndex), center, 0.25);
    if (this.levelIndex >= 0 && !this.progress.solved.includes(this.level.id)) this.progress.solved.push(this.level.id);
    if (this.levelIndex === -1) this.recordDaily();
    saveProgress(this.progress);
    this.hud.setSolved(true, this.hasNext());
    this.setStatus(this.solvedLine());
    // Reveal: the maker's glass hands fade in beside yours.
    window.setTimeout(() => this.reveal(), 1400);
  }

  private solvedLine(): string {
    const n = this.casts.length;
    const par = this.level.solution?.length ?? n;
    if (n < par) return 'Solved with fewer hands than the maker!';
    return n === 1 ? 'Your hand sings. Tap Next when ready.' : `${n} glass hands sing together.`;
  }

  private reveal(): void {
    if (!this.solved || !this.level.solution) return;
    for (const cd of this.level.solution) {
      const pose = castToPose(cd);
      // Skip the maker's hand if the player's glass already sits there.
      const f = footOf(pose);
      if (this.casts.some((c) => Math.hypot(footOf(c.pose)[0] - f[0], footOf(c.pose)[1] - f[1]) < 0.04)) continue;
      this.addCast(pose, 'ghost');
    }
  }

  private recordDaily(): void {
    const d = new Date();
    const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const y = new Date(d);
    y.setDate(d.getDate() - 1);
    const yKey = y.getFullYear() * 10000 + (y.getMonth() + 1) * 100 + y.getDate();
    if (this.progress.lastDaily === key) return;
    this.progress.dailyStreak = this.progress.lastDaily === yKey ? this.progress.dailyStreak + 1 : 1;
    this.progress.lastDaily = key;
  }

  private showHint(): void {
    if (this.solved || !this.level.solution) return;
    const placed = this.casts.length;
    const cd = this.level.solution[Math.min(placed, this.level.solution.length - 1)];
    const ghost = this.addCast(castToPose(cd), 'ghost');
    if (ghost) {
      this.hintUntil = this.time + 6;
      (ghost as Cast & { hint?: boolean }).hint = true;
    }
    this.setStatus('Hint: copy the ghost hand. Hold it still in the light.');
  }

  // ------------------------------------------------------------------ hands

  private updateHands(dt: number): void {
    const xr = this.world.renderer.xr;
    if (!xr.isPresenting) {
      for (const l of this.live) l.optic = null;
      return;
    }
    this.player.updateWorldMatrix(true, false);
    this.benchRoot.updateWorldMatrix(true, false);
    this.worldToBench.copy(this.benchRoot.matrixWorld).invert();
    if (this.calibrating) this.worldToBench.identity();
    this.tracker.update(xr.getFrame(), xr.getReferenceSpace(), this.player.matrixWorld.elements, this.worldToBench.elements, dt);
    if (this.calibrating) {
      this.updateCalibration(dt);
      return;
    }
    if (!this.bench) return;
    const hw = this.level.bench.w / 2 + BENCH_MARGIN;
    const hd = this.level.bench.d / 2 + BENCH_MARGIN;

    for (const l of this.live) {
      const h = l.hand;
      this.ensureCoat(l);
      if (!h.tracked) {
        l.optic = null;
        l.grab = null;
        this.setCasting(l, 0);
        continue;
      }
      const pc = h.palm.center;
      const near = Math.abs(pc[0]) < hw && Math.abs(pc[2]) < hd && pc[1] < SLAB_HEIGHT && pc[1] > -0.05;

      this.updateGrab(l);
      this.updateKnock(l);
      this.updatePluck(l, dt);

      if (l.lockFoot && (!near || Math.hypot(pc[0] - l.lockFoot[0], pc[2] - l.lockFoot[1]) > WITHDRAW)) l.lockFoot = null;
      const active = near && !l.grab && this.mode !== 'demo';
      l.optic = active ? computeOptic(h.toPose(), { id: `live-${h.hand}`, live: true, state: l.feat }) : null;
      if (!active || l.lockFoot) {
        this.setCasting(l, Math.max(0, l.progress - dt * 3));
        continue;
      }
      // Armed: the hand is doing something with light.
      const armed = this.isLit(l.optic!);
      const rise = 1 / (this.progress.steady ? 1.2 : 0.7);
      let p = l.progress;
      if (armed && h.stillness.still && this.castsLeft() > 0) p += dt * rise;
      else p -= dt * rise * 2;
      this.setCasting(l, Math.max(0, Math.min(1, p)));
      if (armed && h.stillness.still && this.castsLeft() <= 0 && h.stillness.progress > 0.9 && !this.solved) {
        this.setStatus('No glass left. Knock a glass hand with your fist to reuse it.');
      }
      if (l.progress >= 1) this.commitCast(l);
    }
  }

  private isLit(o: HandOptic): boolean {
    const d = this.display;
    if (!d) return false;
    const io = d.hands.find((h) => h.id === o.id);
    if (o.mode === 'fan') return !!io && io.inMask.some((m) => m !== 0);
    // Mirrors and fists: armed when a beam touches them.
    const [cx, cz] = o.center;
    for (const s of d.segments) {
      if (Math.hypot(s.b[0] - cx, s.b[1] - cz) < 0.06 || Math.hypot(s.a[0] - cx, s.a[1] - cz) < 0.06) return true;
    }
    return false;
  }

  private setCasting(l: Live, p: number): void {
    const was = l.progress;
    l.progress = p;
    if (l.coat) {
      if (p > 0.001) {
        l.coat.setVisible(true);
        l.coat.setMolten(p, 0.55 + 0.45 * p);
      } else if (l.optic && this.isLit(l.optic)) {
        l.coat.setVisible(true); // a lit hand wears a clear glass glove
        l.coat.setMolten(1, 0);
      } else {
        l.coat.setVisible(false);
      }
    }
    const id = `molten-${l.hand.hand}`;
    if (p > 0.05 && !l.sizzle) {
      l.sizzle = true;
      this.audio.voice('moltenStart', id, this.palmWorld(l, this.v1));
    } else if (p <= 0.02 && l.sizzle) {
      l.sizzle = false;
      this.audio.voice('moltenStop', id);
    }
    if (l.sizzle && Math.abs(p - was) > 0.02) this.audio.voice('moltenHeat', id, p);
  }

  private commitCast(l: Live): void {
    const pose = l.hand.snapshot(8);
    const cast = this.addCast({ hand: pose.hand, pos: pose.pos, rot: pose.rot, radii: pose.radii });
    l.lockFoot = footOf(pose);
    l.hand.stillness.reset();
    l.progress = 0;
    this.setCasting(l, 0);
    if (!cast) return;
    const at = this.palmWorld(l, this.v1);
    this.audio.voice('ting', 0.5, at);
    this.audio.voice('crackle', at);
    if (this.casts.length === 1 && !this.solved) this.setStatus('Slide your hand out. The glass stays.');
  }

  private updateGrab(l: Live): void {
    const h = l.hand;
    const pin = h.pinch;
    if (!l.grab && pin.started && l.progress < 0.25) {
      let best: Cast | null = null;
      let bestD: number = GESTURE.grabRadius;
      for (const c of this.casts) {
        const f = footOf(c.pose);
        const d = Math.hypot(pin.point[0] - f[0], pin.point[2] - f[1]);
        if (d < bestD && pin.point[1] < 0.07 && pinchGrabs(true, pin.point, f, 0)) {
          bestD = d;
          best = c;
        }
      }
      if (best) {
        const f = footOf(best.pose);
        l.grab = {
          cast: best,
          startQuat: Float32Array.from(h.rotBench.subarray(0, 4)),
          startYaw: best.yaw,
          twist: 0,
          grip: [f[0] - pin.point[0], f[1] - pin.point[2]],
        };
        best.view.setSelected(true);
        this.audio.tick('pick', this.benchPos(best.view.root.position, this.v1));
      }
    }
    const g = l.grab;
    if (!g) return;
    if (pin.active) {
      const t = unwrapAngle(g.twist, twistAngle(g.startQuat, h.rotBench.subarray(0, 4), [0, 1, 0]));
      g.twist = t;
      const detent = 3 * (Math.PI / 180);
      const yaw = g.startYaw + Math.round(t / detent) * detent;
      const fx = pin.point[0] + g.grip[0];
      const fz = pin.point[2] + g.grip[1];
      this.moveCast(g.cast, yaw, [fx - g.cast.baseFoot[0], fz - g.cast.baseFoot[1]]);
    }
    if (pin.ended || !pin.active) {
      const c = g.cast;
      c.view.setSelected(false);
      l.grab = null;
      const f = footOf(c.pose);
      const off = Math.abs(f[0]) > this.level.bench.w / 2 + 0.03 || Math.abs(f[1]) > this.level.bench.d / 2 + 0.03;
      if (off) this.shatterCast(c);
      else this.audio.tick('place', this.benchPos(c.view.root.position, this.v1));
    }
  }

  private updateKnock(l: Live): void {
    const h = l.hand;
    if (this.time - l.lastKnock < 0.6 || !isKnock(h.posBench, h.speed.knuckle)) return;
    const k = h.posBench; // middle knuckle = joint 11
    const kx = k[33], ky = k[34], kz = k[35];
    for (const c of this.casts) {
      const f = footOf(c.pose);
      const py = (c.pose.pos[1] + c.pose.pos[34]) / 2;
      if (Math.hypot(kx - f[0], kz - f[1]) < 0.075 && Math.abs(ky - py) < 0.07) {
        l.lastKnock = this.time;
        this.shatterCast(c);
        return;
      }
    }
  }

  private updatePluck(l: Live, dt: number): void {
    const tip = l.hand.posBench.subarray(27, 30); // index tip
    if (l.hadTip && dt > 0) {
      for (const c of this.casts) {
        const p = c.pose.pos;
        for (let f = 0; f < 5; f++) {
          if (!c.optic.ports[f].open) continue;
          const kj = [2, 6, 11, 16, 21][f];
          const tj = [4, 9, 14, 19, 24][f];
          const sp = pluckCrossing(l.prevTip, 0, tip, 0, p, kj * 3, p, tj * 3, 0.009, dt);
          if (sp >= GESTURE.pluckSpeed) {
            this.audio.voice('pluck', PLUCK_NOTES[f] + (c.pose.hand === 'left' ? -12 : 0), this.benchPos(this.v1.set(p[tj * 3], p[tj * 3 + 1], p[tj * 3 + 2]), this.v1), 0, Math.min(1, sp));
          }
        }
      }
    }
    l.prevTip.set(tip);
    l.hadTip = l.hand.tracked;
  }

  private ensureCoat(l: Live): void {
    const adapter = (this.input as unknown as { xr?: { visualAdapters?: { hand?: Record<string, { visual?: { model?: Object3D } }> } } }).xr
      ?.visualAdapters?.hand?.[l.hand.hand];
    const model = adapter?.visual?.model;
    const mesh = model?.getObjectByProperty('type', 'SkinnedMesh') as SkinnedMesh | undefined;
    if (!mesh || mesh === l.coatFor) return;
    l.coat?.dispose();
    l.coat = createCoatMesh(mesh);
    l.coatFor = mesh;
  }

  private palmWorld(l: Live, out: Vector3): Vector3 {
    const c = l.hand.palm.center;
    return this.benchPos(out.set(c[0], c[1], c[2]), out);
  }

  /** Bench-local point -> world (for HRTF panning). */
  private benchPos(local: Vector3, out: Vector3): Vector3 {
    out.copy(local);
    return this.benchRoot.localToWorld(out);
  }

  // ------------------------------------------------------------------ table placement

  private enterXR(): void {
    this.mode = this.mode === 'demo' ? 'play' : this.mode;
    if (this.placed) return;
    this.pendingPlace = true;
    void this.table.restore(this.world.session).then((found) => {
      if (!found && !this.progress.calibrated) this.startCalibration();
    });
  }

  private exitXR(): void {
    this.placed = false;
    this.calibrating = false;
    this.table.reset();
    this.layoutDesktop();
  }

  private startCalibration(): void {
    if (!this.world.renderer.xr.isPresenting) return;
    this.calibrating = true;
    this.calibHold = 0;
    this.benchRoot.visible = false;
    this.hud.show('play');
    this.hud.setBoard('SET UP', 'Find your table', 'Rest one hand flat on your table and hold still.');
  }

  private updateCalibration(dt: number): void {
    for (const h of this.tracker.hands) {
      if (!h.tracked) continue;
      const flat = h.palm.normal[1] < -0.8;
      let straight = 0;
      for (const f of [1, 2, 3, 4]) {
        const k = [6, 11, 16, 21][f - 1];
        const t = [9, 14, 19, 24][f - 1];
        const p = h.posBench;
        const d = Math.hypot(p[t * 3] - p[k * 3], p[t * 3 + 1] - p[k * 3 + 1], p[t * 3 + 2] - p[k * 3 + 2]);
        if (d > 0.06) straight++;
      }
      if (!(flat && straight >= 3 && h.stillness.still)) continue;
      this.calibHold += dt;
      if (this.calibHold < 0.8) return;
      // posBench is world space while calibrating.
      const p = h.posBench;
      let y = 0;
      for (const t of [9, 14, 19, 24]) y += p[t * 3 + 1] - h.radii[t];
      y /= 4;
      this.readHead();
      const c = h.palm.center;
      const dx = c[0] - this.headPos.x;
      const dz = c[2] - this.headPos.z;
      const yaw = Math.atan2(-dx, -dz);
      // Put the hand a little toward the player's side of the bench centre.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      this.benchRoot.position.set(c[0] + fx * 0.02, y - 0.002, c[2] + fz * 0.02);
      this.benchRoot.rotation.set(0, yaw, 0);
      this.finishPlacement();
      return;
    }
    this.calibHold = Math.max(0, this.calibHold - dt);
  }

  private finishPlacement(): void {
    this.calibrating = false;
    this.placed = true;
    this.pendingPlace = false;
    this.benchRoot.visible = true;
    this.progress.calibrated = true;
    saveProgress(this.progress);
    this.benchRoot.updateWorldMatrix(true, false);
    this.table.reset();
    this.table.requestAt(this.benchRoot.getWorldPosition(this.v1), this.benchRoot.getWorldQuaternion(this.q1));
    this.ambience.setBenchCenter(this.benchRoot.getWorldPosition(this.v1));
    this.audio.tick('place');
    const info = this.source.describe(this.level, this.levelIndex);
    this.hud.setBoard(info.eyebrow, this.level.name, this.level.hint ?? this.defaultHint());
  }

  /** Head-relative fallback placement (no calibration). */
  placeInFront(tableY?: number): void {
    this.readHead();
    const f = this.v1.copy(this.headFwd).setY(0);
    if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
    f.normalize();
    this.benchRoot.position.copy(this.headPos).addScaledVector(f, 0.42);
    this.benchRoot.position.y = tableY ?? Math.max(0.45, this.headPos.y - 0.45);
    this.benchRoot.rotation.set(0, Math.atan2(-f.x, -f.z), 0);
    this.finishPlacement();
  }

  private layoutDesktop(): void {
    this.benchRoot.position.set(0, 0.8, -0.36);
    this.benchRoot.rotation.set(0, 0, 0);
    this.benchRoot.visible = true;
    const cam = this.world.camera;
    cam.position.set(0, 1.24, 0.06);
    cam.lookAt(0, 0.8, -0.38);
    this.ambience.setBenchCenter(this.benchRoot.getWorldPosition(this.v1));
    this.mode = 'demo';
    this.demoT = 0;
    this.demoStep = 0;
  }

  private readHead(): void {
    const head = this.player.head;
    head.updateWorldMatrix(true, false);
    this.headPos.setFromMatrixPosition(head.matrixWorld);
    this.q1.setFromRotationMatrix(head.matrixWorld);
    this.headFwd.set(0, 0, -1).applyQuaternion(this.q1);
    this.headUp.set(0, 1, 0).applyQuaternion(this.q1);
  }

  private layoutHud(): void {
    const hud = this.hud.object;
    const xr = this.world.renderer.xr.isPresenting;
    if (this.calibrating) {
      this.readHead();
      this.v1.copy(this.headPos).addScaledVector(this.headFwd, 0.6);
      this.v1.y -= 0.12;
    } else {
      const d = this.level ? this.level.bench.d : 0.3;
      const raise = xr ? (this.hud.section === 'play' ? 0.2 : 0.26) : this.hud.section === 'play' ? 0.13 : 0.24;
      this.v1.set(0, raise, -(d / 2 + 0.1));
      this.benchRoot.localToWorld(this.v1);
    }
    const parent = hud.parent;
    if (parent) parent.worldToLocal(this.v1);
    hud.position.copy(this.v1);
    hud.lookAt(this.headPos);
  }

  private anchorTick(): void {
    if (!this.world.renderer.xr.isPresenting || this.calibrating) return;
    const xr = this.world.renderer.xr;
    if (this.table.update(xr.getFrame(), xr.getReferenceSpace(), this.player.matrixWorld, this.v1, this.q1)) {
      if (this.pendingPlace || !this.placed) {
        this.readHead();
        if (this.v1.distanceTo(this.headPos) < 1.6) {
          this.benchRoot.position.copy(this.v1);
          this.v2.set(0, 0, -1).applyQuaternion(this.q1).setY(0);
          this.benchRoot.rotation.set(0, Math.atan2(-this.v2.x, -this.v2.z), 0);
          this.placed = true;
          this.pendingPlace = false;
          this.benchRoot.visible = true;
          this.ambience.setBenchCenter(this.benchRoot.getWorldPosition(this.v2));
        }
      }
    }
    if (this.pendingPlace && this.time > 0 && this.progress.calibrated && !this.calibrating) {
      // Calibrated before but no anchor came back within a moment: place in front.
      this.pendingTimer += 1;
      if (this.pendingTimer > 90) this.placeInFront();
    }
  }
  private pendingTimer = 0;

  // ------------------------------------------------------------------ demo (desktop attract mode)

  private updateDemo(dt: number): void {
    if (this.mode !== 'demo' || !this.level || !this.templates || !this.bench) return;
    this.demoT += dt;
    const sol = this.level.solution ?? [];
    if (this.demoStep < sol.length) {
      if (this.demoT > 1.2 + this.demoStep * 2.2) {
        const c = this.addCast(castToPose(sol[this.demoStep]), 'glass', false);
        if (c) {
          c.cooling = 1;
          (c as Cast & { form?: number }).form = 0;
        }
        this.demoStep++;
      }
    } else if (this.demoT > 1.2 + sol.length * 2.2 + 4.5) {
      this.demoStep = 0;
      this.demoT = 0;
      const levels = this.source.levels();
      this.loadIndex((this.levelIndex + 1) % Math.min(levels.length, 8));
      this.mode = 'demo';
    }
    // Demo casts "pour" from wrist to fingertips.
    for (const c of this.casts) {
      const k = c as Cast & { form?: number };
      if (k.form === undefined) continue;
      k.form = Math.min(1, k.form + dt / 1.1);
      c.view.setMolten(k.form, 1);
      if (k.form >= 1) {
        k.form = undefined;
        c.cooling = 1;
        this.audio.voice('ting', 0.5, this.benchPos(c.view.root.position, this.v1));
      }
    }
  }

  // ------------------------------------------------------------------ frame

  update(delta: number, time: number): void {
    let dt = Math.min(delta, 0.05);
    const vc = (window as unknown as { __hcClock?: { time: number; dt: number } }).__hcClock;
    if (vc) {
      dt = vc.dt;
      vc.dt = 0;
      time = vc.time;
    }
    this.time = time;
    const xr = this.world.renderer.xr.isPresenting;
    if (xr) {
      this.readHead();
    } else {
      this.world.camera.getWorldPosition(this.headPos);
      this.world.camera.getWorldDirection(this.headFwd);
      this.headUp.set(0, 1, 0);
    }
    this.audio.setListener(this.headPos, this.headFwd, this.headUp);
    this.anchorTick();
    this.updateHands(dt);
    this.updateDemo(dt);
    if (this.level && this.bench) this.retrace();
    if (xr) this.updateGaze(dt);

    // Cooling glass, ghosts fading, hint timeout.
    for (const c of this.casts) {
      const k = c as Cast & { form?: number };
      if (c.cooling > 0 && k.form === undefined) {
        c.cooling = Math.max(0, c.cooling - dt / 1.4);
        c.view.setMolten(1, c.cooling);
      }
      c.view.update(dt, time);
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i] as Cast & { hint?: boolean; fade?: number };
      g.fade = Math.min(1, (g.fade ?? 0) + dt / 1.2);
      const pulse = g.hint ? 0.55 + 0.35 * Math.sin(time * 4) : 0.45;
      g.view.setOpacity(g.fade * pulse);
      g.view.update(dt, time);
      if (g.hint && time > this.hintUntil) {
        g.view.dispose();
        this.ghosts.splice(i, 1);
      }
    }
    for (let i = this.shatters.length - 1; i >= 0; i--) {
      if (!this.shatters[i].update(dt)) {
        this.shatters[i].dispose();
        this.shatters.splice(i, 1);
      }
    }
    for (const l of this.live) l.coat?.update(time);
    this.boost = Math.max(0, this.boost - dt * 0.6);
    this.beams?.setBoost(this.boost);
    this.beams?.update(dt, time);
    this.bench?.update(dt, time);
    this.ambience.setDim(xr ? 0.35 : 0);
    this.ambience.update(dt, time);
    this.layoutHud();
  }

  private updateGaze(dt: number): void {
    if (!this.bench || this.calibrating) return;
    let best = -1;
    let bestCos = Math.cos((6 * Math.PI) / 180);
    for (let i = 0; i < this.level.crystals.length; i++) {
      this.benchPos(this.bench.worldOf('crystal', i, this.v1), this.v1);
      this.v1.sub(this.headPos);
      const dist = this.v1.length();
      if (dist > 2) continue;
      const c = this.v1.dot(this.headFwd) / dist;
      if (c > bestCos) {
        bestCos = c;
        best = i;
      }
    }
    if (best !== this.gazed) {
      if (this.gazed >= 0) this.bench.highlightCrystal(this.gazed, false);
      this.gazed = best;
      this.gazeTime = 0;
      if (best >= 0) this.bench.highlightCrystal(best, true);
      return;
    }
    if (best < 0) return;
    this.gazeTime += dt;
    if (this.gazeTime > 0.5 && !this.gazeSung.has(best)) {
      this.gazeSung.add(best);
      const pos = this.benchPos(this.bench.worldOf('crystal', best, this.v1), this.v1);
      this.audio.bell(this.notes[best], pos, 0.35, 1.6);
      if (!this.solved) this.setStatus(`This crystal wants ${colourWords(this.level.crystals[best].color)} light.`);
    }
  }

  // ------------------------------------------------------------------ debug / test hooks

  private exposeDebug(): void {
    const api = {
      state: () => ({
        level: this.level?.id,
        index: this.levelIndex,
        mode: this.mode,
        solved: this.solved,
        casts: this.casts.length,
        budget: this.level?.budget,
        status: this.hud.status,
        calibrating: this.calibrating,
        placed: this.placed,
        crystals: this.display?.crystals.map((c) => c.state),
        hush: this.display?.hush.map((h) => h.awake),
        live: this.live.map((l) => ({
          hand: l.hand.hand,
          tracked: l.hand.tracked,
          mode: l.optic?.mode ?? null,
          open: l.optic?.ports.slice(0, 5).map((p) => p.open),
          progress: l.progress,
          grab: !!l.grab,
          still: l.hand.stillness.still,
        })),
      }),
      levels: () => this.source.levels().map((l) => l.id),
      load: (i: number) => {
        this.mode = this.world.renderer.xr.isPresenting ? 'play' : 'demo';
        this.loadIndex(i);
      },
      play: () => {
        this.mode = 'play';
        this.loadLevel(this.level);
      },
      level: () => this.level,
      solution: () => this.level?.solution,
      cast: (name: PoseName, hand: 'left' | 'right', at: V2, yaw = FWD) => !!this.addCast(canonicalPose(name, hand, at, yaw)),
      castSolution: () => {
        for (const cd of this.level.solution ?? []) this.addCast(castToPose(cd));
      },
      clearCasts: () => {
        for (const c of [...this.casts]) this.shatterCast(c);
      },
      placeInFront: (y?: number) => this.placeInFront(y),
      calibrate: () => this.startCalibration(),
      benchWorld: () => this.benchRoot.matrixWorld.toArray(),
      benchToWorld: (p: [number, number, number]) => this.benchRoot.localToWorld(new Vector3(...p)).toArray(),
      footWorld: (i: number) => {
        const c = this.casts[i];
        if (!c) return null;
        const f = footOf(c.pose);
        return this.benchRoot.localToWorld(new Vector3(f[0], 0.01, f[1])).toArray();
      },
      castPose: (i: number) => (this.casts[i] ? poseToCast(this.casts[i].pose) : null),
      enterXR: (scale?: number) => {
        if (scale) this.world.renderer.xr.setFramebufferScaleFactor(scale);
        this.world.launchXR();
      },
      xrActive: () => this.world.renderer.xr.isPresenting,
      /**
       * Emulator only: shape an IWER hand into a pose-library pose at a bench
       * position (or hide it with name = null). Drives the real tracking path.
       */
      iwerHand: (hand: 'left' | 'right', name: PoseName | null, at: V2 = [0, 0.05], yaw = FWD, overrides?: Partial<PoseShape>) => {
        const dev = (window as unknown as { IWER_DEVICE?: { controlMode: string; primaryInputMode: string; hands: Record<string, { position: { set(x: number, y: number, z: number): void } }> } }).IWER_DEVICE;
        if (!dev) return false;
        dev.controlMode = 'programmatic';
        dev.primaryInputMode = 'hand';
        if (!name) {
          dev.hands[hand].position.set(hand === 'left' ? -0.4 : 0.4, 0.4, 0.3);
          return true;
        }
        this.benchRoot.updateWorldMatrix(true, false);
        const bp = new Vector3();
        const bq = new Quaternion();
        this.benchRoot.matrixWorld.decompose(bp, bq, new Vector3());
        const pose = canonicalPose(name, hand, at, yaw, overrides);
        const w = benchToWorld(pose, [bp.x, bp.y, bp.z], [bq.x, bq.y, bq.z, bq.w]);
        const cfg = iwerPoseFromWorld(w.pos, w.rot, pose.radii ?? [], [0, 0, 0], [0, 0, 0, 1], hand);
        const register = new Function(`return ${IWER_REGISTER_POSE_JS}`)() as (a: unknown) => boolean;
        return register({ hand, poseId: `hc-${hand}`, pose: cfg, position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
      },
      /** Emulator only: IWER's own pinch pose with its pinch point at a bench position. */
      iwerPinchAt: (hand: 'left' | 'right', at: [number, number, number], value = 1, yawDeg = 0) => {
        const dev = (window as unknown as { IWER_DEVICE?: { hands: Record<string, { poseId: string; position: { set(x: number, y: number, z: number): void }; quaternion: { set(x: number, y: number, z: number, w: number): void }; setPinchValueImmediate(v: number): void }> } }).IWER_DEVICE;
        if (!dev) return false;
        const h = dev.hands[hand];
        h.poseId = 'default';
        const w = this.benchRoot.localToWorld(new Vector3(...at));
        const yaw = (yawDeg * Math.PI) / 180;
        const off = [hand === 'right' ? 0.0005 : -0.0005, -0.025, -0.012];
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const ox = off[0] * c + off[2] * s;
        const oz = -off[0] * s + off[2] * c;
        h.position.set(w.x - ox, w.y - off[1], w.z - oz);
        h.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
        h.setPinchValueImmediate(value);
        return true;
      },
      setHead: (pos: [number, number, number], pitchDeg = 0, yawDeg = 0) => {
        const dev = (window as unknown as { IWER_DEVICE?: { controlMode: string; position: { set(x: number, y: number, z: number): void }; quaternion: { set(x: number, y: number, z: number, w: number): void } } }).IWER_DEVICE;
        if (!dev) return false;
        dev.controlMode = 'programmatic';
        dev.position.set(...pos);
        const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (pitchDeg * Math.PI) / 180);
        const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (yawDeg * Math.PI) / 180);
        const q = qy.multiply(qx);
        dev.quaternion.set(q.x, q.y, q.z, q.w);
        return true;
      },
      hud: () => this.hud.object.getWorldPosition(new Vector3()).toArray(),
      uiWorld: (id: string) => (this.hud.object.getElementById(id) as unknown as Object3D).getWorldPosition(new Vector3()).toArray(),
      menu: (open: boolean) => (open ? this.openMenu() : this.hud.show('play')),
      audioLogStart: () => {
        this.audio.log = [];
      },
      audioRender: async (t0: number, seconds: number) => {
        const buf = await AudioEngine.renderOffline(this.audio.log ?? [], seconds, t0);
        const bytes = new Uint8Array(encodeWav(buf));
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(bin);
      },
    };
    (window as unknown as { handcast: typeof api }).handcast = api;
  }
}

function colourWords(mask: number): string {
  const names: Record<number, string> = {
    1: 'red',
    2: 'green',
    4: 'blue',
    3: 'yellow (red + green)',
    5: 'magenta (red + blue)',
    6: 'cyan (green + blue)',
    7: 'white',
  };
  return names[mask] ?? 'no';
}
