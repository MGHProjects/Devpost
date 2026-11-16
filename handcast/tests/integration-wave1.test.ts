/**
 * Wave-1 integration checks across modules: the FK hand + pose library feed
 * hand-features (optic classification) and trace2d (end-to-end light routing),
 * the live tracker's palm frame agrees with hand-features and the glass bake,
 * and the glass bake consumes FK joint orientations in the WebXR convention.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalPose, EXTENDED, type PoseName } from '../src/core/pose-library';
import { computeOptic } from '../src/core/hand-features';
import { traceLevel } from '../src/core/trace2d';
import { FINGER_CHAINS, KNUCKLE, TIP } from '../src/core/joints';
import { Color, type ColorMask, type Crystal, type HandOptic, type HandPose, type Handedness, type LevelDef, type V2 } from '../src/core/types';
import { TrackedHand } from '../src/input/hand-tracker';
import { fistClosed, palmUp } from '../src/input/gestures';
import { parseHandTemplate, type HandTemplate } from '../src/render/glass/hand-model';
import { bakePose, deriveJointRotations } from '../src/render/glass/bake';
import { BIND_LEFT_POS, BIND_LEFT_ROT, BIND_RIGHT_POS, BIND_RIGHT_ROT } from '../src/core/hand-bind';

const HANDS = ['right', 'left'] as const;
const FAN_POSES: PoseName[] = [
  'flat', 'spread', 'point', 'peace', 'three', 'four', 'L', 'shaka', 'rock', 'thumb', 'middle', 'pinky',
];
const YAWS = [-Math.PI / 2, 0.3, 2.4];

function optic(name: PoseName, hand: Handedness, at: V2 = [0, 0], yaw = -Math.PI / 2, id = 'h'): HandOptic {
  return computeOptic(canonicalPose(name, hand, at, yaw), { id, live: false });
}

function level(over: Partial<LevelDef>): LevelDef {
  return {
    v: 1, id: 'it', name: 'it', bench: { w: 0.7, d: 0.6 }, budget: 3,
    lamps: [], wells: [], crystals: [], hush: [], walls: [], mirrors: [], ...over,
  };
}

function along(p: V2, d: V2, t: number): V2 {
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

// ------------------------------------------------------------ (a) optics

describe('FK poses classify as intended (pose-library -> hand-features)', () => {
  for (const hand of HANDS) {
    for (const yaw of YAWS) {
      it.each(FAN_POSES)(`${hand} yaw ${yaw.toFixed(2)}: %s is a fan with exactly its intended ports`, (name) => {
        const o = optic(name, hand, [0.05, -0.02], yaw);
        expect(o.mode).toBe('fan');
        expect(o.ports.slice(0, 5).map((p) => p.open)).toEqual(EXTENDED[name]);
        expect(o.ports[5].open).toBe(true);
        // Wrist port faces away from the fingers.
        expect(o.ports[5].dir[0] * Math.cos(yaw) + o.ports[5].dir[1] * Math.sin(yaw)).toBeLessThan(-0.99);
      });
      it(`${hand} yaw ${yaw.toFixed(2)}: fist is stone, blade is blade`, () => {
        expect(optic('fist', hand, [0, 0], yaw).mode).toBe('stone');
        const b = optic('blade', hand, [0, 0], yaw);
        expect(b.mode).toBe('blade');
        expect(b.mirror).toBeDefined();
        expect(b.ports.every((p) => !p.open)).toBe(true);
      });
    }
  }
});

// ------------------------------------------------------------ (b) tracing

describe('end-to-end light routing with FK casts', () => {
  /** A lamp 12 cm behind the wrist port, aimed straight into it. */
  function lampIntoWrist(o: HandOptic, color: ColorMask = Color.W) {
    const w = o.ports[5];
    const p = along(w.p, w.dir, 0.12);
    return { p, a: Math.atan2(-w.dir[1], -w.dir[0]), color };
  }
  /** A white crystal 15 cm out along each finger's port direction. */
  function fanCrystals(o: HandOptic): Crystal[] {
    return o.ports.slice(0, 5).map((p) => ({ p: along(p.p, p.dir, 0.15), color: Color.W }));
  }

  for (const hand of HANDS) {
    it(`${hand}: lamp into a 'spread' wrist lights all 5 finger crystals`, () => {
      const o = optic('spread', hand, [0, 0.04]);
      const lv = level({ lamps: [lampIntoWrist(o)], crystals: fanCrystals(o) });
      const r = traceLevel(lv, [o]);
      expect(r.crystals.map((c) => c.state)).toEqual(['lit', 'lit', 'lit', 'lit', 'lit']);
      expect(r.solved).toBe(true);
      expect(r.hands[0].inMask[5]).toBe(Color.W);
      expect(r.hands[0].outMask).toEqual([7, 7, 7, 7, 7, 0]);
    });

    it(`${hand}: a 'point' hand lights only the index crystal`, () => {
      const spread = optic('spread', hand, [0, 0.04]);
      const o = optic('point', hand, [0, 0.04]);
      const crystals = fanCrystals(spread);
      crystals[1] = { p: along(o.ports[1].p, o.ports[1].dir, 0.15), color: Color.W };
      const lv = level({ lamps: [lampIntoWrist(o)], crystals });
      const r = traceLevel(lv, [o]);
      expect(r.crystals.map((c) => c.state)).toEqual(['off', 'lit', 'off', 'off', 'off']);
      expect(r.hands[0].outMask).toEqual([0, 7, 0, 0, 0, 0]);
      expect(r.solved).toBe(false);
    });

    it(`${hand}: relay from one hand's index into another hand's wrist`, () => {
      // Hand A points +X; hand B (also pointing +X) is placed so its wrist port sits on A's index ray.
      const a = optic('point', hand, [-0.2, 0.02], 0, 'A');
      const probe = optic('point', hand, [0, 0], 0);
      const aIdx = a.ports[1];
      const wantWrist = along(aIdx.p, aIdx.dir, 0.06);
      const at: V2 = [wantWrist[0] - probe.ports[5].p[0], wantWrist[1] - probe.ports[5].p[1]];
      const b = optic('point', hand, at, 0, 'B');
      const crystal = { p: along(b.ports[1].p, b.ports[1].dir, 0.06), color: Color.C };
      const lv = level({ lamps: [lampIntoWrist(a, Color.C)], crystals: [crystal] });
      const r = traceLevel(lv, [a, b]);
      expect(r.crystals[0].state).toBe('lit');
      expect(r.solved).toBe(true);
      const ioA = r.hands.find((h) => h.id === 'A')!;
      const ioB = r.hands.find((h) => h.id === 'B')!;
      expect(ioA.outMask[1]).toBe(Color.C);
      expect(ioB.inMask[5]).toBe(Color.C);
      expect(ioB.outMask[1]).toBe(Color.C);
      // Reveal distance grows along the relay.
      const fromB = r.segments.filter((s) => Math.hypot(s.a[0] - b.ports[1].p[0], s.a[1] - b.ports[1].p[1]) < 0.02);
      const fromA = r.segments.filter((s) => Math.hypot(s.a[0] - aIdx.p[0], s.a[1] - aIdx.p[1]) < 0.02);
      expect(fromA.length).toBeGreaterThan(0);
      expect(fromB.length).toBeGreaterThan(0);
      expect(fromB[0].d0).toBeGreaterThan(fromA[0].d0);
      // Perfectly aimed: aim assist must not bend or flag it.
      expect(fromA[0].assisted).toBeUndefined();
    });
  }
});

// ------------------------------------------------------------ (c) palm frame

describe('tracker palm normal agrees with hand-features and gestures', () => {
  function track(pose: HandPose): TrackedHand {
    const t = new TrackedHand(pose.hand);
    for (let i = 0; i < 75; i++) t.rawBench[i] = pose.pos[i];
    for (let i = 0; i < 100; i++) t.rawRotBench[i] = pose.rot![i];
    t.ingest(1 / 72);
    return t;
  }
  for (const hand of HANDS) {
    it(`${hand}: palm down -> -Y, palm up -> +Y, blade -> horizontal`, () => {
      const down = track(canonicalPose('flat', hand, [0, 0]));
      expect(down.palm.normal[1]).toBeLessThan(-0.95);
      expect(palmUp(down.palm.normal)).toBe(false);
      expect(down.palm.axis[2]).toBeLessThan(-0.99);

      const upPose = canonicalPose('flat', hand, [0, 0], undefined, { roll: Math.PI, lift: 0.06 });
      const up = track(upPose);
      expect(up.palm.normal[1]).toBeGreaterThan(0.95);
      expect(palmUp(up.palm.normal)).toBe(true);
      // hand-features also reads a palm-up flat hand as an (upturned) fan.
      expect(computeOptic(upPose, { id: 'u', live: true }).mode).toBe('fan');

      // Blade: palm faces the thumb's original side (-X right, +X left).
      const blade = track(canonicalPose('blade', hand, [0, 0]));
      expect(Math.abs(blade.palm.normal[1])).toBeLessThan(0.35);
      expect(blade.palm.normal[0] * (hand === 'right' ? -1 : 1)).toBeGreaterThan(0.9);
    });

    it(`${hand}: palm normal is opposite the FK wrist joint's +Y (dorsal)`, () => {
      for (const roll of [0, 0.7, Math.PI / 2, Math.PI]) {
        const pose = canonicalPose('flat', hand, [0, 0], 0.4, { roll, lift: 0.07 });
        const t = track(pose);
        const [x, y, z, w] = Array.from(pose.rot!.slice(0, 4));
        // Wrist local +Y in bench space.
        const uy: [number, number, number] = [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)];
        const d = uy[0] * t.palm.normal[0] + uy[1] * t.palm.normal[1] + uy[2] * t.palm.normal[2];
        expect(d).toBeLessThan(-0.9);
      }
    });

    it(`${hand}: the tracker's live pose classifies like the FK pose it was fed`, () => {
      for (const name of ['point', 'peace', 'fist', 'blade'] as PoseName[]) {
        const pose = canonicalPose(name, hand, [0.02, 0.01], 0.3);
        const live = computeOptic(track(pose).toPose(), { id: 'live', live: true });
        const cast = computeOptic(pose, { id: 'cast', live: false });
        expect(live.mode).toBe(cast.mode);
        expect(live.ports.map((p) => p.open)).toEqual(cast.ports.map((p) => p.open));
      }
    });

    it(`${hand}: gestures' fist test agrees with hand-features on fist / flat`, () => {
      expect(fistClosed(canonicalPose('fist', hand, [0, 0]).pos)).toBe(true);
      expect(fistClosed(canonicalPose('flat', hand, [0, 0]).pos)).toBe(false);
    });
  }
});

// ------------------------------------------------------------ (d) glass bake

describe('glass bake consumes FK orientations (WebXR convention)', () => {
  const templates: Partial<Record<Handedness, HandTemplate>> = {};
  beforeAll(async () => {
    for (const hand of HANDS) {
      const buf = readFileSync(resolve(__dirname, '../public/models', `${hand}.glb`));
      templates[hand] = await parseHandTemplate(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, hand);
    }
  }, 30000);

  /** Farthest-from-knuckle vertex skinned mostly to finger f's distal bone / tip. */
  function tipVertex(t: HandTemplate, baked: ArrayLike<number>, pose: HandPose, f: number): number[] {
    const chain = FINGER_CHAINS[f];
    const distal = chain[chain.length - 2];
    const tip = chain[chain.length - 1];
    const k = KNUCKLE[f];
    let best = -1, bestD = -1;
    for (let v = 0; v < t.vertexCount; v++) {
      let w = 0;
      for (let i = 0; i < 4; i++) {
        const j = t.skinIndex[v * 4 + i];
        if (j === distal || j === tip) w += t.skinWeight[v * 4 + i];
      }
      if (w < 0.6) continue;
      const d = Math.hypot(baked[v * 3] - pose.pos[k * 3], baked[v * 3 + 1] - pose.pos[k * 3 + 1],
        baked[v * 3 + 2] - pose.pos[k * 3 + 2]);
      if (d > bestD) { bestD = d; best = v; }
    }
    return [baked[best * 3], baked[best * 3 + 1], baked[best * 3 + 2]];
  }

  function jointDist(p: number[], pose: HandPose, j: number): number {
    return Math.hypot(p[0] - pose.pos[j * 3], p[1] - pose.pos[j * 3 + 1], p[2] - pose.pos[j * 3 + 2]);
  }

  for (const hand of HANDS) {
    it(`${hand}: the FK hand and the glass template share the same GLB bind skeleton`, () => {
      const t = templates[hand]!;
      const pos = hand === 'right' ? BIND_RIGHT_POS : BIND_LEFT_POS;
      const rot = hand === 'right' ? BIND_RIGHT_ROT : BIND_LEFT_ROT;
      for (let i = 0; i < 75; i++) expect(Math.abs(t.bindPos[i] - pos[i])).toBeLessThan(1e-5);
      for (let j = 0; j < 25; j++) {
        const d = Math.abs(t.bindRot[j * 4] * rot[j * 4] + t.bindRot[j * 4 + 1] * rot[j * 4 + 1] +
          t.bindRot[j * 4 + 2] * rot[j * 4 + 2] + t.bindRot[j * 4 + 3] * rot[j * 4 + 3]);
        expect(d).toBeGreaterThan(1 - 1e-5);
      }
    });

    it(`${hand}: template bind frames follow the WebXR convention (-Z along bone, +Y dorsal)`, () => {
      const t = templates[hand]!;
      const bp = t.bindPos, br = t.bindRot;
      for (const chain of FINGER_CHAINS) {
        for (let k = 0; k < chain.length - 1; k++) {
          const j = chain[k], c = chain[k + 1];
          const [x, y, z, w] = [br[j * 4], br[j * 4 + 1], br[j * 4 + 2], br[j * 4 + 3]];
          const negZ = [-(2 * (x * z + y * w)), -(2 * (y * z - x * w)), -(1 - 2 * (x * x + y * y))];
          const b = [bp[c * 3] - bp[j * 3], bp[c * 3 + 1] - bp[j * 3 + 1], bp[c * 3 + 2] - bp[j * 3 + 2]];
          const bl = Math.hypot(b[0], b[1], b[2]);
          expect((negZ[0] * b[0] + negZ[1] * b[1] + negZ[2] * b[2]) / bl).toBeGreaterThan(Math.cos(15 * Math.PI / 180));
        }
      }
      // +Y of the wrist and long-finger base joints points out of the back of the hand.
      const u = [bp[18] - bp[0], bp[19] - bp[1], bp[20] - bp[2]];
      const v = [bp[63] - bp[0], bp[64] - bp[1], bp[65] - bp[2]];
      const sgn = hand === 'left' ? -1 : 1;
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]].map((c) => c * sgn);
      const nl = Math.hypot(n[0], n[1], n[2]);
      for (const j of [0, 5, 6, 10, 11, 15, 16, 20, 21]) {
        const [x, y, z, w] = [br[j * 4], br[j * 4 + 1], br[j * 4 + 2], br[j * 4 + 3]];
        const py = [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)];
        expect((py[0] * n[0] + py[1] * n[1] + py[2] * n[2]) / nl).toBeLessThan(-0.8);
      }
    });

    it(`${hand}: baking an FK 'point' puts the index fingertip mesh at the FK index tip`, () => {
      const t = templates[hand]!;
      const pose = canonicalPose('point', hand, [0.03, -0.01], 0.4);
      const g = bakePose(t, pose);
      const baked = g.getAttribute('position').array;
      const p = tipVertex(t, baked, pose, 1);
      expect(jointDist(p, pose, TIP[1])).toBeLessThan(0.015);
      // The fingertip skin sits ABOVE the bench, i.e. dorsal side up is respected.
      let minY = Infinity;
      for (let i = 1; i < baked.length; i += 3) minY = Math.min(minY, baked[i]);
      expect(minY).toBeGreaterThan(-0.004);
    });

    it(`${hand}: every fingertip of FK flat / fist / blade bakes onto its FK tip joint`, () => {
      const t = templates[hand]!;
      for (const name of ['flat', 'fist', 'blade', 'L'] as PoseName[]) {
        const pose = canonicalPose(name, hand, [0, 0], -1.2);
        const baked = bakePose(t, pose).getAttribute('position').array;
        for (let f = 0; f < 5; f++) {
          expect(jointDist(tipVertex(t, baked, pose, f), pose, TIP[f])).toBeLessThan(0.015);
        }
      }
    });

    it(`${hand}: FK rotations agree with rotations derived from FK positions`, () => {
      const t = templates[hand]!;
      for (const name of ['flat', 'point', 'blade'] as PoseName[]) {
        const pose = canonicalPose(name, hand, [0, 0], 0.4);
        const derived = deriveJointRotations(t, pose.pos);
        // Long-finger and wrist joints: the derived frame (no invented twist) stays within 25 deg of FK.
        for (const j of [0, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22, 23]) {
          const fk = pose.rot!;
          const d = Math.abs(fk[j * 4] * derived[j * 4] + fk[j * 4 + 1] * derived[j * 4 + 1] +
            fk[j * 4 + 2] * derived[j * 4 + 2] + fk[j * 4 + 3] * derived[j * 4 + 3]);
          expect(2 * Math.acos(Math.min(1, d))).toBeLessThan(25 * Math.PI / 180);
        }
      }
    });
  }
});
