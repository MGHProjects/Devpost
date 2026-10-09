/**
 * Molten coat on the LIVE hand while a cast sets: a clone of the live
 * generic-hand SkinnedMesh (sharing its skeleton and bind matrix, like
 * IWSDK's AnimatedHand outline) drawn with the glass material, which switches
 * three's skinning chunks on for skinned meshes. The coat sits a couple of mm
 * outside the skin (uInflate) and uses the same molten-front logic as the
 * casts: invisible ahead of the front, white-hot -> amber -> clear behind it.
 *
 * The live mesh's geometry gets aAlong / aFinger / aVein added in place (the
 * coat shares that geometry, so disposing the coat never frees it).
 */
import { FrontSide, type Color, type SkinnedMesh } from '@iwsdk/core';
import { createGlassMaterial, type GlassMaterial } from './glass-material';
import { ensureGlassAttributes } from './hand-model';

export interface CoatMesh {
  mesh: SkinnedMesh;
  material: GlassMaterial;
  /** front: molten front along aAlong (0 wrist .. 1 tips); heat: 0..1 glow. */
  setMolten(front: number, heat: number): void;
  /** Light carried by a finger while casting (null = dark). */
  setFingerLight(finger: number, color: Color | null): void;
  update(time: number): void;
  /** Shows or hides the coat (hidden when no cast is in progress). */
  setVisible(on: boolean): void;
  dispose(): void;
}

export interface CoatOptions {
  /** Shell offset outside the skin, metres (default 0.002). */
  inflate?: number;
  /** Render order (default 1000: after IWSDK's hand outline at 999). */
  renderOrder?: number;
}

export function createCoatMesh(live: SkinnedMesh, opts: CoatOptions = {}): CoatMesh {
  ensureGlassAttributes(live);
  const material = createGlassMaterial('glass', { side: FrontSide });
  const u = material.uniforms;
  u.uInflate.value = opts.inflate ?? 0.002;
  u.uMolten.value = 0;
  u.uHeat.value = 1;

  // SkinnedMesh.clone() shares the geometry, skeleton and bind matrix.
  const mesh = live.clone() as SkinnedMesh;
  mesh.material = material;
  mesh.name = 'glass-coat';
  mesh.frustumCulled = false;
  mesh.renderOrder = opts.renderOrder ?? 1000;
  mesh.visible = false;
  live.parent?.add(mesh);

  return {
    mesh,
    material,
    setMolten(front, heat) {
      u.uMolten.value = front;
      u.uHeat.value = heat;
    },
    setFingerLight(finger, color) {
      const c = u.uFingerLight.value[finger];
      if (color) c.copy(color); else c.setRGB(0, 0, 0);
      const palm = u.uPalmLight.value.setRGB(0, 0, 0);
      for (let i = 0; i < 5; i++) {
        const f = u.uFingerLight.value[i];
        palm.setRGB(Math.max(palm.r, f.r), Math.max(palm.g, f.g), Math.max(palm.b, f.b));
      }
    },
    update(time) {
      u.uTime.value = time;
    },
    setVisible(on) {
      mesh.visible = on;
    },
    dispose() {
      mesh.removeFromParent();
      material.dispose();
    },
  };
}
