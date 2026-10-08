/**
 * Small additive effects: impact glints where beams strike optics, and a
 * burst of rising motes from each crystal when a puzzle resolves.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color as ThreeColor,
  Group,
  Points,
  PointsMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from '@iwsdk/core';
import { ColorMask } from '../game/types.js';
import { getGlowTexture, lightColor } from './palette.js';

const MAX_MOTES = 240;
const WHITE = new ThreeColor(1, 1, 1);

export class Sparkles {
  readonly group = new Group();
  private glints: Sprite[] = [];
  private glintCount = 0;
  private points: Points;
  private positions = new Float32Array(MAX_MOTES * 3);
  private colors = new Float32Array(MAX_MOTES * 3);
  private velocity = new Float32Array(MAX_MOTES * 3);
  private life = new Float32Array(MAX_MOTES);
  private next = 0;
  private tmp = new ThreeColor();

  constructor(private cell: number) {
    this.group.name = 'sparkles';
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new BufferAttribute(this.colors, 3));
    this.points = new Points(
      geo,
      new PointsMaterial({
        size: cell * 0.16,
        map: getGlowTexture(),
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    this.points.frustumCulled = false;
    this.points.raycast = () => {};
    this.group.add(this.points);
  }

  /** Show a glint at each beam impact point (board-local). */
  setGlints(points: { p: Vector3; color: ColorMask }[]): void {
    while (this.glints.length < points.length) {
      const s = new Sprite(
        new SpriteMaterial({
          map: getGlowTexture(),
          blending: AdditiveBlending,
          transparent: true,
          depthWrite: false,
        }),
      );
      s.raycast = () => {};
      this.group.add(s);
      this.glints.push(s);
    }
    this.glintCount = points.length;
    this.glints.forEach((s, i) => {
      s.visible = i < points.length;
      if (!s.visible) return;
      s.position.copy(points[i].p);
      (s.material as SpriteMaterial).color.copy(lightColor(points[i].color));
    });
  }

  /** Release a burst of motes from a board-local point. */
  burst(at: Vector3, color: ColorMask, count = 40): void {
    const c = lightColor(color);
    for (let i = 0; i < count; i++) {
      const k = this.next;
      this.next = (this.next + 1) % MAX_MOTES;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.25 + 0.05;
      this.positions[k * 3] = at.x;
      this.positions[k * 3 + 1] = at.y;
      this.positions[k * 3 + 2] = at.z;
      this.velocity[k * 3] = Math.cos(a) * r * this.cell * 4;
      this.velocity[k * 3 + 1] = (Math.random() * 1.5 + 1) * this.cell * 6;
      this.velocity[k * 3 + 2] = Math.sin(a) * r * this.cell * 4;
      this.life[k] = 1;
      this.tmp.copy(c).lerp(WHITE, Math.random() * 0.4);
      this.colors[k * 3] = this.tmp.r;
      this.colors[k * 3 + 1] = this.tmp.g;
      this.colors[k * 3 + 2] = this.tmp.b;
    }
  }

  update(dt: number, time: number): void {
    for (let i = 0; i < this.glintCount; i++) {
      const s = this.glints[i];
      s.scale.setScalar(this.cell * (0.5 + 0.12 * Math.sin(time * 9 + i * 1.7)));
    }
    let any = false;
    for (let k = 0; k < MAX_MOTES; k++) {
      if (this.life[k] <= 0) continue;
      any = true;
      this.life[k] -= dt * 0.55;
      const fade = Math.max(0, this.life[k]);
      this.velocity[k * 3 + 1] -= dt * this.cell * 3;
      this.positions[k * 3] += this.velocity[k * 3] * dt;
      this.positions[k * 3 + 1] += this.velocity[k * 3 + 1] * dt;
      this.positions[k * 3 + 2] += this.velocity[k * 3 + 2] * dt;
      if (fade <= 0) this.positions[k * 3 + 1] = -100;
      this.colors[k * 3] *= 0.985 + 0.015 * fade;
      this.colors[k * 3 + 1] *= 0.985 + 0.015 * fade;
      this.colors[k * 3 + 2] *= 0.985 + 0.015 * fade;
    }
    if (any) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as PointsMaterial).dispose();
    for (const s of this.glints) (s.material as SpriteMaterial).dispose();
    this.group.removeFromParent();
  }
}
