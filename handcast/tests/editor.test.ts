import { describe, expect, it } from 'vitest';
import {
  BoardEditor, castBeams, castDataToPose, dropCrystals, EDITOR, palmOf, sealCheck, snapAngle, suggestHush,
} from '../src/core/editor.js';
import { computeOptic } from '../src/core/hand-features.js';
import { canonicalPose } from '../src/core/pose-library.js';
import { traceLevel } from '../src/core/trace2d.js';
import { Color } from '../src/core/types.js';
import type { HandPose, LevelDef, V2 } from '../src/core/types.js';
import { DEG } from '../src/core/vec2.js';

const AT: V2 = [0, 0.09];

function onGrid(v: number): boolean {
  return Math.abs(v / EDITOR.snap - Math.round(v / EDITOR.snap)) < 1e-6;
}

function solvesWith(level: LevelDef, poses: HandPose[]): boolean {
  return traceLevel(level, poses.map((p, i) => computeOptic(p, { id: `h${i}`, live: false })), { assist: 0 }).solved;
}

/** A 'peace' right hand resting in a white well. */
function peaceBoard(): BoardEditor {
  const ed = new BoardEditor();
  ed.addWell(AT, 0.03, Color.W);
  ed.addCast(canonicalPose('peace', 'right', AT));
  return ed;
}

describe('BoardEditor basics', () => {
  it('starts with a default empty bench', () => {
    const ed = new BoardEditor();
    expect(ed.level.bench).toEqual({ w: 0.44, d: 0.3 });
    expect(ed.level.budget).toBe(1);
    expect(ed.level.crystals).toEqual([]);
    expect(ed.casts).toHaveLength(0);
    expect(ed.canUndo).toBe(false);
  });

  it('snaps positions to 5 mm and lamp angles to 5 deg', () => {
    const ed = new BoardEditor();
    const i = ed.addLamp([0.0123, -0.0471], -88.2 * DEG, Color.R);
    const lamp = ed.level.lamps[i];
    expect(lamp.p[0]).toBeCloseTo(0.01, 9);
    expect(lamp.p[1]).toBeCloseTo(-0.045, 9);
    expect(lamp.a).toBeCloseTo(-90 * DEG, 9);
    ed.rotateLamp(i, 7 * DEG);
    expect(lamp.a).toBeCloseTo(-85 * DEG, 9);
    ed.rotateLamp(i, 2 * DEG); // rounds back onto the grid
    expect(lamp.a).toBeCloseTo(-85 * DEG, 9);
    expect(snapAngle(Math.PI + 1 * DEG)).toBeCloseTo(Math.PI, 9);

    const c = ed.addCrystal([0.1037, 0.0012], Color.G);
    expect(onGrid(ed.level.crystals[c].p[0]) && onGrid(ed.level.crystals[c].p[1])).toBe(true);
    const w = ed.addWell([0, 0], 0.0312, Color.B);
    expect(ed.level.wells[w].r).toBeCloseTo(0.03, 9);
    ed.setWellRadius(w, 1);
    expect(ed.level.wells[w].r).toBe(EDITOR.maxWellR);
  });

  it('clamps elements onto the bench', () => {
    const ed = new BoardEditor();
    const c = ed.addCrystal([0.5, -0.4], Color.R);
    const p = ed.level.crystals[c].p;
    expect(p[0]).toBeLessThanOrEqual(0.22 - 0.013 + 1e-9);
    expect(p[1]).toBeGreaterThanOrEqual(-0.15 + 0.013 - 1e-9);
    expect(onGrid(p[0]) && onGrid(p[1])).toBe(true);
    expect(ed.clampToBench([1, 1])).toEqual([0.22, 0.15]);
    expect(ed.clampToBench([-1, 0], 0.02)).toEqual([-0.2, 0]);
    const wall = ed.addWall([-0.3, 0], [0.3, 0.001]);
    expect(ed.level.walls[wall]).toEqual({ a: [-0.22, 0], b: [0.22, 0] });
    expect(ed.addMirror([0, 0], [0.002, 0.001])).toBe(-1); // degenerate
  });

  it('moves, cycles colours, removes and picks', () => {
    const ed = new BoardEditor();
    ed.addCrystal([0, 0], Color.R);
    ed.addHush([0.1, 0.05]);
    ed.addMirror([-0.1, -0.05], [-0.05, -0.05]);
    expect(ed.move('crystal', 0, [0.0512, -0.0333])).toBe(true);
    expect(ed.level.crystals[0].p).toEqual([0.05, -0.035]);
    ed.move('mirror', 0, [0, 0]);
    expect(ed.level.mirrors[0]).toEqual({ a: [-0.025, 0], b: [0.025, 0] });
    ed.move('mirror', 0, [0.3, 0]); // slides to the edge, keeps its length
    expect(ed.level.mirrors[0]).toEqual({ a: [0.17, 0], b: [0.22, 0] });
    expect(ed.moveEndpoint('mirror', 0, 0, [0.1, 0.05])).toBe(true);
    expect(ed.level.mirrors[0].a).toEqual([0.1, 0.05]);

    expect(ed.cycleColor('crystal', 0)).toBe(Color.G);
    expect(ed.cycleColor('crystal', 0)).toBe(Color.B);
    expect(ed.cycleColor('hush', 0)).toBe(0);

    expect(ed.nearest('any', [0.052, -0.03], 0.02)).toMatchObject({ kind: 'crystal', i: 0 });
    expect(ed.nearest('hush', [0.052, -0.03], 0.02)).toBeNull();
    expect(ed.nearest('mirror', [0.15, 0.03], 0.02)).toMatchObject({ kind: 'mirror', i: 0 });

    ed.select({ kind: 'hush', i: 0, d: 0 });
    expect(ed.remove('hush', 0)).toBe(true);
    expect(ed.level.hush).toHaveLength(0);
    expect(ed.selected).toBeNull();
    expect(ed.remove('hush', 0)).toBe(false);
  });

  it('moves a cast by its palm centre', () => {
    const ed = peaceBoard();
    ed.move('cast', 0, [0.05, 0.1]);
    const c = palmOf(ed.casts[0]);
    expect(c[0]).toBeCloseTo(0.05, 5);
    expect(c[1]).toBeCloseTo(0.1, 5);
    expect(ed.nearest('cast', [0.05, 0.1], 0.01)).toMatchObject({ kind: 'cast', i: 0 });
  });
});

describe('history', () => {
  it('undoes and redoes every step', () => {
    const ed = new BoardEditor();
    ed.addLamp([0, 0], 0, Color.R);
    ed.addCrystal([0.1, 0], Color.R);
    ed.move('crystal', 0, [0.15, 0]);
    expect(ed.level.crystals[0].p).toEqual([0.15, 0]);
    expect(ed.undo()).toBe(true);
    expect(ed.level.crystals[0].p).toEqual([0.1, 0]);
    expect(ed.undo()).toBe(true);
    expect(ed.level.crystals).toHaveLength(0);
    expect(ed.redo()).toBe(true);
    expect(ed.level.crystals[0].p).toEqual([0.1, 0]);
    expect(ed.redo()).toBe(true);
    expect(ed.level.crystals[0].p).toEqual([0.15, 0]);
    expect(ed.redo()).toBe(false);
    ed.undo();
    ed.addHush([0, 0.1]); // a new edit drops the redo branch
    expect(ed.canRedo).toBe(false);
  });

  it('keeps at least 50 steps', () => {
    const ed = new BoardEditor();
    ed.addCrystal([0, 0], Color.R);
    for (let k = 1; k <= 60; k++) ed.move('crystal', 0, [k * 0.002, 0]);
    let n = 0;
    while (ed.undo()) n++;
    expect(n).toBeGreaterThanOrEqual(50);
  });

  it('groups a drag into one step and restores casts', () => {
    const ed = new BoardEditor();
    ed.addCrystal([0, 0], Color.R);
    ed.begin();
    for (let k = 1; k <= 10; k++) ed.move('crystal', 0, [k * 0.01, 0]);
    ed.end();
    ed.undo();
    expect(ed.level.crystals[0].p).toEqual([0, 0]);

    ed.addCast(canonicalPose('point', 'right', AT));
    expect(ed.casts).toHaveLength(1);
    ed.removeCast(0);
    expect(ed.casts).toHaveLength(0);
    ed.undo();
    expect(ed.casts).toHaveLength(1);
    ed.undo();
    expect(ed.casts).toHaveLength(0);

    const before = ed.version;
    ed.transact(() => {
      ed.addHush([0, 0]);
      ed.remove('hush', 0);
    });
    expect(ed.version).toBeGreaterThan(before);
    expect(ed.level.hush).toHaveLength(0);
    // The no-op group left no step: the next undo removes the crystal.
    ed.undo();
    expect(ed.level.crystals).toHaveLength(0);
    expect(ed.canUndo).toBe(false);
  });
});

describe('cast-first authoring', () => {
  it('dropCrystals puts a white crystal on each beam of a peace hand in a white well', () => {
    const ed = peaceBoard();
    expect(sealCheck(ed).ok).toBe(false);
    const added = dropCrystals(ed);
    expect(added).toHaveLength(2);
    expect(ed.level.crystals.map((c) => c.color)).toEqual([Color.W, Color.W]);
    const [a, b] = ed.level.crystals;
    expect(Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1])).toBeGreaterThanOrEqual(0.03 - 1e-9);
    expect(ed.trace().solved).toBe(true);
    expect(traceLevel(ed.level, [], { assist: 0 }).solved).toBe(false);
    // Every cast beam now ends somewhere other than the bench edge.
    expect(castBeams(ed.level, ed.optics(), ed.trace()).every((bm) => bm.end === 'other')).toBe(true);
    // Running it again adds nothing; the whole drop is one undo step.
    expect(dropCrystals(ed)).toHaveLength(0);
    ed.undo();
    expect(ed.level.crystals).toHaveLength(0);
  });

  it('dropCrystals follows a beam colour through a fixed mirror', () => {
    const ed = new BoardEditor();
    ed.addWell(AT, 0.03, Color.C);
    ed.addCast(canonicalPose('point', 'right', AT));
    ed.addMirror([-0.03, -0.12], [0.03, -0.06]); // 45 deg: sends the index beam sideways
    expect(dropCrystals(ed)).toHaveLength(1);
    expect(ed.level.crystals[0].color).toBe(Color.C);
    const [x, z] = ed.level.crystals[0].p;
    expect(x).toBeLessThan(-0.05); // on the reflected leg, heading left
    expect(Math.abs(z + 0.11)).toBeLessThan(0.006);
    expect(ed.trace().solved).toBe(true);
  });

  it('suggestHush keeps the solve and stops a lazy spread hand', () => {
    const ed = peaceBoard();
    dropCrystals(ed);
    const spread = canonicalPose('spread', 'right', AT);
    expect(solvesWith(ed.level, [spread])).toBe(true); // before: the lazy hand wins
    const hush = suggestHush(ed);
    expect(hush.length).toBeGreaterThanOrEqual(1);
    expect(ed.trace().solved).toBe(true);
    expect(solvesWith(ed.level, [spread])).toBe(false);
    const seal = sealCheck(ed);
    expect(seal.ok).toBe(true);
    expect(seal.reasons).toEqual([]);
    expect(seal.warnings).toEqual([]);
  });

  it('suggestHush fills a wide gap between lit beams', () => {
    const ed = new BoardEditor();
    ed.addWell(AT, 0.03, Color.W);
    ed.addCast(canonicalPose('L', 'right', AT));
    dropCrystals(ed);
    expect(ed.trace().solved).toBe(true);
    const before = ed.level.hush.length;
    suggestHush(ed, { reach: 0.08 });
    expect(ed.level.hush.length).toBeGreaterThan(before);
    expect(ed.trace().solved).toBe(true);
  });
});

describe('sealCheck', () => {
  it('needs crystals and a cast', () => {
    const ed = new BoardEditor();
    const r = sealCheck(ed);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/crystal/);
    expect(r.reasons.join(' ')).toMatch(/cast/);
  });

  it('rejects a board the author casts do not solve', () => {
    const ed = peaceBoard();
    ed.addCrystal([0.15, 0.1], Color.R);
    const r = sealCheck(ed);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/do not solve/);
  });

  it('rejects a board already solved with no hands', () => {
    const ed = new BoardEditor();
    ed.addLamp([-0.15, 0], 0, Color.R);
    ed.addCrystal([0.1, 0], Color.R);
    ed.addCast(canonicalPose('fist', 'right', [0.05, 0.1]));
    const r = sealCheck(ed);
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('already solved with no hands');
  });

  it('rejects going over budget', () => {
    const ed = peaceBoard();
    dropCrystals(ed);
    ed.addCast(canonicalPose('fist', 'left', [-0.15, 0.08]));
    expect(ed.level.budget).toBe(2); // addCast raises the budget...
    ed.setBudget(1); // ...the author lowers it again
    const r = sealCheck(ed);
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/budget/);
  });

  it('rejects elements off the bench and bad sizes', () => {
    const ed = new BoardEditor({
      crystals: [{ p: [0.3, 0], color: Color.R }],
      wells: [{ p: [0, 0], r: 0.2, color: Color.R }],
      walls: [{ a: [0, 0], b: [0.001, 0] }],
    });
    const r = sealCheck(ed);
    expect(r.ok).toBe(false);
    const all = r.reasons.join(' | ');
    expect(all).toMatch(/off the bench: crystal 0/);
    expect(all).toMatch(/well 0: radius/);
    expect(all).toMatch(/wall 0: too short/);
  });

  it('warns (without blocking) when a spread hand also solves it', () => {
    const ed = peaceBoard();
    dropCrystals(ed);
    const r = sealCheck(ed);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/spread/);
  });
});

describe('toLevel', () => {
  it('serializes the board with the solution casts', () => {
    const ed = peaceBoard();
    dropCrystals(ed);
    suggestHush(ed);
    const a = ed.toLevel('  My   first  hand ', 'miq');
    const b = ed.toLevel('x', 'miq');
    expect(a.v).toBe(1);
    expect(a.name).toBe('My first hand');
    expect(a.author).toBe('miq');
    expect(a.id).not.toBe(b.id);
    expect(a.solution).toHaveLength(1);
    const cast = a.solution![0];
    expect(cast.pos).toHaveLength(75);
    expect(cast.pos.every((v) => Number.isInteger(v))).toBe(true);
    expect(cast.rot).toHaveLength(100);
    expect(cast.rot!.every((v) => Number.isInteger(v) && Math.abs(v) <= 10000)).toBe(true);
    // The stored solution still solves the stored level, and the editor itself is untouched.
    expect(solvesWith(a, [castDataToPose(cast)])).toBe(true);
    expect(ed.level.solution).toBeUndefined();
    // Re-opening the level in the editor restores the casts.
    const ed2 = new BoardEditor(a);
    expect(ed2.casts).toHaveLength(1);
    expect(sealCheck(ed2).ok).toBe(true);
  });
});
