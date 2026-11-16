import { describe, expect, it } from 'vitest';
import { HallClient, MemoryStorage } from '../src/community/client.js';
import { castToPose, decodeLevel, parseShareHash } from '../src/core/codec.js';
import { computeOptic } from '../src/core/hand-features.js';
import { verifySolution } from '../src/core/moderation.js';
import { canonicalPose } from '../src/core/pose-library.js';
import { retargetCast } from '../src/core/privacy.js';
import { traceLevel } from '../src/core/trace2d.js';
import type { HandPose, V2 } from '../src/core/types.js';
import { CHAPTERS } from '../src/content/campaign.js';
import { levelSource, SLOT } from '../src/hc/level-source.js';
import { sealMessage, StudioSession } from '../src/hc/studio.js';

const WELL: V2 = [0, 0.06];

/** A right hand making `name` in the starter pool, with canonical proportions (as the Studio casts). */
function authorHand(name: 'peace' | 'point' | 'three' | 'spread'): HandPose {
  return retargetCast(canonicalPose(name, 'right', WELL));
}

function client(): HallClient {
  const noFetch = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  return new HallClient({ apiBase: null, storage: new MemoryStorage(), fetch: noFetch, shareBase: 'https://example.test/play/' });
}

describe('StudioSession', () => {
  it('starts with one pool of white light and no undo', () => {
    const s = new StudioSession();
    expect(s.level.wells).toHaveLength(1);
    expect(s.level.crystals).toHaveLength(0);
    s.commit([]);
    expect(s.canUndo).toBe(false);
    expect(s.undo()).toBeNull();
  });

  it('drops crystals on every beam of the glass hand, and the hand solves it', () => {
    const s = new StudioSession();
    const hand = authorHand('peace');
    const r = s.drop([hand]);
    expect(r.crystals).toBe(2);
    const tr = traceLevel(s.level, [computeOptic(hand, { id: 'a', live: false })], { assist: 0 });
    expect(tr.solved).toBe(true);
    expect(s.level.budget).toBe(1);
    const seal = s.seal([hand]);
    expect(seal.reasons).toEqual([]);
    expect(seal.ok).toBe(true);
  });

  it('re-dropping after the hand changes clears stale targets', () => {
    const s = new StudioSession();
    s.drop([authorHand('three')]);
    const before = s.level.crystals.length;
    expect(before).toBe(3);
    const r = s.drop([authorHand('point')]);
    expect(r.removed).toBeGreaterThan(0);
    expect(s.level.crystals.length).toBe(1);
    expect(s.seal([authorHand('point')]).ok).toBe(true);
  });

  it('places, aims, recolours, toggles, moves and erases with pinch drags', () => {
    const s = new StudioSession();
    // Lamp: pinch at a point, pull toward +x.
    s.tool = 'lamp';
    s.beginDrag([-0.15, -0.1], 0);
    s.moveDrag([-0.05, -0.1]);
    expect(s.endDrag(1)).toMatch(/Lamp placed/);
    expect(s.level.lamps).toHaveLength(1);
    expect(s.level.lamps[0].a).toBeCloseTo(0, 5);
    // Re-aim it with the lamp tool: pull from the lamp toward +z.
    s.beginDrag([-0.15, -0.1], 2);
    s.moveDrag([-0.15, 0.0]);
    expect(s.endDrag(3)).toMatch(/aimed/);
    expect(s.level.lamps[0].a).toBeCloseTo(Math.PI / 2, 5);
    // Tap it: colour cycles from white.
    s.tool = null;
    s.beginDrag([-0.15, -0.1], 4);
    expect(s.endDrag(4.1)).toMatch(/Colour/);
    expect(s.level.lamps[0].color).not.toBe(7);
    // Wall, then tap it into a mirror.
    s.tool = 'wall';
    s.beginDrag([0.1, -0.1], 5);
    s.moveDrag([0.18, -0.1]);
    expect(s.endDrag(6)).toMatch(/Wall drawn/);
    expect(s.level.walls).toHaveLength(1);
    s.beginDrag([0.14, -0.1], 7);
    expect(s.endDrag(7.1)).toMatch(/mirror/);
    expect(s.level.walls).toHaveLength(0);
    expect(s.level.mirrors).toHaveLength(1);
    // Hush stone, moved by a drag with no tool.
    s.tool = 'hush';
    s.beginDrag([0.15, 0.1], 8);
    expect(s.endDrag(8.1)).toMatch(/Hush/);
    s.tool = null;
    s.beginDrag([0.15, 0.1], 9);
    s.moveDrag([0.1, 0.1]);
    expect(s.endDrag(10)).toMatch(/Moved/);
    expect(s.level.hush[0].p[0]).toBeCloseTo(0.1, 5);
    // Erase the mirror.
    s.tool = 'erase';
    s.beginDrag([0.14, -0.1], 11);
    expect(s.endDrag(11.1)).toMatch(/Removed a mirror/);
    expect(s.level.mirrors).toHaveLength(0);
    // Nothing under an empty pinch.
    s.tool = null;
    s.beginDrag([0.2, 0.14], 12);
    expect(s.endDrag(12.1)).toBe('');
  });

  it('undo steps back through whole-board snapshots, glass hands included', () => {
    const s = new StudioSession();
    s.commit([]);
    const hand = authorHand('point');
    s.commit([hand]);
    s.drop([hand]);
    s.commit([hand]);
    expect(s.level.crystals.length).toBe(1);
    const u1 = s.undo()!;
    expect(u1.level.crystals.length).toBe(0);
    expect(u1.casts).toHaveLength(1);
    const u2 = s.undo()!;
    expect(u2.casts).toHaveLength(0);
    expect(s.undo()).toBeNull();
  });

  it('explains why a board cannot be published yet', () => {
    const s = new StudioSession();
    expect(sealMessage(s.seal([]))).toMatch(/Cast a glass hand/);
    expect(sealMessage(s.seal([authorHand('point')]))).toMatch(/Crystals/);
  });

  it('publishes offline into a share link that decodes, verifies and solves', async () => {
    const s = new StudioSession();
    const hand = authorHand('peace');
    s.drop([hand]);
    expect(s.seal([hand]).ok).toBe(true);
    const hall = client();
    const res = await hall.publishLevel(s.toLevel(hall.handle), s.editor.casts.map((c) => {
      const pos = Array.from(c.pos, (v) => Math.round(v * 1000));
      return c.rot ? { hand: c.hand, pos, rot: Array.from(c.rot, (v) => Math.round(v * 10000)) } : { hand: c.hand, pos };
    }));
    expect(res.reason).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.online).toBe(false);
    const code = parseShareHash(new URL(res.url!).hash)!;
    const level = await decodeLevel(code);
    expect(level.crystals.length).toBe(2);
    expect(verifySolution(level, level.solution!).ok).toBe(true);
    // A player re-casting the maker's hand solves it.
    const optics = level.solution!.map((c, i) => computeOptic(castToPose(c), { id: `p${i}`, live: false }));
    expect(traceLevel(level, optics).solved).toBe(true);
    expect(hall.listMine().map((e) => e.id)).toContain(level.id);
  });
});

describe('levelSource', () => {
  const src = levelSource();

  it('serves the 49-board campaign in chapter order', () => {
    const levels = src.levels();
    expect(levels).toHaveLength(49);
    expect(src.chapterStarts()).toEqual([0, 5, 13, 21, 29, 37, 45]);
    expect(levels[5].chapter).toBe(1);
    expect(levels[5].index).toBe(0);
  });

  it('describes boards by chapter and position', () => {
    const levels = src.levels();
    expect(src.describe(levels[0], 0).eyebrow).toBe(`${CHAPTERS[0].title.toUpperCase()} - 1 / 5`);
    expect(src.describe(levels[6], 6).eyebrow).toBe('I. FINGERS - 2 / 8');
    expect(src.describe(levels[48], 48).eyebrow).toMatch(/ - 4 \/ 4$/);
    expect(src.describe(levels[0], SLOT.daily).eyebrow).toMatch(/DAILY/);
    expect(src.describe({ ...levels[0], author: 'Quiet Otter' }, SLOT.hall).eyebrow).toBe('HALL OF HANDS - BY QUIET OTTER');
  });

  it('gives every crystal a note and the board a bass under its chord', () => {
    for (const [i, l] of src.levels().entries()) {
      const notes = src.notesFor(l, i);
      expect(notes).toHaveLength(l.crystals.length);
      for (const n of notes) expect(Number.isInteger(n)).toBe(true);
      const bass = src.bass(l, i);
      expect(bass).toBeLessThan(Math.min(...notes));
    }
  });

  it('serves a Daily and Kiln boards with notes', () => {
    const d = src.daily(new Date(2026, 10, 18));
    expect(d.crystals.every((c) => typeof c.note === 'number')).toBe(true);
    expect(src.tonic(d, SLOT.daily)).toBeLessThan(Math.min(...d.crystals.map((c) => c.note!)));
    const k = src.kiln(2, 12345);
    expect(k.crystals.length).toBeGreaterThan(0);
    expect(src.notesFor(k, SLOT.kiln).every((n) => Number.isFinite(n))).toBe(true);
  });
});
