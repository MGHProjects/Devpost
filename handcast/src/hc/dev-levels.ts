/**
 * Tiny solution-first board builder used before (and as a fallback for) the
 * generated campaign: place a canonical hand, trace it, drop crystals on its
 * beams and hush stones where its curled fingers would have pointed.
 */

import { computeOptic } from '../core/hand-features.js';
import { canonicalPose, PoseName } from '../core/pose-library.js';
import { traceLevel } from '../core/trace2d.js';
import { Color, Handedness, LevelDef, V2 } from '../core/types.js';
import { poseToCast } from './pose-ops.js';

export function buildBoard(
  id: string,
  name: string,
  pose: PoseName,
  hand: Handedness,
  at: V2,
  yaw: number,
  opts: { color?: number; reach?: number; hint?: string } = {},
): LevelDef {
  const color = opts.color ?? Color.W;
  const reach = opts.reach ?? 0.13;
  const solution = canonicalPose(pose, hand, at, yaw);
  const level: LevelDef = {
    v: 1,
    id,
    name,
    bench: { w: 0.44, d: 0.3 },
    budget: 1,
    lamps: [],
    wells: [{ p: [at[0], at[1]], r: 0.035, color }],
    crystals: [],
    hush: [],
    walls: [],
    mirrors: [],
    solution: [poseToCast(solution)],
    hint: opts.hint,
  };
  const optic = computeOptic(solution, { id: 'ref', live: false });
  const io = traceLevel(level, [optic], { assist: 0 }).hands[0];
  for (let f = 0; f < 5; f++) {
    const port = optic.ports[f];
    if (!port.open || !io.outMask[f]) continue;
    level.crystals.push({ p: along(port.p, port.dir, reach, level), color: io.outMask[f] });
  }
  // Hush stones where the closed fingers would point if they were open.
  const spread = computeOptic(canonicalPose('spread', hand, at, yaw), { id: 'probe', live: false });
  for (let f = 0; f < 5; f++) {
    if (optic.ports[f].open) continue;
    const port = spread.ports[f];
    level.hush.push({ p: along(port.p, port.dir, reach * 0.85, level) });
  }
  return level;
}

/** A point `dist` along the ray, pulled back so it stays 2.5 cm inside the bench. */
function along(p: V2, d: V2, dist: number, level: LevelDef): V2 {
  const hw = level.bench.w / 2 - 0.025;
  const hd = level.bench.d / 2 - 0.025;
  let t = dist;
  if (d[0] > 1e-6) t = Math.min(t, (hw - p[0]) / d[0]);
  if (d[0] < -1e-6) t = Math.min(t, (-hw - p[0]) / d[0]);
  if (d[1] > 1e-6) t = Math.min(t, (hd - p[1]) / d[1]);
  if (d[1] < -1e-6) t = Math.min(t, (-hd - p[1]) / d[1]);
  t = Math.max(0.04, t);
  return [Math.round((p[0] + d[0] * t) * 1000) / 1000, Math.round((p[1] + d[1] * t) * 1000) / 1000];
}

export function devLevels(): LevelDef[] {
  const fwd = -Math.PI / 2;
  return [
    buildBoard('dev-1', 'First Light', 'spread', 'right', [0, 0.06], fwd, { hint: 'Rest your palm in the light. Hold still.' }),
    buildBoard('dev-2', 'Point', 'point', 'right', [0.02, 0.07], fwd, { hint: 'Only one finger should carry the light.' }),
    buildBoard('dev-3', 'Peace', 'peace', 'right', [0, 0.07], fwd - 0.2),
    buildBoard('dev-4', 'Shaka', 'shaka', 'left', [-0.03, 0.06], fwd + 0.25, { color: Color.C }),
  ];
}
