/**
 * The Studio: make a board with your hands. Cast glass hands in the light
 * (the solution), then "Crystals" puts a crystal of the right colour on
 * every beam they send and hush stones where a lazier hand would spill
 * light. Lamps, pools of light, hush stones and walls are placed with a
 * fingertip pinch on the bench:
 *
 *  - pinch empty bench with a tool: place it (pull to aim a lamp, to size a
 *    pool, to draw a wall);
 *  - pinch an element: drag to move it (with the Lamp tool: re-aim a lamp);
 *    a quick tap cycles a lamp / pool / crystal colour or turns a wall into
 *    a mirror and back;
 *  - Erase tool: pinch an element (or a glass hand's foot) to remove it.
 *
 * StudioSession is the state (BoardEditor + whole-state undo history) and the
 * gesture logic; StudioCursor draws the in-progress drag. The game system
 * owns the glass hands and the bench view.
 */

import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry, Color as ThreeColor } from '@iwsdk/core';
import {
  BoardEditor,
  castDataToPose,
  dropCrystals,
  EDITOR,
  ElementKind,
  Pick,
  poseToCastData,
  SealResult,
  sealCheck,
  suggestHush,
} from '../core/editor.js';
import { traceLevel } from '../core/trace2d.js';
import { CastData, ColorMask, HandPose, LevelDef, V2 } from '../core/types.js';
import { HUSH_COLOR, LIGHT_SHEET_Y, lightColor, XR_ADDITIVE } from '../render/bench/props.js';

export type StudioTool = 'lamp' | 'well' | 'hush' | 'wall' | 'erase';

export interface StudioSnapshot {
  level: LevelDef;
  casts: CastData[];
}

interface Drag {
  tool: StudioTool | null;
  start: V2;
  cur: V2;
  t0: number;
  /** Element under the pinch at the start, if any. */
  pick: Pick | null;
}

/** Pinch-to-element pick radius (m). */
export const STUDIO_PICK = 0.025;
const TAP_MOVE = 0.012;
const TAP_TIME = 0.4;
const HISTORY = 60;
const ELEMENT_KINDS: ElementKind[] = ['lamp', 'crystal', 'hush', 'well', 'wall', 'mirror'];

/** A fresh board: one pool of white light in the middle. */
export function starterBoard(): Partial<LevelDef> {
  return {
    name: 'Untitled',
    bench: { w: 0.44, d: 0.3 },
    budget: 1,
    wells: [{ p: [0, 0.06], r: 0.035, color: 7 }],
  };
}

export class StudioSession {
  editor: BoardEditor;
  tool: StudioTool | null = null;
  drag: Drag | null = null;
  private history: StudioSnapshot[] = [];

  constructor(base: Partial<LevelDef> = starterBoard()) {
    this.editor = new BoardEditor(base);
  }

  get level(): LevelDef {
    return this.editor.level;
  }

  get canUndo(): boolean {
    return this.history.length > 1;
  }

  /** Records the current state with these glass hands (call after every change). */
  commit(casts: readonly HandPose[]): void {
    this.history.push({ level: JSON.parse(JSON.stringify(this.editor.level)) as LevelDef, casts: casts.map(poseToCastData) });
    if (this.history.length > HISTORY) this.history.shift();
  }

  /** Steps back one change; returns the state to show (its casts as poses), or null. */
  undo(): { level: LevelDef; casts: HandPose[] } | null {
    if (this.history.length < 2) return null;
    this.history.pop();
    const s = this.history[this.history.length - 1];
    this.editor = new BoardEditor(s.level);
    return { level: this.editor.level, casts: s.casts.map(castDataToPose) };
  }

  /** Replaces the editor's author casts with the glass hands on the bench. */
  syncCasts(casts: readonly HandPose[]): void {
    const e = this.editor;
    e.transact(() => {
      for (let i = e.casts.length - 1; i >= 0; i--) e.removeCast(i);
      for (const c of casts) e.addCast(c);
    });
    e.setBudget(Math.max(1, casts.length));
  }

  /** Nearest element (not a cast) within the pick radius. */
  pickAt(p: V2): Pick | null {
    let best: Pick | null = null;
    for (const k of ELEMENT_KINDS) {
      const hit = this.editor.nearest(k, p, STUDIO_PICK);
      if (hit && (!best || hit.d < best.d)) best = hit;
    }
    return best;
  }

  beginDrag(p: V2, time: number): void {
    const pick = this.tool === 'erase' ? null : this.pickAt(p);
    this.drag = { tool: this.tool, start: [p[0], p[1]], cur: [p[0], p[1]], t0: time, pick };
  }

  moveDrag(p: V2): void {
    if (this.drag) this.drag.cur = [p[0], p[1]];
  }

  cancelDrag(): void {
    this.drag = null;
  }

  /**
   * Finishes a pinch drag. Returns a status line when the board changed (the
   * caller then rebuilds the bench and commits), '' when nothing happened.
   */
  endDrag(time: number): string {
    const d = this.drag;
    this.drag = null;
    if (!d) return '';
    const e = this.editor;
    const dist = Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]);
    const tap = dist < TAP_MOVE && time - d.t0 < TAP_TIME;

    if (d.tool === 'erase') {
      const hit = this.pickAt(d.start);
      if (!hit) return '';
      e.remove(hit.kind, hit.i);
      return `Removed a ${label(hit.kind)}.`;
    }

    if (d.pick) {
      const { kind, i } = d.pick;
      if (tap) {
        if (kind === 'wall' || kind === 'mirror') {
          const s = (kind === 'wall' ? e.level.walls : e.level.mirrors)[i];
          if (!s) return '';
          const a = s.a;
          const b = s.b;
          e.transact(() => {
            e.remove(kind, i);
            if (kind === 'wall') e.addMirror(a, b);
            else e.addWall(a, b);
          });
          return kind === 'wall' ? 'Now a mirror: light bounces off it.' : 'Back to a wall: it blocks light.';
        }
        const c = e.cycleColor(kind as ElementKind, i);
        return c ? `Colour: ${colorName(c)}.` : '';
      }
      if (kind === 'lamp' && d.tool === 'lamp') {
        const lamp = e.level.lamps[i];
        if (!lamp) return '';
        e.setLampAngle(i, Math.atan2(d.cur[1] - lamp.p[1], d.cur[0] - lamp.p[0]));
        return 'Lamp aimed.';
      }
      if (kind === 'crystal' || kind === 'hush' || kind === 'lamp' || kind === 'well' || kind === 'wall' || kind === 'mirror') {
        const at = this.dragTarget(d);
        e.move(kind, i, at);
        return `Moved the ${label(kind)}.`;
      }
      return '';
    }

    switch (d.tool) {
      case 'lamp': {
        const a = dist > TAP_MOVE ? Math.atan2(d.cur[1] - d.start[1], d.cur[0] - d.start[0]) : defaultAim(d.start);
        return e.addLamp(d.start, a, 7) >= 0 ? 'Lamp placed. Tap it to change its colour.' : '';
      }
      case 'well': {
        const r = dist > TAP_MOVE ? Math.min(EDITOR.maxWellR, Math.max(EDITOR.minWellR, dist)) : EDITOR.defaultWellR;
        return e.addWell(d.start, r, 7) >= 0 ? 'Pool of light placed. Rest a palm in it to catch light.' : '';
      }
      case 'hush':
        return e.addHush(d.cur) >= 0 ? 'Hush stone placed: light must never touch it.' : '';
      case 'wall':
        if (dist < 0.02) return 'Pinch and pull to draw a wall. Tap a wall to make it a mirror.';
        return e.addWall(d.start, d.cur) >= 0 ? 'Wall drawn. Tap it to turn it into a mirror.' : '';
      default:
        return '';
    }
  }

  /** Where a moved element lands (segments move by their midpoint). */
  private dragTarget(d: Drag): V2 {
    const pick = d.pick!;
    const dx = d.cur[0] - d.start[0];
    const dz = d.cur[1] - d.start[1];
    const l = this.editor.level;
    let base: V2 = d.start;
    if (pick.kind === 'wall' || pick.kind === 'mirror') {
      const s = (pick.kind === 'wall' ? l.walls : l.mirrors)[pick.i];
      base = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    } else {
      const item = (pick.kind === 'lamp' ? l.lamps : pick.kind === 'well' ? l.wells : pick.kind === 'crystal' ? l.crystals : l.hush)[pick.i];
      if (item) base = item.p;
    }
    return [base[0] + dx, base[1] + dz];
  }

  /**
   * Cast-first finishing: drops crystals on every beam the glass hands send,
   * guards with hush stones, and clears targets the hands no longer serve.
   */
  drop(casts: readonly HandPose[]): { crystals: number; hush: number; removed: number } {
    const e = this.editor;
    this.syncCasts(casts);
    let removed = 0;
    e.transact(() => {
      const tr = traceLevel(e.level, e.optics(), { assist: 0 });
      for (let i = e.level.crystals.length - 1; i >= 0; i--) {
        if (tr.crystals[i].state !== 'lit') {
          e.remove('crystal', i);
          removed++;
        }
      }
      for (let i = e.level.hush.length - 1; i >= 0; i--) {
        if (tr.hush[i].awake) {
          e.remove('hush', i);
          removed++;
        }
      }
    });
    const crystals = dropCrystals(e).length;
    const hush = suggestHush(e).length;
    return { crystals, hush, removed };
  }

  seal(casts: readonly HandPose[]): SealResult {
    this.syncCasts(casts);
    return sealCheck(this.editor);
  }

  /** The board as a publishable level (id/name/author are replaced by the publisher). */
  toLevel(handle: string): LevelDef {
    return this.editor.toLevel(this.editor.level.name, handle);
  }
}

function defaultAim(p: V2): number {
  if (Math.hypot(p[0], p[1]) < 0.02) return -Math.PI / 2;
  return Math.atan2(-p[1], -p[0]);
}

function label(kind: string): string {
  return kind === 'well' ? 'pool' : kind === 'hush' ? 'hush stone' : kind;
}

export function colorName(c: ColorMask): string {
  return ({ 1: 'red', 2: 'green', 4: 'blue', 3: 'yellow', 5: 'magenta', 6: 'cyan', 7: 'white' } as Record<number, string>)[c] ?? 'white';
}

/** Turns the most important seal problem into a friendly sentence. */
export function sealMessage(r: SealResult): string {
  const has = (re: RegExp) => r.reasons.some((why) => re.test(why));
  if (has(/cast your solution/)) return 'Cast a glass hand in the light first.';
  if (has(/at least one crystal/)) return 'Tap Crystals to place targets on your beams.';
  if (has(/off the bench/)) return 'Something sits off the bench. Move it back on.';
  if (has(/do not solve/)) return 'Your glass hands no longer light every crystal. Tap Crystals again.';
  if (has(/already solved/)) return 'The board solves itself. Block the lamps or move the crystals.';
  const why = r.reasons[0];
  return why ? `Not yet: ${why}.` : 'Not ready yet.';
}

// ------------------------------------------------------------------ cursor

/** Flat ring + bar drawn on the light sheet while a studio pinch is held. */
export class StudioCursor {
  readonly group = new Group();
  private ring: Mesh;
  private bar: Mesh;
  private ringMat: MeshBasicMaterial;
  private barMat: MeshBasicMaterial;
  private col = new ThreeColor();

  constructor() {
    this.group.name = 'studio-cursor';
    this.ringMat = new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, ...XR_ADDITIVE });
    const ringGeo = new RingGeometry(0.72, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new Mesh(ringGeo, this.ringMat);
    this.ring.renderOrder = 6;
    // A unit bar along +X from the origin, lying flat: scaled to length / width, turned about Y.
    this.barMat = new MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false, ...XR_ADDITIVE });
    const barGeo = new PlaneGeometry(1, 1);
    barGeo.rotateX(-Math.PI / 2);
    barGeo.translate(0.5, 0, 0);
    this.bar = new Mesh(barGeo, this.barMat);
    this.bar.renderOrder = 6;
    this.group.add(this.ring, this.bar);
    this.group.visible = false;
  }

  /** Shows the preview for a drag (or hides it for null). */
  show(drag: Drag | null, level: LevelDef, time: number): void {
    if (!drag) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const pulse = 0.75 + 0.25 * Math.sin(time * 8);
    const y = LIGHT_SHEET_Y;
    const { start, cur, pick, tool } = drag;
    let ringAt: V2 = cur;
    let r = 0.014;
    let line: [V2, V2] | null = null;
    let color: ThreeColor = lightColor(7);
    if (tool === 'erase') {
      color = HUSH_COLOR;
      ringAt = start;
      r = STUDIO_PICK;
    } else if (pick) {
      if (pick.kind === 'lamp' && tool === 'lamp') {
        const lamp = level.lamps[pick.i];
        if (lamp) {
          ringAt = lamp.p;
          line = [lamp.p, cur];
          color = lightColor(lamp.color);
        }
      }
    } else if (tool === 'lamp') {
      ringAt = start;
      r = 0.012;
      line = [start, cur];
    } else if (tool === 'well') {
      ringAt = start;
      const d = Math.hypot(cur[0] - start[0], cur[1] - start[1]);
      r = d > TAP_MOVE ? Math.min(EDITOR.maxWellR, Math.max(EDITOR.minWellR, d)) : EDITOR.defaultWellR;
    } else if (tool === 'hush') {
      color = HUSH_COLOR;
    } else if (tool === 'wall') {
      ringAt = start;
      r = 0.006;
      line = [start, cur];
      color = this.col.setRGB(0.7, 0.75, 0.85);
    }
    this.ring.position.set(ringAt[0], y, ringAt[1]);
    this.ring.scale.setScalar(r);
    this.ringMat.color.copy(color).multiplyScalar(pulse);
    const len = line ? Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) : 0;
    this.bar.visible = len > 0.004;
    if (line && this.bar.visible) {
      this.bar.position.set(line[0][0], y, line[0][1]);
      this.bar.rotation.set(0, -Math.atan2(line[1][1] - line[0][1], line[1][0] - line[0][0]), 0);
      this.bar.scale.set(len, 1, tool === 'wall' ? 0.006 : 0.003);
      this.barMat.color.copy(color).multiplyScalar(pulse);
    }
  }

  dispose(): void {
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.bar.geometry.dispose();
    this.barMat.dispose();
    this.group.removeFromParent();
  }
}
