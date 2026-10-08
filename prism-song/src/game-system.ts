/**
 * GameSystem: owns the puzzle state and wires it to visuals, sound, hands,
 * pointers, gaze and the HUD.
 *
 * Interaction model (all hands-first; controllers and mouse also work):
 * - Pinch a piece to pick it up, move it over the board, release to place.
 *   Twisting the wrist while pinching turns mirrors. Beams update live while
 *   a piece is held, so the board behaves like an instrument.
 * - Poke or ray-tap: tap a tray piece then a cell to place it; tap a mirror to
 *   turn it one step; long-press a placed piece to pick it up for moving.
 * - Look at a crystal (eye tracking, or head direction) to hear its note and
 *   see which colour it is waiting for.
 */

import {
  Color as ThreeColor,
  Entity,
  Group,
  Matrix4,
  Object3D,
  Quaternion,
  RayInteractable,
  Vector3,
  VisibilityState,
  createSystem,
} from '@iwsdk/core';
import { AudioEngine } from './audio/engine.js';
import { renderAscii } from './game/ascii.js';
import { CAMPAIGN, MOVEMENTS, dailyLevel } from './game/levels.js';
import { chordBass, chordTones, MOVEMENT_MUSIC, targetNotes } from './game/music.js';
import { loadProgress, recordDaily, saveProgress } from './game/progress.js';
import { daySeed } from './game/rng.js';
import {
  PuzzleState,
  TargetState,
  TraceResult,
  applySolution,
  createPuzzle,
  pieceAt,
  trace,
} from './game/trace.js';
import { Color, LevelDef, Piece, colorName, isRotatable, mod8 } from './game/types.js';
import { HandState, HandTracker, twistAngle } from './input/hands.js';
import { BeamRenderer } from './render/beams.js';
import { BoardView } from './render/board.js';
import { lightColor } from './render/palette.js';
import { PieceView } from './render/pieces.js';
import { Hud } from './ui/hud.js';

const FLAT_LEVELS: { level: LevelDef; movement: number; index: number }[] = CAMPAIGN.flatMap(
  (levels, movement) => levels.map((level, index) => ({ level, movement, index })),
);

const GRAB_RADIUS = 0.045;
const HANDLE_RADIUS = 0.055;
const TWIST_GAIN = 1.5;
const TAP_SUPPRESS = 0.35;
const LONG_PRESS_MS = 450;

interface PieceGrab {
  kind: 'piece';
  id: number;
  startWrist: Quaternion;
  startRot: number;
  offset: Vector3;
  wasOnBoard: boolean;
  homeX: number;
  homeY: number;
  moved: boolean;
}

interface BoardGrab {
  kind: 'board';
  offset: Vector3;
}

type Grab = PieceGrab | BoardGrab;

interface PendingTap {
  id: number;
  at: number;
  long: boolean;
}

function cssColor(mask: number): string {
  return `#${lightColor(mask).getHexString()}`;
}

function needDescription(mask: number): string {
  const parts = [Color.R, Color.G, Color.B].filter((b) => mask & b).map(colorName);
  return parts.length > 1 ? `${colorName(mask)} (${parts.join(' + ')})` : colorName(mask);
}

export class GameSystem extends createSystem({}) {
  private audio = new AudioEngine();
  private hands = new HandTracker();
  private progress = loadProgress();
  private hud!: Hud;

  private boardRoot!: Group;
  private boardRootEntity!: Entity;
  private board: BoardView | null = null;
  private boardEntity: Entity | null = null;
  private beams: BeamRenderer | null = null;
  private entities: Entity[] = [];
  private views = new Map<number, PieceView>();

  private level!: LevelDef;
  private levelIndex = 0; // index into FLAT_LEVELS, or -1 for the daily puzzle
  private state!: PuzzleState;
  private result: TraceResult | null = null;
  private notes = new Map<number, number>();
  private solved = false;
  private menuOpen = false;
  private firstMove = true;

  private grabs: { left: Grab | null; right: Grab | null } = { left: null, right: null };
  private hover: { left: number | null; right: number | null } = { left: null, right: null };
  private selected: number | null = null;
  private pendingTap: PendingTap | null = null;
  private pressStart = new Map<number, number>();
  private lastGrabActivity = -10;
  private time = 0;

  private gazed: number | null = null;
  private gazeSince = 0;
  private gazeSung = new Set<number>();

  private hint: { view: PieceView; until: number } | null = null;
  private placedInXR = false;
  private boost = 0;

  // Scratch objects (no per-frame allocation).
  private v1 = new Vector3();
  private v2 = new Vector3();
  private v3 = new Vector3();
  private up = new Vector3(0, 1, 0);
  private headPos = new Vector3();
  private headFwd = new Vector3();
  private headUp = new Vector3();
  private originMatrix = new Matrix4();
  private q1 = new Quaternion();

  init(): void {
    this.boardRoot = new Group();
    this.boardRoot.name = 'board-root';
    this.boardRootEntity = this.world.createTransformEntity(this.boardRoot, { persistent: true });
    this.audio.setMuted(this.progress.muted);

    this.hud = new Hud(this.world, {
      reset: () => this.withSound(() => this.resetLevel()),
      hint: () => this.withSound(() => this.showHint()),
      next: () => this.withSound(() => this.nextLevel()),
      openMenu: () => this.withSound(() => this.setMenu(true)),
      closeMenu: () => this.withSound(() => this.setMenu(false)),
      pick: (i) => this.withSound(() => this.loadIndex(i)),
      daily: () => this.withSound(() => this.loadDaily()),
      toggleSound: () => this.withSound(() => this.toggleSound()),
    });
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
          if (!this.placedInXR) this.pendingPlacement = true;
        } else {
          this.placedInXR = false;
          this.layoutDesktop();
        }
      }),
    );

    const start = this.startingIndex();
    this.loadIndex(start);
    this.layoutDesktop();
    this.exposeDebug();
  }

  private pendingPlacement = false;
  private backdrop = new ThreeColor(0x0b0e16);

  private withSound(fn: () => void): void {
    this.audio.unlock();
    this.audio.tick('ui');
    fn();
  }

  private startingIndex(): number {
    const cur = FLAT_LEVELS.findIndex((l) => l.level.id === this.progress.current);
    if (cur >= 0) return cur;
    const firstUnsolved = FLAT_LEVELS.findIndex((l) => !this.progress.solved.includes(l.level.id));
    return firstUnsolved >= 0 ? firstUnsolved : 0;
  }

  // ---------------------------------------------------------------- levels

  private loadIndex(i: number): void {
    const entry = FLAT_LEVELS[Math.max(0, Math.min(FLAT_LEVELS.length - 1, i))];
    this.levelIndex = FLAT_LEVELS.indexOf(entry);
    this.notes = targetNotes(entry.level, entry.movement, entry.index);
    this.loadLevel(entry.level, entry.movement);
  }

  private loadDaily(): void {
    const level = dailyLevel();
    this.levelIndex = -1;
    const seed = daySeed(new Date());
    this.notes = targetNotes(level, seed % 3, seed % 8);
    this.loadLevel(level, seed % 3);
  }

  private get movement(): number {
    return this.levelIndex >= 0 ? FLAT_LEVELS[this.levelIndex].movement : daySeed(new Date()) % 3;
  }

  private get indexInMovement(): number {
    return this.levelIndex >= 0 ? FLAT_LEVELS[this.levelIndex].index : daySeed(new Date()) % 8;
  }

  private loadLevel(level: LevelDef, movement: number): void {
    this.teardownLevel();
    this.level = level;
    this.state = createPuzzle(level);
    this.solved = false;
    this.selected = null;
    this.pendingTap = null;
    this.firstMove = true;
    this.gazeSung.clear();
    this.setMenu(false);

    const board = (this.board = new BoardView(level.size, level.tray.length));
    this.boardEntity = this.world.createTransformEntity(board.group, {
      parent: this.boardRootEntity,
      persistent: true,
    });
    this.entities.push(this.boardEntity);
    this.beams = new BeamRenderer(board.cell, level.size, board.cell * 0.3);
    board.group.add(this.beams.group);

    const surface = this.world.createTransformEntity(board.surface, {
      parent: this.boardEntity,
      persistent: true,
    });
    surface.addComponent(RayInteractable);
    this.entities.push(surface);
    board.surface.addEventListener('click', (e) => this.onSurfaceClick(e.point));
    board.surface.addEventListener('pointermove', (e) => this.onSurfaceMove(e.point));
    board.surface.addEventListener('pointerleave', () => this.selected === null || board.setCursor(null));

    const tray = this.world.createTransformEntity(board.traySurface, {
      parent: this.boardEntity,
      persistent: true,
    });
    tray.addComponent(RayInteractable);
    this.entities.push(tray);
    board.traySurface.addEventListener('click', () => this.onTrayClick());

    for (const piece of this.state.pieces) {
      const view = new PieceView(piece, board.cell);
      this.views.set(piece.id, view);
      const entity = this.world.createTransformEntity(view.root, {
        parent: this.boardEntity,
        persistent: true,
      });
      this.entities.push(entity);
      entity.addComponent(RayInteractable);
      view.root.addEventListener('pointerdown', (e) => {
        this.pressStart.set(e.pointerId, performance.now());
      });
      view.root.addEventListener('click', (e) => {
        const t0 = this.pressStart.get(e.pointerId) ?? performance.now();
        const long = performance.now() - t0 > LONG_PRESS_MS;
        this.onPieceTap(piece.id, long, e.pointerType);
      });
      view.root.addEventListener('pointerenter', () => view.setHighlight(this.canInteract(piece) ? 1 : 0.35));
      view.root.addEventListener('pointerleave', () => view.setHighlight(0));
    }
    this.layoutPieces(true);
    this.retrace(true);

    const mv = MOVEMENTS[movement];
    const eyebrow =
      this.levelIndex >= 0
        ? `${mv.title.toUpperCase()} - ${this.indexInMovement + 1} / 8`
        : `DAILY CHORD - ${new Date().toDateString().toUpperCase()}`;
    this.hud.setLevel(eyebrow, level.name, level.hint ?? this.defaultStatus());
    this.hud.setSolved(false, this.hasNext());
    this.audio.setAmbient(MOVEMENT_MUSIC[movement].root);

    if (this.levelIndex >= 0) {
      this.progress.current = level.id;
      saveProgress(this.progress);
    }
  }

  private defaultStatus(): string {
    const n = this.state.pieces.filter((p) => p.kind === 'target').length;
    return n === 1 ? 'Guide the light into the crystal.' : `Make all ${n} crystals sing.`;
  }

  private teardownLevel(): void {
    this.audio.stopAllSustains();
    this.clearHint();
    for (const e of this.entities.reverse()) e.dispose();
    this.entities = [];
    for (const v of this.views.values()) v.dispose();
    this.views.clear();
    this.beams?.dispose();
    this.board?.dispose();
    this.board = null;
    this.beams = null;
    this.boardEntity = null;
    this.result = null;
    this.grabs.left = this.grabs.right = null;
  }

  private resetLevel(): void {
    if (this.levelIndex >= 0) this.loadIndex(this.levelIndex);
    else this.loadDaily();
  }

  private hasNext(): boolean {
    return this.levelIndex >= 0 && this.levelIndex < FLAT_LEVELS.length - 1;
  }

  private nextLevel(): void {
    if (this.hasNext()) this.loadIndex(this.levelIndex + 1);
  }

  private setMenu(open: boolean): void {
    this.menuOpen = open;
    this.hud.showMenu(open);
    if (!open) return;
    const today = daySeed(new Date());
    const dailyDone = this.progress.lastDaily === today;
    const streak = this.progress.dailyStreak;
    const label = dailyDone
      ? `Daily done - ${streak} day streak`
      : streak > 0
        ? `Daily Chord - streak ${streak}`
        : 'Daily Chord';
    this.hud.setMenuState(
      FLAT_LEVELS.map((l) => (this.progress.solved.includes(l.level.id) ? 'solved' : 'open')),
      this.levelIndex,
      label,
      !this.progress.muted,
    );
  }

  private toggleSound(): void {
    this.progress.muted = !this.progress.muted;
    this.audio.setMuted(this.progress.muted);
    saveProgress(this.progress);
    this.setMenu(true);
  }

  // ---------------------------------------------------------------- layout

  private layoutPieces(immediate = false): void {
    const board = this.board!;
    let slot = 0;
    for (const p of this.state.pieces) {
      const view = this.views.get(p.id)!;
      if (this.isHeld(p.id)) continue;
      if (p.onBoard) board.cellToLocal(p.x, p.y, view.home);
      else board.traySlot(slot++, view.home);
      view.setLift(this.selected === p.id ? 1 : 0);
      if (immediate) view.root.position.copy(view.home);
    }
    if (!this.state.pieces.some((p) => !p.onBoard)) slot = 0;
  }

  /** Browser (non-XR) presentation: fixed camera looking down at a table. */
  private layoutDesktop(): void {
    this.boardRoot.position.set(0, 0.9, -0.34);
    this.boardRoot.quaternion.identity();
    const cam = this.world.camera;
    cam.position.set(0, 1.46, 0.3);
    cam.lookAt(0, 0.93, -0.38);
  }

  /** Put the board on a comfortable seated "table" in front of the player. */
  private placeInFrontOfHead(): void {
    this.readHead();
    this.v1.copy(this.headFwd).setY(0);
    if (this.v1.lengthSq() < 1e-4) this.v1.set(0, 0, -1);
    this.v1.normalize();
    this.boardRoot.position.copy(this.headPos).addScaledVector(this.v1, 0.45);
    this.boardRoot.position.y = Math.max(0.45, this.headPos.y - 0.42);
    this.boardRoot.rotation.set(0, Math.atan2(-this.v1.x, -this.v1.z), 0);
    this.placedInXR = true;
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
    const board = this.board;
    if (!board) return;
    const hud = this.hud.object;
    const parent = hud.parent;
    const raise = this.world.renderer.xr.isPresenting ? 0.2 : 0.1;
    this.v1.set(0, raise, -(board.width / 2 + board.cell * 0.6 + 0.08));
    this.boardRoot.localToWorld(this.v1);
    if (parent) parent.worldToLocal(this.v1);
    hud.position.copy(this.v1);
    this.v2.copy(this.headPos);
    hud.lookAt(this.v2);
  }

  // ---------------------------------------------------------------- tracing

  private retrace(silent = false): void {
    const prev = this.result;
    this.result = trace(this.state);
    this.beams!.setSegments(this.result.segments);
    const meter: (string | null)[] = [];
    for (const p of this.state.pieces) {
      if (p.kind !== 'target') continue;
      const view = this.views.get(p.id)!;
      const st = this.result.targetState.get(p.id) ?? 'off';
      const was: TargetState = prev?.targetState.get(p.id) ?? 'off';
      view.setTargetState(st, this.result.received.get(p.id) ?? 0);
      meter.push(st === 'lit' ? cssColor(p.color) : null);
      if (silent) continue;
      const note = this.notes.get(p.id);
      const pos = view.root.getWorldPosition(this.v3);
      if (st === 'lit' && was !== 'lit' && note !== undefined) {
        this.audio.bell(note, pos, 0.85);
        this.audio.startSustain(p.id, note, pos);
      } else if (st !== 'lit' && was === 'lit') {
        this.audio.stopSustain(p.id);
      } else if (st === 'partial' && was === 'off' && note !== undefined) {
        this.audio.bell(note - 12, pos, 0.3, 1.2);
      }
    }
    this.hud.setMeter(meter);
    if (this.result.solved && !this.solved && !silent && !this.anyPieceHeld()) this.onSolved();
  }

  private onSolved(): void {
    this.solved = true;
    this.selected = null;
    this.clearHint();
    this.board!.flash();
    this.boost = 1;
    const notes = [...this.notes.values()];
    const center = this.boardRoot.getWorldPosition(this.v3);
    window.setTimeout(() => this.audio.resolve(notes, chordBass(this.movement, this.indexInMovement), center), 250);

    const id = this.level.id;
    if (this.levelIndex >= 0) {
      if (!this.progress.solved.includes(id)) this.progress.solved.push(id);
    } else {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      recordDaily(this.progress, daySeed(today), daySeed(yesterday));
    }
    saveProgress(this.progress);

    const movementDone =
      this.levelIndex >= 0 &&
      CAMPAIGN[this.movement].every((l) => this.progress.solved.includes(l.id)) &&
      this.indexInMovement === 7;
    let status = 'The crystals sing.';
    if (this.levelIndex < 0) status = `Daily chord complete. Streak: ${this.progress.dailyStreak} day(s).`;
    else if (movementDone) {
      status = `${MOVEMENTS[this.movement].title} complete. Listen...`;
      window.setTimeout(() => this.playMovementSong(this.movement), 2600);
    } else if (this.hasNext()) status = 'The crystals sing. Tap Next when ready.';
    this.hud.setStatus(status);
    this.hud.setSolved(true, this.hasNext());
  }

  /** Replay a movement's eight chords: the song the player composed. */
  private playMovementSong(movement: number): void {
    const music = MOVEMENT_MUSIC[movement];
    const center = this.boardRoot.getWorldPosition(new Vector3());
    music.progression.forEach((degree, i) => {
      const tones = chordTones(music, degree);
      tones.slice(0, 3).forEach((n, j) => {
        window.setTimeout(() => this.audio.bell(n + 12, center, 0.6, 2.4), i * 620 + j * 90);
      });
    });
  }

  // ---------------------------------------------------------------- actions

  private canInteract(p: Piece): boolean {
    return !this.solved && (p.lock === 'free' || p.lock === 'rotate');
  }

  private isHeld(id: number): boolean {
    for (const g of [this.grabs.left, this.grabs.right]) if (g?.kind === 'piece' && g.id === id) return true;
    return false;
  }

  private anyPieceHeld(): boolean {
    return this.grabs.left?.kind === 'piece' || this.grabs.right?.kind === 'piece';
  }

  private piece(id: number): Piece {
    return this.state.pieces[id];
  }

  private rotate(p: Piece, steps = 1): void {
    if (!isRotatable(p.kind)) return;
    p.rot = mod8(p.rot + steps);
    this.views.get(p.id)!.syncRotation();
    this.audio.tick('rotate', this.views.get(p.id)!.root.getWorldPosition(this.v3));
    this.noteFirstMove();
    this.retrace();
  }

  private place(p: Piece, x: number, y: number): void {
    p.x = x;
    p.y = y;
    p.onBoard = true;
    this.selected = null;
    this.audio.tick('place', this.views.get(p.id)!.root.getWorldPosition(this.v3));
    this.noteFirstMove();
    this.layoutPieces();
    this.retrace();
  }

  private returnToTray(p: Piece): void {
    p.onBoard = false;
    p.x = p.y = -1;
    this.selected = null;
    this.audio.tick('return');
    this.layoutPieces();
    this.retrace();
  }

  private noteFirstMove(): void {
    if (!this.firstMove) return;
    this.firstMove = false;
    this.clearHint();
    if (!this.solved) this.hud.setStatus(this.defaultStatus());
  }

  private onPieceTap(id: number, long: boolean, pointerType: string): void {
    if (this.time - this.lastGrabActivity < TAP_SUPPRESS || this.grabs.left || this.grabs.right) return;
    if (pointerType === 'touch') {
      // Pokes are deferred a moment so a pinch that starts on the same piece wins.
      this.pendingTap = { id, at: this.time + 0.18, long };
      return;
    }
    this.handleTap(id, long);
  }

  private handleTap(id: number, long: boolean): void {
    const p = this.piece(id);
    const view = this.views.get(id)!;
    if (p.kind === 'target') {
      const note = this.notes.get(id);
      if (note !== undefined) this.audio.bell(note, view.root.getWorldPosition(this.v3), 0.6);
      this.hud.setStatus(`This crystal wants ${needDescription(p.color)} light.`);
      return;
    }
    if (this.solved) return;
    if (!this.canInteract(p)) {
      this.audio.tick('deny');
      return;
    }
    if (!p.onBoard) {
      this.selected = this.selected === id ? null : id;
      this.audio.tick('pick');
      this.layoutPieces();
      if (this.selected !== null) this.hud.setStatus('Now tap an empty cell to place it.');
      return;
    }
    if (p.lock === 'free' && (long || !isRotatable(p.kind) || this.selected === id)) {
      this.selected = this.selected === id ? null : id;
      this.audio.tick('pick');
      this.layoutPieces();
      if (this.selected !== null) this.hud.setStatus('Tap a cell to move it, or the tray to put it back.');
      return;
    }
    this.rotate(p);
  }

  private toBoardLocal(world: Vector3, out: Vector3): Vector3 {
    out.copy(world);
    return this.board!.group.worldToLocal(out);
  }

  private onSurfaceClick(point: Vector3): void {
    if (this.time - this.lastGrabActivity < TAP_SUPPRESS || this.selected === null || this.solved) return;
    const cell = this.board!.localToCell(this.toBoardLocal(point, this.v1), 0.5);
    if (!cell) return;
    const p = this.piece(this.selected);
    const occupant = pieceAt(this.state, cell.x, cell.y);
    if (occupant && occupant.id !== p.id) {
      this.audio.tick('deny');
      return;
    }
    this.board!.setCursor(null);
    this.place(p, cell.x, cell.y);
  }

  private onSurfaceMove(point: Vector3): void {
    if (this.selected === null || this.anyPieceHeld()) return;
    const cell = this.board!.localToCell(this.toBoardLocal(point, this.v1), 0.5);
    const occ = cell ? pieceAt(this.state, cell.x, cell.y) : undefined;
    this.board!.setCursor(cell, !occ || occ.id === this.selected);
  }

  private onTrayClick(): void {
    if (this.time - this.lastGrabActivity < TAP_SUPPRESS || this.selected === null) return;
    const p = this.piece(this.selected);
    if (p.onBoard) this.returnToTray(p);
    else {
      this.selected = null;
      this.layoutPieces();
    }
  }

  // ---------------------------------------------------------------- hints

  private showHint(): void {
    if (this.solved || !this.board) return;
    this.clearHint();
    const n = this.level.board.length;
    const solution = applySolution(this.level);
    // First: a locked mirror that's turned wrong.
    for (const [idxStr, rot] of Object.entries(this.level.solution.rotations ?? {})) {
      const p = this.state.pieces[Number(idxStr)];
      if (p.rot !== rot) {
        this.views.get(p.id)!.setHighlight(1);
        this.hud.setStatus('Hint: turn the glowing brass mirror.');
        return;
      }
    }
    // Then: a tray piece that isn't where the reference solution has it.
    for (let i = 0; i < this.level.tray.length; i++) {
      const want = solution.pieces[n + i];
      const ok = this.state.pieces.some(
        (p) => p.onBoard && p.kind === want.kind && p.x === want.x && p.y === want.y && p.color === want.color,
      );
      if (ok) continue;
      const ghost = new PieceView({ ...want, id: -1, lock: 'free' }, this.board.cell);
      ghost.root.traverse((o) => {
        const m = (o as { material?: { transparent: boolean; opacity: number; depthWrite: boolean } }).material;
        if (m) {
          m.transparent = true;
          m.opacity = Math.min(m.opacity, 0.35);
          m.depthWrite = false;
        }
      });
      this.board.cellToLocal(want.x, want.y, ghost.home);
      ghost.root.position.copy(ghost.home);
      ghost.setHighlight(1);
      this.board.group.add(ghost.root);
      this.hint = { view: ghost, until: this.time + 7 };
      this.hud.setStatus(`Hint: a ${want.kind} belongs on the glowing ghost.`);
      return;
    }
    this.hud.setStatus('Hint: check the turning of each mirror.');
  }

  private clearHint(): void {
    if (!this.hint) return;
    this.hint.view.root.removeFromParent();
    this.hint.view.dispose();
    this.hint = null;
  }

  // ---------------------------------------------------------------- hands

  private updateHands(): void {
    const xr = this.world.renderer.xr;
    if (!xr.isPresenting || !this.board) {
      this.hands.update(null, null, this.originMatrix);
      if (this.board) this.board.handle.visible = false;
      return;
    }
    this.player.updateWorldMatrix(true, false);
    this.originMatrix.copy(this.player.matrixWorld);
    this.hands.update(xr.getFrame(), xr.getReferenceSpace(), this.originMatrix);

    let handleHover = 0;
    for (const h of this.hands.hands) {
      const grab = this.grabs[h.handedness];
      if (h.pinchStarted && !grab && !this.menuOpen) this.tryGrab(h);
      const active = this.grabs[h.handedness];
      if (active && h.pinching) this.updateGrab(h, active);
      if (active && (h.pinchEnded || !h.tracked)) this.endGrab(h, active);

      // Proximity highlight: show what a pinch would pick up.
      const prev = this.hover[h.handedness];
      let next: number | null = null;
      if (h.tracked && !this.grabs[h.handedness]) {
        next = this.nearestPiece(h.point);
        if (this.nearHandle(h.point)) handleHover = 1;
      }
      if (prev !== next) {
        if (prev !== null && !this.isHeld(prev)) this.views.get(prev)?.setHighlight(0);
        if (next !== null) this.views.get(next)?.setHighlight(0.8);
        this.hover[h.handedness] = next;
      }
      if (this.grabs[h.handedness]?.kind === 'board') handleHover = 1;
    }
    this.board.setHandleHighlight(handleHover);
    this.board.handle.visible = true;
  }

  private nearestPiece(world: Vector3): number | null {
    if (this.solved || !this.board) return null;
    const local = this.toBoardLocal(world, this.v1);
    let best: number | null = null;
    let bestD = GRAB_RADIUS;
    for (const p of this.state.pieces) {
      if (!this.canInteract(p) || this.isHeld(p.id)) continue;
      const v = this.views.get(p.id)!;
      this.v2.copy(v.root.position);
      this.v2.y += v.s * 0.3;
      const d = this.v2.distanceTo(local);
      if (d < bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return best;
  }

  private nearHandle(world: Vector3): boolean {
    if (!this.board) return false;
    this.board.handle.getWorldPosition(this.v2);
    return this.v2.distanceTo(world) < HANDLE_RADIUS;
  }

  private tryGrab(h: HandState): void {
    if (this.nearHandle(h.point)) {
      this.grabs[h.handedness] = {
        kind: 'board',
        offset: new Vector3().subVectors(this.boardRoot.position, h.point),
      };
      this.lastGrabActivity = this.time;
      this.audio.tick('pick');
      return;
    }
    const id = this.nearestPiece(h.point);
    if (id === null) return;
    const p = this.piece(id);
    const view = this.views.get(id)!;
    if (this.pendingTap?.id === id) this.pendingTap = null;
    const local = this.toBoardLocal(h.point, this.v1);
    this.grabs[h.handedness] = {
      kind: 'piece',
      id,
      startWrist: h.wrist.clone(),
      startRot: p.rot,
      offset: new Vector3().subVectors(view.root.position, local),
      wasOnBoard: p.onBoard,
      homeX: p.x,
      homeY: p.y,
      moved: false,
    };
    if (this.selected === id) this.selected = null;
    view.setHighlight(1);
    if (p.lock === 'free') view.snap = true;
    this.lastGrabActivity = this.time;
    this.audio.tick('pick', view.root.getWorldPosition(this.v3));
  }

  private updateGrab(h: HandState, grab: Grab): void {
    this.lastGrabActivity = this.time;
    if (grab.kind === 'board') {
      this.v1.addVectors(h.point, grab.offset);
      this.boardRoot.position.lerp(this.v1, 0.6);
      // Keep the board facing the player while it is carried.
      this.readHead();
      this.v2.subVectors(this.boardRoot.position, this.headPos).setY(0);
      if (this.v2.lengthSq() > 1e-4) {
        const yaw = Math.atan2(-this.v2.x, -this.v2.z);
        this.boardRoot.rotation.set(0, yaw, 0);
      }
      return;
    }
    const p = this.piece(grab.id);
    const view = this.views.get(grab.id)!;
    let changed = false;

    if (isRotatable(p.kind)) {
      this.boardRoot.getWorldQuaternion(this.q1);
      this.v2.copy(this.up).applyQuaternion(this.q1);
      const angle = twistAngle(grab.startWrist, h.wrist, this.v2);
      const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle));
      const steps = Math.round((wrapped * TWIST_GAIN) / (Math.PI / 8));
      const rot = mod8(grab.startRot + steps);
      if (rot !== p.rot) {
        p.rot = rot;
        view.syncRotation();
        this.audio.tick('rotate', view.root.getWorldPosition(this.v3));
        changed = true;
      }
    }

    if (p.lock === 'free') {
      const local = this.toBoardLocal(h.point, this.v1).add(grab.offset);
      local.y = Math.max(local.y, 0.004);
      view.home.copy(local);
      if (!grab.moved && Math.hypot(local.x - view.root.position.x, local.z - view.root.position.z) > 0.012) {
        grab.moved = true;
      }
      const cell = this.board!.localToCell(local, 0.45);
      const lowEnough = local.y < this.board!.cell * 2.2;
      let px = -1;
      let py = -1;
      let on = false;
      if (cell && lowEnough) {
        const occ = pieceAt(this.state, cell.x, cell.y);
        if (!occ || occ.id === p.id) {
          px = cell.x;
          py = cell.y;
          on = true;
        }
      }
      this.board!.setCursor(on ? { x: px, y: py } : cell && lowEnough ? cell : null, on);
      if (on !== p.onBoard || (on && (px !== p.x || py !== p.y))) {
        p.onBoard = on;
        p.x = px;
        p.y = py;
        changed = true;
      }
    }
    if (changed) {
      this.noteFirstMove();
      this.retrace();
    }
  }

  private endGrab(h: HandState, grab: Grab): void {
    this.grabs[h.handedness] = null;
    this.lastGrabActivity = this.time;
    if (grab.kind === 'board') {
      this.audio.tick('place');
      return;
    }
    const p = this.piece(grab.id);
    const view = this.views.get(grab.id)!;
    view.snap = false;
    view.setHighlight(0);
    this.board!.setCursor(null);
    if (p.lock === 'free') {
      if (p.onBoard) this.place(p, p.x, p.y);
      else this.returnToTray(p);
    }
    // A solve that happened while the piece was held is announced on release.
    if (this.result?.solved && !this.solved) this.onSolved();
  }

  // ---------------------------------------------------------------- gaze

  private updateGaze(dt: number): void {
    if (!this.board || this.menuOpen) return;
    const eye = this.player.eyeSpace;
    if (this.player.gazeOrigin === 'tracked') {
      eye.updateWorldMatrix(true, false);
      this.v1.setFromMatrixPosition(eye.matrixWorld);
      this.q1.setFromRotationMatrix(eye.matrixWorld);
      this.v2.set(0, 0, -1).applyQuaternion(this.q1);
    } else {
      this.v1.copy(this.headPos);
      this.v2.copy(this.headFwd);
    }
    let best: number | null = null;
    let bestCos = Math.cos((6 * Math.PI) / 180);
    for (const p of this.state.pieces) {
      if (p.kind !== 'target') continue;
      const view = this.views.get(p.id)!;
      view.root.getWorldPosition(this.v3);
      this.v3.y += view.s * 0.42;
      this.v3.sub(this.v1);
      const dist = this.v3.length();
      if (dist > 2) continue;
      const c = this.v3.dot(this.v2) / dist;
      if (c > bestCos) {
        bestCos = c;
        best = p.id;
      }
    }
    if (best !== this.gazed) {
      this.gazed = best;
      this.gazeSince = 0;
    } else if (best !== null) {
      this.gazeSince += dt;
      if (this.gazeSince > 0.45 && !this.gazeSung.has(best)) {
        this.gazeSung.add(best);
        const p = this.piece(best);
        const view = this.views.get(best)!;
        const note = this.notes.get(best);
        if (note !== undefined) this.audio.bell(note, view.root.getWorldPosition(this.v3), 0.35, 1.6);
        if (!this.solved && this.firstMove === false) {
          this.hud.setStatus(`This crystal wants ${needDescription(p.color)} light.`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- frame

  update(delta: number, time: number): void {
    const dt = Math.min(delta, 0.05);
    this.time = time;
    const immersive = this.world.renderer.xr.isPresenting;

    if (immersive) {
      this.readHead();
      if (this.pendingPlacement && this.headPos.lengthSq() > 0) {
        this.pendingPlacement = false;
        this.placeInFrontOfHead();
      }
      this.audio.setListener(this.headPos, this.headFwd, this.headUp);
    } else {
      this.world.camera.getWorldPosition(this.headPos);
      this.world.camera.getWorldDirection(this.headFwd);
      this.headUp.set(0, 1, 0);
      this.audio.setListener(this.headPos, this.headFwd, this.headUp);
    }

    this.updateHands();
    if (immersive) this.updateGaze(dt);

    if (this.pendingTap && time >= this.pendingTap.at) {
      const tap = this.pendingTap;
      this.pendingTap = null;
      if (!this.grabs.left && !this.grabs.right) this.handleTap(tap.id, tap.long);
    }

    if (this.hint && time > this.hint.until) this.clearHint();
    this.hint?.view.update(dt, time);

    this.boost = Math.max(0, this.boost - dt * 0.5);
    this.beams?.setBoost(this.boost);
    this.beams?.update(dt, time);
    this.board?.update(dt, time);
    for (const v of this.views.values()) v.update(dt, time);
    this.layoutHud();
  }

  // ---------------------------------------------------------------- debug

  /** Console/test hooks: `window.prismSong.state()` etc. */
  private exposeDebug(): void {
    const api = {
      ascii: () => renderAscii(this.state),
      state: () => ({
        level: this.level.id,
        solved: this.solved,
        selected: this.selected,
        pieces: this.state.pieces.map((p) => ({ ...p })),
        targets: [...(this.result?.targetState.entries() ?? [])],
      }),
      load: (i: number) => this.loadIndex(i),
      daily: () => this.loadDaily(),
      tap: (id: number, long = false) => this.handleTap(id, long),
      tapCell: (x: number, y: number) => {
        const v = this.board!.cellToLocal(x, y, new Vector3());
        this.onSurfaceClick(this.board!.group.localToWorld(v));
      },
      solve: () => {
        const sol = applySolution(this.level);
        for (const p of sol.pieces) Object.assign(this.state.pieces[p.id], p);
        for (const v of this.views.values()) v.syncRotation();
        this.layoutPieces();
        this.retrace();
      },
      pieceWorld: (id: number) => this.views.get(id)!.root.getWorldPosition(new Vector3()).toArray(),
      cellWorld: (x: number, y: number) =>
        this.board!.group.localToWorld(this.board!.cellToLocal(x, y, new Vector3())).toArray(),
      boardRoot: () => this.boardRoot as Object3D,
      /** Canvas pixel position of a world point (for real pointer tests). */
      project: (xyz: [number, number, number]) => {
        const v = new Vector3(...xyz).project(this.world.camera);
        const r = this.world.renderer.domElement.getBoundingClientRect();
        return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
      },
      hud: () => this.hud.object.getWorldPosition(new Vector3()).toArray(),
      hands: () =>
        this.hands.hands.map((h) => ({
          hand: h.handedness,
          tracked: h.tracked,
          pinching: h.pinching,
          strength: h.strength,
          point: h.point.toArray(),
          grab: this.grabs[h.handedness]?.kind === 'piece' ? (this.grabs[h.handedness] as PieceGrab).id : this.grabs[h.handedness]?.kind ?? null,
        })),
      grabPoint: (id: number) => {
        const v = this.views.get(id)!;
        const p = v.root.getWorldPosition(new Vector3());
        p.y += v.s * 0.3;
        return p.toArray();
      },
    };
    (window as unknown as { prismSong: typeof api }).prismSong = api;
  }
}
