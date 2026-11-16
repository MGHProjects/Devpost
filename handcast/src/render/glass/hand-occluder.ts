/**
 * Puts the player's REAL hand in front of the light in passthrough.
 *
 * IWSDK's generic hand draws an invisible depth-writing "stencil" skin plus a
 * white outline clone at renderOrder 999. Both are transparent materials, so
 * they sort by renderOrder in the transparent pass. At the default order 0 the
 * stencil comes after the bench (slab -11/-10, recess, pool and spill -6..-4):
 * the dark slab and the pool are already painted where the real hand is, and
 * only later content (beams, crystals, glass) is hidden behind it.
 *
 * Here the stencil becomes an opaque, depth-only pre-pass (no colour write)
 * at renderOrder -20: opaque meshes draw before every transparent one, so it
 * now comes before the opaque bench props (crystals, lamps, pillars) as well
 * as the transparent slab, pool and beams, and nothing behind the real hand is
 * painted over it. It sits a little outside the skin rather than inside it so
 * tracking lag does not leave the slab bleeding over finger edges. Side
 * effect: the dimming dome does not darken the hand either, so the real hand
 * reads a touch brighter than the dimmed room. The white outline is hidden:
 * the real hand is visible, and a grown stencil would only leave slivers of it
 * (the "stray white strokes").
 *
 * In the IWER emulator there is no real hand behind the canvas, only a
 * synthetic room, so the stock order is kept there and the outline stays the
 * hand's only visual.
 */
import { outlineMaterial, stencilMaterial, type SkinnedMesh } from '@iwsdk/core';

/** First in the opaque pass, so before every bench mesh. */
export const HAND_OCCLUDER_ORDER = -20;
/**
 * Shell offset: negative grows the stencil outside the skin (IWSDK: +1.2 mm
 * inside). 3.5 mm after the first Quest 3 session, where 1.5 mm let the bench
 * cut into real fingertips (real fingers outgrow the generic mesh, plus lag).
 * The molten coat sits outside it (coat-material, 4.5 mm).
 */
const OCCLUDER_GROW = -0.0035;
let patched = false;

function patchMaterials(): void {
  if (patched) return;
  patched = true;
  stencilMaterial.uniforms.outlineThickness.value = OCCLUDER_GROW;
  stencilMaterial.transparent = false;
  stencilMaterial.colorWrite = false;
  stencilMaterial.needsUpdate = true;
}

/**
 * True when running in IWSDK's IWER emulator (no real hands, no passthrough).
 * `?occlude` forces the passthrough ordering there, to inspect it.
 */
export function isEmulated(): boolean {
  if (typeof window === 'undefined') return false;
  if (new URLSearchParams(window.location.search).has('occlude')) return false;
  return !!(window as unknown as { IWER_DEVICE?: unknown }).IWER_DEVICE;
}

/**
 * Reorders one generic-hand model (its stencil skin is `skin`). Idempotent;
 * returns false in the emulator, where nothing is changed.
 */
export function promoteHandOccluder(skin: SkinnedMesh): boolean {
  if (isEmulated()) return false;
  patchMaterials();
  skin.renderOrder = HAND_OCCLUDER_ORDER;
  for (const o of skin.parent?.children ?? []) {
    if ((o as SkinnedMesh).material === outlineMaterial) o.visible = false;
  }
  return true;
}
