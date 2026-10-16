/**
 * HANDCAST HUD: a thin wrapper over public/ui/hud.uikitml. Knows element ids,
 * section toggling and button wiring; game logic lives in the game system.
 */

import { UIKit, UIKitMLAsset, World } from '@iwsdk/core';
import type { ColorMask } from '../core/types.js';
import { lightColor } from '../render/bench/props.js';

type El = {
  setProperties(props: Record<string, unknown>): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

type ClassList = { contains(name: string): boolean; add(name: string): void; remove(name: string): void };

export type HudSection = 'play' | 'menu' | 'studio' | 'hall' | 'calibrate';

export const HUD_LEVELS = 49;
const METER = 8;
const TOKENS = 4;
const HALL_ROWS = 6;

export interface HudHandlers {
  undo(): void;
  reset(): void;
  hint(): void;
  menu(): void;
  next(): void;
  back(): void;
  pick(i: number): void;
  daily(): void;
  kiln(): void;
  studio(): void;
  hall(): void;
  sound(): void;
  assist(): void;
  /** Large text, high contrast (accessibility). */
  contrast(): void;
  recenter(): void;
  tool(name: 'lamp' | 'well' | 'hush' | 'wall' | 'erase'): void;
  studioUndo(): void;
  drop(): void;
  publish(): void;
  studioExit(): void;
  hallTab(tab: 'featured' | 'new' | 'top'): void;
  hallPick(i: number): void;
  like(): void;
}

const TOOLS = ['lamp', 'well', 'hush', 'wall', 'erase'] as const;

const SECTIONS: Record<HudSection, string[]> = {
  play: ['play', 'play-actions'],
  // Setup shows only the board text: no buttons to fumble while finding the table.
  calibrate: ['play'],
  menu: ['menu', 'menu-actions', 'menu-actions-2'],
  studio: ['studio', 'studio-tools', 'studio-actions'],
  hall: ['hall', 'hall-actions'],
};

/**
 * Classes with a "-hc" (Large text, high contrast) variant in hud.uikitml.
 * Runtime-set colours (chips, menu cells, tools) are chosen per mode below.
 */
const HC_CLASSES = [
  'root', 'fixed-w', 'eyebrow', 'title', 'status', 'chip', 'chip-t', 'chip-k', 'glass-token', 'button-label', 'wide-btn',
  'movement-label', 'cell-btn', 'cell-label', 'hall-row', 'hall-name', 'hall-meta', 'code',
];

/** Night-studio palette (dark glass). Contrast vs the panel (#090d16) is >= 7:1 for text. */
const ACCENT = '#8fd0ff';
const INK = '#070a10';
const TEXT = '#eef2f8';
const CELL_OPEN = ['rgba(255,255,255,0.08)', '#141a26'];
const CELL_SOLVED = '#ffd76a';
const TOOL_IDLE = ['rgba(255,255,255,0.1)', '#1a2130'];

/** Colour letter per light mask: colour is never the only cue. */
const LETTER: Record<number, string> = { 1: 'R', 2: 'G', 4: 'B', 3: 'Y', 5: 'M', 6: 'C', 7: 'W' };
const CHIP_HEX: string[] = [];
const CHIP_DIM: string[] = [];
for (let m = 0; m < 8; m++) {
  const c = lightColor(m);
  CHIP_HEX[m] = `#${c.getHexString()}`;
  CHIP_DIM[m] = `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.16)`;
}

interface Chip {
  box: El | null;
  letter: El | null;
  check: El | null;
  /** Last applied state: colour mask (-1 = hidden), lit, contrast. */
  mask: number;
  lit: boolean;
  hc: boolean;
}

export class Hud {
  readonly object: UIKitMLAsset;
  section: HudSection = 'play';
  /** Last status line shown (read by tests). */
  status = '';
  /** Large text, high contrast mode is on. */
  contrast = false;
  private cleanup: (() => void)[] = [];
  private chips: Chip[] = [];
  private hcTargets: { list: ClassList; cls: string }[] = [];
  private menuStates: ('solved' | 'open')[] = [];
  private menuCurrent = -1;
  private tool: string | null = null;

  constructor(world: World, h: HudHandlers) {
    // Dark glass for the night studio: the Horizon kit's :dark variants (buttons,
    // panel) follow this, and .root in hud.uikitml sets the exact surface.
    UIKit.setPreferredColorScheme('dark');
    this.object = world.requireSceneObject<UIKitMLAsset>('hud');
    const bind = (id: string, fn: () => void) => {
      const el = this.el(id);
      if (!el) return;
      el.addEventListener('click', fn);
      this.cleanup.push(() => el.removeEventListener('click', fn));
    };
    bind('btn-undo', h.undo);
    bind('btn-reset', h.reset);
    bind('btn-hint', h.hint);
    bind('btn-menu', h.menu);
    bind('btn-next', h.next);
    bind('btn-back', h.back);
    bind('btn-daily', h.daily);
    bind('btn-kiln', h.kiln);
    bind('btn-studio', h.studio);
    bind('btn-hall', h.hall);
    bind('btn-sound', h.sound);
    bind('btn-assist', h.assist);
    bind('btn-contrast', h.contrast);
    bind('btn-recenter', h.recenter);
    bind('btn-drop', h.drop);
    bind('btn-publish', h.publish);
    bind('btn-studio-exit', h.studioExit);
    bind('btn-studio-undo', h.studioUndo);
    bind('btn-like', h.like);
    for (const t of TOOLS) bind(`tool-${t}`, () => h.tool(t));
    bind('hall-featured', () => h.hallTab('featured'));
    bind('hall-new', () => h.hallTab('new'));
    bind('hall-top', () => h.hallTab('top'));
    bind('hall-back', h.back);
    for (let i = 0; i < HUD_LEVELS; i++) bind(`lvl-${i}`, () => h.pick(i));
    for (let i = 0; i < HALL_ROWS; i++) bind(`hall-${i}`, () => h.hallPick(i));
    for (let i = 0; i < METER; i++) {
      this.chips.push({ box: this.el(`meter-${i}`), letter: this.el(`meter-${i}-t`), check: this.el(`meter-${i}-k`), mask: -2, lit: false, hc: false });
    }
    this.object.traverse((o) => {
      const list = (o as unknown as { classList?: ClassList }).classList;
      if (!list || typeof list.contains !== 'function') return;
      for (const cls of HC_CLASSES) if (list.contains(cls)) this.hcTargets.push({ list, cls: `${cls}-hc` });
    });
    this.show('play');
  }

  private el(id: string): El | null {
    return this.object.getElementById(id) as unknown as El | null;
  }

  private set(id: string, props: Record<string, unknown>): void {
    this.el(id)?.setProperties(props);
  }

  show(section: HudSection): void {
    this.section = section;
    const on = new Set(SECTIONS[section]);
    for (const ids of Object.values(SECTIONS)) {
      for (const id of ids) this.set(id, { display: on.has(id) ? 'flex' : 'none' });
    }
  }

  setBoard(eyebrow: string, title: string, status: string): void {
    this.set('hud-eyebrow', { text: eyebrow });
    this.set('hud-title', { text: title });
    this.setStatus(status);
  }

  setStatus(status: string): void {
    if (status === this.status) return;
    this.status = status;
    this.set('hud-status', { text: status });
  }

  /** Glass tokens: `left` of `budget` casts remain (spent ones are hollow). */
  setBudget(left: number, budget: number): void {
    for (let i = 0; i < TOKENS; i++) {
      this.set(`tok-${i}`, {
        display: i < budget ? 'flex' : 'none',
        backgroundColor: i < left ? ACCENT : 'rgba(143,208,255,0.1)',
      });
    }
  }

  /**
   * One chip per crystal in its required colour, with its colour letter: dim
   * and outlined until the crystal is lit by glass, then filled with a check.
   * Only chips whose state changed are touched (no allocation when idle).
   */
  setMeter(crystals: readonly { color: ColorMask }[], lit?: readonly boolean[]): void {
    for (let i = 0; i < METER; i++) {
      const chip = this.chips[i];
      const mask = i < crystals.length ? crystals[i].color & 7 : -1;
      const on = mask >= 0 && !!lit?.[i];
      if (chip.mask === mask && chip.lit === on && chip.hc === this.contrast) continue;
      this.paintChip(chip, mask, on);
    }
  }

  private paintChip(chip: Chip, mask: number, on: boolean): void {
    if (mask < 0) {
      if (chip.mask !== -1) chip.box?.setProperties({ display: 'none' });
    } else {
      const hex = CHIP_HEX[mask];
      chip.box?.setProperties({
        display: 'flex',
        backgroundColor: on ? hex : this.contrast ? '#000000' : CHIP_DIM[mask],
        borderColor: on && this.contrast ? '#ffffff' : hex,
        borderWidth: this.contrast ? 4 : 2,
      });
      chip.letter?.setProperties({ display: on ? 'none' : 'flex', text: LETTER[mask] ?? '?', color: hex });
      chip.check?.setProperties({ display: on ? 'flex' : 'none' });
    }
    chip.mask = mask;
    chip.lit = on;
    chip.hc = this.contrast;
  }

  setSolved(solved: boolean, hasNext: boolean, canLike = false): void {
    this.set('btn-next', { display: solved && hasNext ? 'flex' : 'none' });
    this.set('btn-hint', { display: solved ? 'none' : 'flex' });
    this.set('btn-like', { display: solved && canLike ? 'flex' : 'none' });
  }

  setLike(label: string): void {
    this.set('btn-like-label', { text: label });
  }

  /** Highlights the active studio tool (null = none). */
  setTool(active: string | null): void {
    this.tool = active;
    const hc = this.contrast ? 1 : 0;
    for (const t of TOOLS) {
      const on = t === active;
      this.set(`tool-${t}`, { backgroundColor: on ? ACCENT : TOOL_IDLE[hc] });
      this.set(`tool-${t}-t`, { color: on ? INK : hc ? '#ffffff' : TEXT });
    }
  }

  setMenuState(
    states: ('solved' | 'open')[],
    current: number,
    labels: { daily: string; sound: string; assist: string; contrast?: string },
  ): void {
    this.menuStates = states;
    this.menuCurrent = current;
    this.paintMenu();
    for (let i = states.length; i < HUD_LEVELS; i++) this.set(`lvl-${i}`, { display: 'none' });
    this.set('btn-daily-label', { text: labels.daily });
    this.set('btn-sound-label', { text: labels.sound });
    this.set('btn-assist-label', { text: labels.assist });
    if (labels.contrast !== undefined) this.set('btn-contrast-label', { text: labels.contrast });
  }

  private paintMenu(): void {
    const hc = this.contrast ? 1 : 0;
    const states = this.menuStates;
    for (let i = 0; i < states.length && i < HUD_LEVELS; i++) {
      const cur = i === this.menuCurrent;
      const solved = states[i] === 'solved';
      this.set(`lvl-${i}`, { backgroundColor: cur ? ACCENT : solved ? CELL_SOLVED : CELL_OPEN[hc] });
      this.set(`lvl-${i}-t`, { color: cur || solved ? INK : hc ? '#ffffff' : TEXT });
    }
  }

  /**
   * Large text, high contrast: bigger fonts, pure white on near-black and
   * thicker outlines across the whole HUD, applied immediately.
   */
  setContrast(on: boolean): void {
    if (on === this.contrast) return;
    this.contrast = on;
    for (const t of this.hcTargets) {
      if (on) t.list.add(t.cls);
      else t.list.remove(t.cls);
    }
    for (const chip of this.chips) if (chip.mask >= 0) this.paintChip(chip, chip.mask, chip.lit);
    this.paintMenu();
    this.setTool(this.tool);
  }

  setStudioStatus(text: string, code?: string): void {
    this.status = text;
    this.set('studio-status', { text });
    if (code !== undefined) this.set('studio-code', { text: code });
  }

  setHall(title: string, rows: { name: string; meta: string }[]): void {
    this.set('hall-title', { text: title });
    for (let i = 0; i < HALL_ROWS; i++) {
      const r = rows[i];
      this.set(`hall-${i}`, { display: r ? 'flex' : 'none' });
      if (r) {
        this.set(`hall-${i}-name`, { text: r.name });
        this.set(`hall-${i}-meta`, { text: r.meta });
      }
    }
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }
}
