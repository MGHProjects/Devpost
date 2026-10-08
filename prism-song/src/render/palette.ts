import { CanvasTexture, Color as ThreeColor } from '@iwsdk/core';
import { ColorMask } from '../game/types.js';

/** Display colours for each light mask; tuned to read over passthrough. */
const HEX: Record<number, number> = {
  0: 0x2a2f3a,
  1: 0xff4d5e, // red
  2: 0x3dff8b, // green
  4: 0x4d8dff, // blue
  3: 0xffe14d, // yellow
  5: 0xff4dff, // magenta
  6: 0x4dfff3, // cyan
  7: 0xfff6e8, // white
};

const cache = new Map<number, ThreeColor>();

export function lightColor(mask: ColorMask): ThreeColor {
  let c = cache.get(mask);
  if (!c) {
    c = new ThreeColor(HEX[mask] ?? 0xffffff);
    cache.set(mask, c);
  }
  return c;
}

let glowTexture: CanvasTexture | null = null;

/** Soft radial falloff used by every additive glow sprite. */
export function getGlowTexture(): CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}
