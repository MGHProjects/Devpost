/**
 * HANDCAST HUD: a thin wrapper over public/ui/hud.uikitml. Knows element ids,
 * section toggling and button wiring; game logic lives in the game system.
 */

import { UIKitMLAsset, World } from '@iwsdk/core';

type El = {
  setProperties(props: Record<string, unknown>): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

export type HudSection = 'play' | 'menu' | 'studio' | 'hall';

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
  recenter(): void;
  tool(name: 'lamp' | 'well' | 'hush' | 'wall' | 'erase'): void;
  drop(): void;
  publish(): void;
  studioExit(): void;
  hallTab(tab: 'featured' | 'new' | 'top'): void;
  hallPick(i: number): void;
}

const SECTIONS: Record<HudSection, string[]> = {
  play: ['play', 'play-actions'],
  menu: ['menu', 'menu-actions', 'menu-actions-2'],
  studio: ['studio', 'studio-tools', 'studio-actions'],
  hall: ['hall', 'hall-actions'],
};

export class Hud {
  readonly object: UIKitMLAsset;
  section: HudSection = 'play';
  /** Last status line shown (read by tests). */
  status = '';
  private cleanup: (() => void)[] = [];

  constructor(world: World, h: HudHandlers) {
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
    bind('btn-recenter', h.recenter);
    bind('btn-drop', h.drop);
    bind('btn-publish', h.publish);
    bind('btn-studio-exit', h.studioExit);
    for (const t of ['lamp', 'well', 'hush', 'wall', 'erase'] as const) bind(`tool-${t}`, () => h.tool(t));
    bind('hall-featured', () => h.hallTab('featured'));
    bind('hall-new', () => h.hallTab('new'));
    bind('hall-top', () => h.hallTab('top'));
    bind('hall-back', h.back);
    for (let i = 0; i < HUD_LEVELS; i++) bind(`lvl-${i}`, () => h.pick(i));
    for (let i = 0; i < HALL_ROWS; i++) bind(`hall-${i}`, () => h.hallPick(i));
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
    for (const [name, ids] of Object.entries(SECTIONS)) {
      for (const id of ids) this.set(id, { display: name === section ? 'flex' : 'none' });
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

  /** Glass tokens: `left` of `budget` casts remain. */
  setBudget(left: number, budget: number): void {
    for (let i = 0; i < TOKENS; i++) {
      this.set(`tok-${i}`, {
        display: i < budget ? 'flex' : 'none',
        backgroundColor: i < left ? '#8fd0ff' : 'rgba(143,208,255,0.12)',
      });
    }
  }

  /** One dot per crystal; lit dots glow in the crystal's colour. */
  setMeter(colors: (string | null)[]): void {
    for (let i = 0; i < METER; i++) {
      this.set(`meter-${i}`, {
        display: i < colors.length ? 'flex' : 'none',
        backgroundColor: colors[i] ?? '#c9ccd4',
      });
    }
  }

  setSolved(solved: boolean, hasNext: boolean): void {
    this.set('btn-next', { display: solved && hasNext ? 'flex' : 'none' });
    this.set('btn-hint', { display: solved ? 'none' : 'flex' });
  }

  setMenuState(states: ('solved' | 'open')[], current: number, labels: { daily: string; sound: string; assist: string }): void {
    states.forEach((st, i) => {
      if (i >= HUD_LEVELS) return;
      const bg = i === current ? '#2f6bff' : st === 'solved' ? '#ffd76a' : '#e4e6eb';
      this.set(`lvl-${i}`, { backgroundColor: bg });
      this.set(`lvl-${i}-t`, { color: i === current ? '#ffffff' : '#2a2d33' });
    });
    for (let i = states.length; i < HUD_LEVELS; i++) this.set(`lvl-${i}`, { display: 'none' });
    this.set('btn-daily-label', { text: labels.daily });
    this.set('btn-sound-label', { text: labels.sound });
    this.set('btn-assist-label', { text: labels.assist });
  }

  setStudioStatus(text: string, code = ''): void {
    this.set('studio-status', { text });
    this.set('studio-code', { text: code });
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
