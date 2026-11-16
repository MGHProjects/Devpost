import { describe, expect, it } from 'vitest';
import { allLevels, levelById } from '../src/content/campaign';
import { buildFeaturedLevels } from '../src/community/featured';
import { castToPose, poseToCast } from '../src/core/codec';
import { checkLevelPublishable, isOffensiveCast, pruneIdleCasts, verifySolution } from '../src/core/moderation';
import { canonicalPose } from '../src/core/pose-library';
import { anonymizeCast } from '../src/core/privacy';
import { POSE_NAMES } from '../src/core/pose-library';

describe('gesture moderation', () => {
  it('flags a slightly bent middle finger the optics would call closed', () => {
    for (const curl of [0, 0.15, 0.25, 0.35]) {
      const pose = canonicalPose('middle', 'right', [0, 0.05], undefined, { curl: [1, 1, curl, 1, 1] });
      expect(isOffensiveCast(pose)).toBe(true);
      expect(isOffensiveCast(castToPose(anonymizeCast(poseToCast(pose))))).toBe(true);
    }
  });

  it('never flags the library poses other than the gesture itself, nor any shipped solution', () => {
    for (const name of POSE_NAMES) {
      if (name === 'middle') continue;
      for (const hand of ['left', 'right'] as const) expect(isOffensiveCast(canonicalPose(name, hand, [0, 0.05])), name).toBe(false);
    }
    for (const level of [...allLevels(), ...buildFeaturedLevels()]) {
      for (const c of level.solution ?? []) expect(isOffensiveCast(castToPose(c)), level.id).toBe(false);
    }
  });
});

describe('every hand plays a part', () => {
  it('rejects a solution with a decorative extra hand', () => {
    const base = levelById('prologue-1')!;
    const level = { ...base, budget: 2 };
    const extra = poseToCast(canonicalPose('fist', 'left', [-0.17, -0.1]));
    expect(checkLevelPublishable({ ...level, solution: [...base.solution!, extra] }).ok).toBe(true);
    const v = verifySolution(level, [...base.solution!, extra]);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/plays no part/);
    expect(verifySolution(level, base.solution!).ok).toBe(true);
  });

  it('prunes idle hands before a solve is reported, keeping the ones that matter', () => {
    const base = levelById('prologue-1')!;
    const extra = poseToCast(canonicalPose('fist', 'left', [-0.17, -0.1]));
    const kept = pruneIdleCasts(base, [extra, ...base.solution!]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(base.solution![0]);
    const relay = levelById('relay-1')!;
    expect(pruneIdleCasts(relay, relay.solution!)).toHaveLength(2);
  });

  it('holds for every multi-hand campaign board (with and without aim assist)', () => {
    for (const level of allLevels()) {
      if ((level.solution?.length ?? 0) < 2) continue;
      expect(verifySolution(level, level.solution!).ok, level.id).toBe(true);
    }
  });
});
