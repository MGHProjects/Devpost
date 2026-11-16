/**
 * Community layer: cast privacy (retargeting to canonical bone lengths),
 * moderation and publish checks, the curated shelf (featured.json matches the
 * boards built in code, every board solves), and the HallClient's offline
 * fallbacks with mocked fetch + storage.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HallClient, MemoryStorage, type HallEntry } from '../src/community/client';
import { buildFeaturedEntries, buildFeaturedLevels, loadFeatured } from '../src/community/featured';
import { castToPose, decodeLevel, parseShareHash, poseToCast } from '../src/core/codec';
import { restPose } from '../src/core/fk-hand';
import { DEFAULT_RADII } from '../src/core/hand-bind';
import { computeOptic } from '../src/core/hand-features';
import { BONES } from '../src/core/joints';
import {
  checkLevelPublishable, generateHandle, generateLevelTitle, isOffensiveCast, poseFingerprint, sanitizeForPublish,
  verifySolution,
} from '../src/core/moderation';
import { canonicalPose, POSE_NAMES, type PoseName } from '../src/core/pose-library';
import { anonymizeCast, retargetCast } from '../src/core/privacy';
import { Color, type HandPose, type Handedness, type LevelDef } from '../src/core/types';

const HANDS: Handedness[] = ['right', 'left'];

function boneLengths(pos: ArrayLike<number>): number[] {
  return BONES.map(([a, b]) => Math.hypot(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]));
}

/** Every bone vector scaled by k about the wrist (a bigger hand, same joint rotations). */
function scaled(pose: HandPose, k: number): HandPose {
  const pos = Array.from(pose.pos);
  for (let j = 1; j < 25; j++) for (let i = 0; i < 3; i++) pos[j * 3 + i] = pos[i] + (pos[j * 3 + i] - pos[i]) * k;
  return { hand: pose.hand, pos, rot: pose.rot, radii: Array.from(pose.radii ?? DEFAULT_RADII).map((r) => r * k) };
}

function opticSig(pose: HandPose) {
  const o = computeOptic(pose, { id: 'x', live: false });
  return { mode: o.mode, open: o.ports.map((p) => p.open) };
}

// ------------------------------------------------------------------ privacy

describe('privacy: retargetCast', () => {
  const NAMES: PoseName[] = ['flat', 'point', 'peace', 'L', 'shaka', 'blade', 'fist', 'relaxed', 'claw'];

  for (const hand of HANDS) {
    it(`${hand}: FK poses (already canonical) are unchanged`, () => {
      for (const name of NAMES) {
        const pose = canonicalPose(name, hand, [0.04, -0.03], 0.7);
        const r = retargetCast(pose);
        for (let i = 0; i < 75; i++) expect(Math.abs(r.pos[i] - pose.pos[i])).toBeLessThan(1e-5);
      }
    });

    it(`${hand}: a hand 15% bigger comes back with canonical lengths and the same optics`, () => {
      const canon = boneLengths(restPose(hand).pos);
      for (const name of NAMES) {
        const pose = canonicalPose(name, hand, [-0.02, 0.05], -1.9);
        const big = scaled(pose, 1.15);
        expect(boneLengths(big.pos)[5]).toBeCloseTo(canon[5] * 1.15, 5);
        const r = retargetCast(big);
        boneLengths(r.pos).forEach((l, i) => expect(l).toBeCloseTo(canon[i], 4));
        for (let i = 0; i < 3; i++) expect(r.pos[i]).toBeCloseTo(pose.pos[i], 6); // wrist kept
        for (let i = 0; i < 75; i++) expect(Math.abs(r.pos[i] - pose.pos[i])).toBeLessThan(1e-5);
        expect(Array.from(r.radii!)).toEqual(Array.from(Float32Array.from(DEFAULT_RADII)));
        expect(Array.from(r.rot!)).toEqual(Array.from(pose.rot!));
        expect(opticSig(r)).toEqual(opticSig(pose));
      }
    });
  }

  it('without rotations, keeps bone directions and resets lengths', () => {
    const pose = canonicalPose('peace', 'right', [0, 0]);
    const big = scaled(pose, 0.88);
    delete big.rot;
    const r = retargetCast(big);
    for (let i = 0; i < 75; i++) expect(Math.abs(r.pos[i] - pose.pos[i])).toBeLessThan(1e-5);
    expect(r.rot).toBeUndefined();
  });

  it('anonymizeCast is idempotent and keeps tints and optics', () => {
    const pose = scaled(canonicalPose('three', 'left', [0.05, 0.01], -1.1), 1.12);
    const cast = poseToCast(pose, [1, 2, 4, 7, 7]);
    const a = anonymizeCast(cast);
    expect(anonymizeCast(a)).toEqual(a);
    expect(a.tints).toEqual([1, 2, 4, 7, 7]);
    expect(opticSig(castToPose(a))).toEqual(opticSig(pose));
    const canon = boneLengths(restPose('left').pos);
    boneLengths(castToPose(a).pos).forEach((l, i) => expect(Math.abs(l - canon[i])).toBeLessThan(0.0015));
  });
});

// ------------------------------------------------------------------ moderation

describe('moderation', () => {
  it('flags the middle finger alone, in any orientation, and nothing else in the pose library', () => {
    for (const hand of HANDS) {
      for (const yaw of [-Math.PI / 2, 0, 2.2]) {
        for (const roll of [0, Math.PI / 2, Math.PI]) {
          expect(isOffensiveCast(canonicalPose('middle', hand, [0, 0], yaw, { roll }))).toBe(true);
        }
        // Thumb out too still counts.
        expect(isOffensiveCast(canonicalPose('middle', hand, [0, 0], yaw, { curl: [0, 1, 0, 1, 1], thumbAbduct: 1 }))).toBe(true);
        for (const name of POSE_NAMES.filter((n) => n !== 'middle')) {
          expect(isOffensiveCast(canonicalPose(name, hand, [0, 0], yaw)), name).toBe(false);
        }
      }
    }
  });

  const base = (): LevelDef => buildFeaturedLevels()[0];

  it('accepts the shelf boards and enforces limits', () => {
    for (const l of buildFeaturedLevels()) expect(checkLevelPublishable(l)).toEqual({ ok: true });
    const l = base();
    expect(checkLevelPublishable({ ...l, budget: 13 }).ok).toBe(false);
    expect(checkLevelPublishable({ ...l, crystals: [] }).ok).toBe(false);
    expect(checkLevelPublishable({ ...l, crystals: Array.from({ length: 25 }, () => ({ p: [0, 0] as [number, number], color: 1 })) }).reason)
      .toMatch(/crystals/);
    expect(checkLevelPublishable({ ...l, solution: undefined }).reason).toMatch(/solution/);
    expect(checkLevelPublishable({ ...l, budget: 1, solution: [...l.solution!, ...l.solution!] }).ok).toBe(false);
    expect(checkLevelPublishable({ ...l, lamps: [{ ...l.lamps[0], color: 0 }] }).ok).toBe(false);
    expect(checkLevelPublishable({ ...l, crystals: [{ p: [0.4, 0], color: 1 }] }).reason).toMatch(/crystal/);
    expect(checkLevelPublishable({ ...l, bench: { w: 3, d: 0.3 } }).ok).toBe(false);
    expect(checkLevelPublishable({ ...l, name: 'x'.repeat(200) }).ok).toBe(false);
    const rude = poseToCast(canonicalPose('middle', 'right', [0, 0.07]));
    expect(checkLevelPublishable({ ...l, solution: [rude] }).reason).toMatch(/offensive/);
  });

  it('verifySolution re-traces within budget', () => {
    const l = base();
    expect(verifySolution(l, l.solution!).ok).toBe(true);
    const fist = poseToCast(canonicalPose('fist', 'right', [0, 0.07]));
    expect(verifySolution(l, [fist]).ok).toBe(false);
    expect(verifySolution(l, [l.solution![0], l.solution![0]]).reason).toMatch(/budget/);
  });

  it('fingerprints hand shapes, not positions or handedness', () => {
    const a = poseToCast(canonicalPose('point', 'right', [0, 0.07]));
    const b = poseToCast(canonicalPose('point', 'right', [0.05, 0.02]));
    const c = poseToCast(canonicalPose('L', 'right', [0, 0.07]));
    expect(poseFingerprint([a])).toBe(poseFingerprint([b]));
    expect(poseFingerprint([a])).not.toBe(poseFingerprint([c]));
    expect(poseFingerprint([a, c])).toBe(poseFingerprint([c, a]));
    expect(poseFingerprint([a])).toMatch(/^[0-9a-f]{8}$/);
  });

  it('generates stable, curated names', () => {
    expect(generateHandle('device-1')).toBe(generateHandle('device-1'));
    expect(generateHandle('device-1')).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(generateLevelTitle(42)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const names = new Set(Array.from({ length: 200 }, (_, i) => generateHandle(`d${i}`)));
    expect(names.size).toBeGreaterThan(150);
  });

  it('sanitizeForPublish drops free text and extras and derives the id from content', () => {
    const l = { ...base(), hint: 'secret', name: 'My Free Text', extra: 'payload' } as LevelDef;
    const s = sanitizeForPublish(l, l.solution!, 'dev-abcdef12');
    expect(s.hint).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(s.name).toBe(generateLevelTitle(s.id));
    expect(s.author).toBe(generateHandle('dev-abcdef12'));
    expect(s.id).toMatch(/^u[0-9a-z]{13}$/);
    expect(sanitizeForPublish(base(), base().solution!, 'other-device').id).toBe(s.id);
  });
});

// ------------------------------------------------------------------ featured shelf

describe('featured shelf', () => {
  it('has 8 solvable boards that need their hands', async () => {
    const levels = buildFeaturedLevels();
    expect(levels).toHaveLength(8);
    expect(new Set(levels.map((l) => l.id)).size).toBe(8);
    for (const l of levels) {
      expect(verifySolution(l, l.solution!).ok, l.id).toBe(true);
      expect(verifySolution(l, [poseToCast(canonicalPose('fist', 'right', [0, 0]))]).ok, l.id).toBe(false);
    }
  });

  it('public/community/featured.json matches the boards built in code', async () => {
    const json = JSON.parse(readFileSync(resolve(__dirname, '../public/community/featured.json'), 'utf8')) as { entries: HallEntry[] };
    const built = await buildFeaturedEntries();
    expect(json.entries.map((e) => e.id)).toEqual(built.map((e) => e.id));
    for (let i = 0; i < built.length; i++) {
      const a = await decodeLevel(json.entries[i].code);
      expect(a).toEqual(await decodeLevel(built[i].code));
      expect(verifySolution(a, a.solution!).ok).toBe(true);
      expect(json.entries[i].featured).toBe(true);
    }
  });

  it('loadFeatured falls back to the built-in shelf', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const a = await loadFeatured('./', failing);
    expect(a).toHaveLength(8);
    const notFound = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await loadFeatured('./', notFound)).toHaveLength(8);
    const hang = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await loadFeatured('./', hang, 50)).toHaveLength(8);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('loadFeatured reads the JSON when available', async () => {
    const entries: HallEntry[] = [{ id: 'f-x', code: 'abc', name: 'X', author: 'Y', likes: 1, solves: 2, featured: false, createdAt: 3 }];
    const ok = vi.fn(async (url: string) => {
      expect(url).toBe('/base/community/featured.json');
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await loadFeatured('/base', ok)).toEqual([{ ...entries[0], featured: true }]);
  });
});

// ------------------------------------------------------------------ client (offline)

describe('HallClient offline', () => {
  const noFetch = vi.fn(async () => {
    throw new Error('should not fetch');
  }) as unknown as typeof fetch;

  function client(storage: Storage = new MemoryStorage(), extra: Partial<ConstructorParameters<typeof HallClient>[0]> = {}) {
    return new HallClient({ apiBase: null, storage, fetch: noFetch, shareBase: 'https://example.test/play/', ...extra });
  }

  it('keeps a stable device id and generated handle', () => {
    const s = new MemoryStorage();
    const a = client(s);
    const b = client(s);
    expect(a.deviceId).toBe(b.deviceId);
    expect(a.deviceId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(a.handle).toBe(generateHandle(a.deviceId));
    expect(client().deviceId).not.toBe(a.deviceId);
  });

  it('survives storage that throws', async () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    const c = client(broken);
    expect(c.deviceId).toBeTruthy();
    expect(c.listMine()).toEqual([]);
    expect((await c.like('f-relay')).liked).toBe(true);
  });

  it('lists: shelf from code, new/top empty without a backend', async () => {
    const c = client();
    expect(c.online).toBe(false);
    expect(await c.listFeatured()).toHaveLength(8);
    expect(await c.listNew()).toEqual([]);
    expect(await c.listTop('20')).toEqual([]);
  });

  it('publishes locally ("My creations") with a share URL', async () => {
    const storage = new MemoryStorage();
    const spy = vi.fn(noFetch);
    const c = client(storage, { fetch: spy });
    const level = buildFeaturedLevels()[1];
    const res = await c.publishLevel({ ...level, hint: 'free text' }, level.solution!);
    expect(res.ok).toBe(true);
    expect(res.online).toBe(false);
    expect(res.url!.startsWith('https://example.test/play/#l=')).toBe(true);
    const code = parseShareHash(new URL(res.url!).hash)!;
    expect(code).toBe(res.entry!.code);
    const back = await decodeLevel(code);
    expect(back.hint).toBeUndefined();
    expect(back.author).toBe(c.handle);
    expect(back.name).toBe(generateLevelTitle(back.id));
    expect(verifySolution(back, back.solution!).ok).toBe(true);
    expect(JSON.parse(storage.getItem('handcast.myCreations')!)).toHaveLength(1);
    expect(client(storage).listMine()[0].id).toBe(res.entry!.id);
    expect(await c.getLevel(res.entry!.id)).toEqual(back);
    expect(await client(storage).getLevel(code)).toEqual(back);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses unsolvable and offensive levels', async () => {
    const c = client();
    const level = buildFeaturedLevels()[0];
    const fist = poseToCast(canonicalPose('fist', 'right', [0, 0.07]));
    expect((await c.publishLevel(level, [fist])).reason).toMatch(/solve/);
    const rude = poseToCast(canonicalPose('middle', 'right', [0, 0.07]));
    expect((await c.publishLevel(level, [rude])).reason).toMatch(/offensive/);
    expect(c.listMine()).toEqual([]);
  });

  it('estimates solve stats and hands from the level itself', async () => {
    const c = client();
    await c.listFeatured();
    const level = buildFeaturedLevels()[0];
    const same = await c.submitSolution(level.id, level.solution!);
    expect(same).toMatchObject({ online: false, rank: 2, distinctHands: 1, yourShare: 1 });
    const other = await c.submitSolution(level.id, [poseToCast(canonicalPose('L', 'right', [0, 0.07]))]);
    expect(other).toMatchObject({ online: false, distinctHands: 2, yourShare: 0.5 });
    const hands = await c.listHands(level.id, 30);
    expect(hands).toHaveLength(1);
    expect(hands[0].pos).toEqual(level.solution![0].pos);
    expect(await c.getLevel('nope')).toBeNull();
  });

  it('likes once per device', async () => {
    const c = client();
    expect(await c.like('f-relay')).toEqual({ liked: true, likes: null, already: false });
    expect(await c.like('f-relay')).toMatchObject({ liked: true, already: true });
    expect(c.hasLiked('f-relay')).toBe(true);
  });
});

describe('HallClient with an unreachable backend', () => {
  it('times out after the deadline, falls back, then backs off', async () => {
    const hang = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const c = new HallClient({ apiBase: 'https://api.test', storage: new MemoryStorage(), fetch: hang, timeoutMs: 40, shareBase: 'https://x.test/' });
    expect(c.online).toBe(true);
    const t0 = Date.now();
    expect(await c.listNew()).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(c.online).toBe(false);
    const apiCalls = () => (hang as unknown as { mock: { calls: [string][] } }).mock.calls.filter(([u]) => u.startsWith('https://api.test')).length;
    const calls = apiCalls();
    const level = buildFeaturedLevels()[0];
    const res = await c.publishLevel(level, level.solution!);
    expect(res).toMatchObject({ ok: true, online: false });
    expect((await c.submitSolution(level.id, level.solution!)).online).toBe(false);
    expect(apiCalls()).toBe(calls); // backing off
  });

  it('surfaces server rejections and uses server stats', async () => {
    const level = buildFeaturedLevels()[0];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Handcast-Device']).toMatch(/^[A-Za-z0-9-]{8,64}$/);
      if (url.endsWith('/levels') && init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'rejected', message: 'nope' }), { status: 422 });
      }
      if (url.includes('/solutions')) {
        const body = JSON.parse(String(init?.body)) as { casts: unknown[] };
        expect(typeof body.casts[0]).toBe('string');
        return new Response(JSON.stringify({ rank: 7, distinctHands: 3, yourShare: 0.25, solves: 12 }), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const c = new HallClient({ apiBase: 'https://api.test/', storage: new MemoryStorage(), fetch: fetchFn, shareBase: 'https://x.test/' });
    expect(await c.publishLevel(level, level.solution!)).toEqual({ ok: false, reason: 'nope', online: true });
    expect(await c.submitSolution(level.id, level.solution!)).toEqual({ rank: 7, distinctHands: 3, yourShare: 0.25, solves: 12, online: true });
  });
});
