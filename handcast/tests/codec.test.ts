/**
 * Share codec: level / cast round trips keep their meaning (re-trace gives
 * the same result), codes stay small, hostile input is rejected, and share
 * URLs round-trip through the location hash.
 */
import { describe, expect, it } from 'vitest';
import {
  castToPose, CodecError, decodeCast, decodeLevel, encodeCast, encodeLevel, fromBase64Url, levelShareUrl,
  parseShareHash, poseToCast, toBase64Url,
} from '../src/core/codec';
import { buildFeaturedLevels } from '../src/community/featured';
import { computeOptic } from '../src/core/hand-features';
import { canonicalPose } from '../src/core/pose-library';
import { traceLevel } from '../src/core/trace2d';
import { Color, type CastData, type LevelDef } from '../src/core/types';

function trace(level: LevelDef, casts: CastData[]) {
  const optics = casts.map((c, i) => computeOptic(castToPose(c), { id: `c${i}`, live: false, tints: c.tints as never }));
  const r = traceLevel(level, optics);
  return { solved: r.solved, crystals: r.crystals.map((c) => c.state), hush: r.hush.map((h) => h.awake) };
}

function sixCrystalBoard(): LevelDef {
  const open = buildFeaturedLevels().find((l) => l.id === 'f-open-palm')!;
  return {
    ...open,
    lamps: [{ p: [-0.22, 0.15], a: 0, color: Color.B }],
    crystals: [...open.crystals, { p: [0.2, 0.15], color: Color.B }],
  };
}

describe('level codec', () => {
  const levels = buildFeaturedLevels();

  it.each(levels.map((l) => [l.id, l] as const))('%s round-trips and re-traces identically', async (_id, level) => {
    const code = await encodeLevel(level);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decodeLevel(code);
    expect(back.id).toBe(level.id);
    expect(back.name).toBe(level.name);
    expect(back.budget).toBe(level.budget);
    expect(back.bench.w).toBeCloseTo(level.bench.w, 4);
    expect(back.crystals.map((c) => c.color)).toEqual(level.crystals.map((c) => c.color));
    back.crystals.forEach((c, i) => {
      expect(c.p[0]).toBeCloseTo(level.crystals[i].p[0], 4);
      expect(c.p[1]).toBeCloseTo(level.crystals[i].p[1], 4);
    });
    back.lamps.forEach((l, i) => expect(Math.abs(l.a - level.lamps[i].a)).toBeLessThan(1e-4));
    back.solution!.forEach((c, i) => {
      const o = level.solution![i];
      expect(c.hand).toBe(o.hand);
      expect(c.pos).toEqual(o.pos); // positions are exact mm
      c.rot!.forEach((v, k) => expect(Math.abs(v - o.rot![k])).toBeLessThanOrEqual(2));
    });
    const a = trace(level, level.solution!);
    const b = trace(back, back.solution!);
    expect(a.solved).toBe(true);
    expect(b).toEqual(a);
    // Stable: re-encoding the decoded level decodes to the same level.
    expect(await decodeLevel(await encodeLevel(back))).toEqual(back);
  });

  it('a 6-crystal board with one solution cast fits in < 600 chars', async () => {
    const level = sixCrystalBoard();
    expect(level.crystals).toHaveLength(6);
    expect(trace(level, level.solution!).solved).toBe(true);
    const code = await encodeLevel(level);
    expect(code.length).toBeLessThan(600);
    expect(trace(await decodeLevel(code), level.solution!).solved).toBe(true);
  });

  it('keeps optional fields, notes, inks and unknown extras', async () => {
    const level: LevelDef & { theme?: string; tags?: string[] } = {
      v: 1, id: 'x', name: 'Ünïcode ☀', bench: { w: 0.44, d: 0.3 }, budget: 3,
      lamps: [{ p: [0.1, 0.1], a: Math.PI, color: Color.Y }],
      wells: [{ p: [-0.1, 0], r: 0.025, color: Color.C }],
      crystals: [{ p: [0, -0.1], color: Color.W, note: 64 }, { p: [0.05, -0.1], color: Color.R }],
      hush: [{ p: [0.2, 0.1] }],
      walls: [{ a: [-0.2, -0.1], b: [-0.1, -0.14] }],
      mirrors: [{ a: [0.1, 0], b: [0.12, 0.02] }],
      inks: [{ p: [0, 0.12], color: Color.M }],
      hint: 'try a fist', author: 'Amber Heron', chapter: 2, index: 7,
      theme: 'dusk', tags: ['a', 'b'],
    };
    const back = (await decodeLevel(await encodeLevel(level))) as typeof level;
    expect(back.hint).toBe('try a fist');
    expect(back.author).toBe('Amber Heron');
    expect(back.name).toBe('Ünïcode ☀');
    expect(back.chapter).toBe(2);
    expect(back.index).toBe(7);
    expect(back.crystals[0].note).toBe(64);
    expect(back.crystals[1].note).toBeUndefined();
    expect(back.inks).toEqual([{ p: [0, 0.12], color: Color.M }]);
    expect(back.wells[0].r).toBeCloseTo(0.025, 6);
    expect(Math.abs(Math.abs(back.lamps[0].a) - Math.PI)).toBeLessThan(1e-4);
    expect(back.theme).toBe('dusk');
    expect(back.tags).toEqual(['a', 'b']);
    expect(back.solution).toBeUndefined();
  });

  it('rejects malformed and hostile codes with CodecError', async () => {
    const good = await encodeLevel(buildFeaturedLevels()[0]);
    await expect(decodeLevel('')).rejects.toBeInstanceOf(CodecError);
    await expect(decodeLevel('!!not base64!!')).rejects.toBeInstanceOf(CodecError);
    await expect(decodeLevel('AAAA')).rejects.toBeInstanceOf(CodecError);
    await expect(decodeLevel(good.slice(0, good.length >> 1))).rejects.toBeInstanceOf(CodecError);
    await expect(decodeLevel('A'.repeat(20000))).rejects.toBeInstanceOf(CodecError);
    const cast = await encodeCast(buildFeaturedLevels()[0].solution![0]);
    await expect(decodeLevel(cast)).rejects.toBeInstanceOf(CodecError);
    await expect(decodeCast(good)).rejects.toBeInstanceOf(CodecError);
  });

  it('rejects unencodable levels', async () => {
    const bad = { ...buildFeaturedLevels()[0], crystals: [{ p: [0, 0] as [number, number], color: 9 }] };
    await expect(encodeLevel(bad)).rejects.toBeInstanceOf(CodecError);
    const far = { ...buildFeaturedLevels()[0], crystals: [{ p: [5, 0] as [number, number], color: 1 }] };
    await expect(encodeLevel(far)).rejects.toBeInstanceOf(CodecError);
  });
});

describe('cast codec', () => {
  it('round-trips positions exactly and rotations to within 2/10000', async () => {
    for (const [name, hand, yaw] of [['point', 'right', -1.2], ['blade', 'left', 0.4], ['fist', 'right', 2.9]] as const) {
      const cast = poseToCast(canonicalPose(name, hand, [0.03, -0.02], yaw), [7, 1, 2, 4, 0]);
      const code = await encodeCast(cast);
      expect(code.length).toBeLessThan(300);
      const back = await decodeCast(code);
      expect(back.hand).toBe(hand);
      expect(back.pos).toEqual(cast.pos);
      expect(back.tints).toEqual([7, 1, 2, 4, 0]);
      back.rot!.forEach((v, i) => expect(Math.abs(v - cast.rot![i])).toBeLessThanOrEqual(2));
    }
  });

  it('handles casts without rotations and with bones longer than 127 mm', async () => {
    const cast = poseToCast(canonicalPose('spread', 'right', [0, 0]));
    const big: CastData = { hand: 'left', pos: cast.pos.map((v, i) => (i < 3 ? v : cast.pos[i % 3] + (v - cast.pos[i % 3]) * 2.5)) };
    const back = await decodeCast(await encodeCast(big));
    expect(back.rot).toBeUndefined();
    expect(back.pos).toEqual(big.pos.map(Math.round));
  });

  it('castToPose / poseToCast convert units', () => {
    const pose = canonicalPose('peace', 'right', [0.01, 0.02]);
    const cast = poseToCast(pose);
    const back = castToPose(cast);
    for (let i = 0; i < 75; i++) expect(Math.abs(back.pos[i] - pose.pos[i])).toBeLessThanOrEqual(0.0005 + 1e-9);
    for (let j = 0; j < 25; j++) expect(cast.rot![j * 4 + 3]).toBeGreaterThanOrEqual(0);
  });
});

describe('share links', () => {
  it('builds and parses #l= hashes', async () => {
    const code = await encodeLevel(buildFeaturedLevels()[1]);
    const url = levelShareUrl(code, 'https://mghprojects.github.io/Devpost/?x=1#old');
    expect(url).toBe(`https://mghprojects.github.io/Devpost/?x=1#l=${code}`);
    expect(parseShareHash(new URL(url).hash)).toBe(code);
    expect(parseShareHash(`#foo=1&l=${code}`)).toBe(code);
    expect(parseShareHash('#l=bad code!')).toBeNull();
    expect(parseShareHash('')).toBeNull();
    expect(parseShareHash('#x=1')).toBeNull();
  });

  it('base64url round-trips arbitrary bytes', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 97 + n * 31) & 255);
      expect(Array.from(fromBase64Url(toBase64Url(b)))).toEqual(Array.from(b));
    }
  });
});
