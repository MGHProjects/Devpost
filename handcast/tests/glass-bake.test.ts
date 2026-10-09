/**
 * Glass-hand bake (src/render/glass/bake.ts) against the real generic-hand
 * GLBs, in node (no WebGL): bind pose reproduces the mesh, translations carry
 * through, rotation derivation is consistent, glass attributes are sane.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseHandTemplate, type HandTemplate } from '../src/render/glass/hand-model';
import { bakePose, deriveJointRotations } from '../src/render/glass/bake';
import type { HandPose, Handedness } from '../src/core/types';
import { TIP } from '../src/core/joints';
import { canonicalPose } from '../src/core/pose-library';

const MODELS = resolve(__dirname, '../public/models');

async function load(hand: Handedness): Promise<HandTemplate> {
  const buf = readFileSync(resolve(MODELS, `${hand}.glb`));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return parseHandTemplate(ab, hand);
}

function bindPose(t: HandTemplate): HandPose {
  return { hand: t.hand, pos: Array.from(t.bindPos), rot: Array.from(t.bindRot) };
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>, shift = [0, 0, 0]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i] - shift[i % 3]));
  return m;
}

const templates: Partial<Record<Handedness, HandTemplate>> = {};

beforeAll(async () => {
  templates.right = await load('right');
  templates.left = await load('left');
}, 30000);

describe.each(['right', 'left'] as const)('%s hand', (hand) => {
  it('bind pose reproduces the original mesh', () => {
    const t = templates[hand]!;
    const g = bakePose(t, bindPose(t));
    const p = g.getAttribute('position').array;
    expect(p.length).toBe(t.vertexCount * 3);
    const orig = t.geometry.getAttribute('position').array;
    expect(maxDiff(p, orig)).toBeLessThan(1e-4);
  });

  it('translating every bone translates every vertex', () => {
    const t = templates[hand]!;
    const pose = bindPose(t);
    const pos = pose.pos as number[];
    for (let j = 0; j < 25; j++) pos[j * 3] += 1;
    const g = bakePose(t, pose);
    expect(maxDiff(g.getAttribute('position').array, t.positions, [1, 0, 0])).toBeLessThan(1e-4);
  });

  it('origin and inflation options', () => {
    const t = templates[hand]!;
    const g0 = bakePose(t, bindPose(t));
    const g = bakePose(t, bindPose(t), { origin: [0.1, 0.2, 0.3], inflate: 0.002 });
    const a = g0.getAttribute('position').array;
    const n = g0.getAttribute('normal').array;
    const b = g.getAttribute('position').array;
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(b[i] - (a[i] + n[i] * 0.002 - [0.1, 0.2, 0.3][i % 3])));
    expect(m).toBeLessThan(1e-5);
    // Normals are unit and point outward on average (away from the centroid).
    let out = 0;
    const c = [0, 0, 0];
    for (let i = 0; i < a.length; i++) c[i % 3] += a[i] / t.vertexCount;
    for (let v = 0; v < t.vertexCount; v++) {
      const d = (a[v * 3] - c[0]) * n[v * 3] + (a[v * 3 + 1] - c[1]) * n[v * 3 + 1] + (a[v * 3 + 2] - c[2]) * n[v * 3 + 2];
      if (d > 0) out++;
      expect(Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2])).toBeCloseTo(1, 4);
    }
    expect(out / t.vertexCount).toBeGreaterThan(0.75);
  });

  it('derived rotations reproduce the bind pose and follow an FK pose', () => {
    const t = templates[hand]!;
    const r = deriveJointRotations(t, t.bindPos);
    for (let i = 0; i < 100; i++) expect(r[i]).toBeCloseTo(t.bindRot[i], 5);
    // FK pose baked with its own rotations vs. with rotations derived from positions.
    const pose = canonicalPose('peace', hand, [0, 0]);
    const withRot = bakePose(t, pose).getAttribute('position').array;
    const noRot = bakePose(t, { hand, pos: pose.pos }).getAttribute('position').array;
    // Fingers match closely; the thumb's opposition roll (a twist) is not
    // recoverable from positions alone, so only the mean is bounded there.
    let mean = 0;
    for (let v = 0; v < t.vertexCount; v++) {
      const d = Math.hypot(withRot[v * 3] - noRot[v * 3], withRot[v * 3 + 1] - noRot[v * 3 + 1], withRot[v * 3 + 2] - noRot[v * 3 + 2]);
      mean += d / t.vertexCount;
      const f = t.aFinger[v];
      if (f >= 1 && f <= 4) expect(d).toBeLessThan(0.004);
    }
    expect(mean).toBeLessThan(0.003);
    for (let i = 0; i < noRot.length; i++) expect(Number.isFinite(noRot[i])).toBe(true);
  });

  it('subdivided bake is finite, smooth-shaded and keeps the glass attributes', () => {
    const t = templates[hand]!;
    const g = bakePose(t, canonicalPose('point', hand, [0.05, -0.02]), { subdivide: 1, origin: [0.05, 0, -0.02] });
    const p = g.getAttribute('position').array;
    const tris = g.getIndex()!.count / 3;
    expect(tris).toBe((t.index.length / 3) * 4);
    for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i])).toBe(true);
    const along = g.getAttribute('aAlong').array;
    for (let i = 0; i < along.length; i++) {
      expect(along[i]).toBeGreaterThanOrEqual(0);
      expect(along[i]).toBeLessThanOrEqual(1);
    }
    expect(g.getAttribute('aVein').count).toBe(along.length);
    // Hand sits over the foot point: bounding box straddles x = z = 0 and rests above the bench.
    const bb = g.boundingBox!;
    expect(bb.min.x).toBeLessThan(0);
    expect(bb.max.x).toBeGreaterThan(0);
    expect(bb.min.y).toBeGreaterThan(-0.005);
  });

  it('aAlong runs wrist -> fingertips; aFinger marks the fingers', () => {
    const t = templates[hand]!;
    const g = t.geometry;
    const along = g.getAttribute('aAlong').array;
    const finger = g.getAttribute('aFinger').array;
    const p = t.positions;
    const bp = t.bindPos;
    const near = (v: number, j: number, r: number): boolean =>
      Math.hypot(p[v * 3] - bp[j * 3], p[v * 3 + 1] - bp[j * 3 + 1], p[v * 3 + 2] - bp[j * 3 + 2]) < r;
    let wrist = 0, tips = 0, indexTip = 0;
    for (let v = 0; v < t.vertexCount; v++) {
      expect(along[v]).toBeGreaterThanOrEqual(0);
      expect(along[v]).toBeLessThanOrEqual(1);
      if (near(v, 0, 0.025)) { wrist++; expect(along[v]).toBeLessThan(0.25); }
      for (const tip of TIP) if (near(v, tip, 0.008)) { tips++; expect(along[v]).toBeGreaterThan(0.85); }
      if (near(v, 9, 0.008)) { indexTip++; expect(finger[v]).toBe(1); }
    }
    expect(wrist).toBeGreaterThan(10);
    expect(tips).toBeGreaterThan(10);
    expect(indexTip).toBeGreaterThan(2);
    // Every finger and the palm own some vertices.
    const counts = [0, 0, 0, 0, 0, 0];
    for (let v = 0; v < t.vertexCount; v++) counts[finger[v]]++;
    for (const c of counts) expect(c).toBeGreaterThan(20);
  });

  it('aAlong is smooth across triangle edges', () => {
    const t = templates[hand]!;
    const along = t.aAlong;
    let worst = 0;
    for (let i = 0; i < t.index.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = t.index[i + k], b = t.index[i + (k + 1) % 3];
        worst = Math.max(worst, Math.abs(along[a] - along[b]));
      }
    }
    expect(worst).toBeLessThan(0.2);
  });
});
