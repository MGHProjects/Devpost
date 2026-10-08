/**
 * Thin wrapper over the UIKitML HUD: text updates, section toggling and
 * button wiring. Game logic lives in GameSystem; this file only knows ids.
 */

import { UIKitMLAsset, World } from '@iwsdk/core';

type El = {
  setProperties(props: Record<string, unknown>): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

export interface HudHandlers {
  reset(): void;
  hint(): void;
  next(): void;
  openMenu(): void;
  closeMenu(): void;
  pick(levelIndex: number): void;
  daily(): void;
  toggleSound(): void;
}

const METER = 5;
const LEVELS = 24;

export class Hud {
  readonly object: UIKitMLAsset;
  private cleanup: (() => void)[] = [];

  constructor(world: World, handlers: HudHandlers) {
    this.object = world.requireSceneObject<UIKitMLAsset>('hud');
    const bind = (id: string, fn: () => void) => {
      const el = this.el(id);
      if (!el) return;
      el.addEventListener('click', fn);
      this.cleanup.push(() => el.removeEventListener('click', fn));
    };
    bind('btn-reset', handlers.reset);
    bind('btn-hint', handlers.hint);
    bind('btn-next', handlers.next);
    bind('btn-menu', handlers.openMenu);
    bind('btn-back', handlers.closeMenu);
    bind('btn-daily', handlers.daily);
    bind('btn-sound', handlers.toggleSound);
    for (let i = 0; i < LEVELS; i++) bind(`lvl-${i}`, () => handlers.pick(i));
  }

  private el(id: string): El | null {
    return this.object.getElementById(id) as unknown as El | null;
  }

  private set(id: string, props: Record<string, unknown>): void {
    this.el(id)?.setProperties(props);
  }

  setLevel(eyebrow: string, title: string, status: string): void {
    this.set('hud-eyebrow', { text: eyebrow });
    this.set('hud-title', { text: title });
    this.set('hud-status', { text: status });
  }

  setStatus(status: string): void {
    this.set('hud-status', { text: status });
  }

  /** One dot per crystal: lit dots glow in the crystal's colour. */
  setMeter(colors: (string | null)[]): void {
    for (let i = 0; i < METER; i++) {
      const c = colors[i];
      this.set(`meter-${i}`, {
        display: i < colors.length ? 'flex' : 'none',
        backgroundColor: c ?? '#c9ccd4',
      });
    }
  }

  setSolved(solved: boolean, hasNext: boolean): void {
    this.set('btn-next', { display: solved && hasNext ? 'flex' : 'none' });
    this.set('btn-hint', { display: solved ? 'none' : 'flex' });
  }

  showMenu(show: boolean): void {
    this.set('play', { display: show ? 'none' : 'flex' });
    this.set('play-actions', { display: show ? 'none' : 'flex' });
    this.set('menu', { display: show ? 'flex' : 'none' });
    this.set('menu-actions', { display: show ? 'flex' : 'none' });
  }

  /** Paint the puzzle grid: solved, current, locked or open. */
  setMenuState(
    states: ('solved' | 'open' | 'locked')[],
    current: number,
    dailyLabel: string,
    soundOn: boolean,
  ): void {
    states.forEach((st, i) => {
      const bg =
        i === current
          ? '#2f6bff'
          : st === 'solved'
            ? '#ffd76a'
            : st === 'open'
              ? '#e4e6eb'
              : '#9aa0ab';
      this.set(`lvl-${i}`, { backgroundColor: bg });
      this.set(`lvl-${i}-t`, {
        color: i === current ? '#ffffff' : st === 'locked' ? '#5c616b' : '#2a2d33',
      });
    });
    this.set('btn-daily-label', { text: dailyLabel });
    this.set('btn-sound-label', { text: soundOn ? 'Sound on' : 'Sound off' });
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }
}
