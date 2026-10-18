/**
 * Hand-optics feature extraction: turns a 25-joint hand pose (live or cast)
 * into its HandOptic, the 2D light-sheet abstraction the tracer consumes.
 *
 * Decides which fingers are extended (with optional hysteresis), the hand's
 * optical mode (fan / blade / stone / none), the open ports (fingertips and
 * wrist), and the body silhouette that absorbs light. Pure, no three.js.
 */

import { BONES, FINGER_CHAINS, KNUCKLE, TIP } from './joints.js';
import { convexHull, DEG } from './vec2.js';
import type { Capsule2, FingerTints, HandMode, HandOptic, HandPose, Port, V2 } from './types.js';
import { NO_TINT } from './types.js';

/** Optional per-hand memory so finger extension has hysteresis across frames. */
export interface FeatureState {
  extended: boolean[];
  /** Filled when present: each finger's straightness ratio (reach / chain length), for tuning overlays. */
  ratio?: number[];
}

export interface OpticOptions {
  id: string;
  live: boolean;
  tints?: FingerTints;
  state?: FeatureState;
  /** Bench-top y in pose space (default 0). */
  benchY?: number;
  /**
   * The viewer's eye in pose space (live hands). A fingertip hidden from it
   * behind another finger or the palm is only an estimate by the tracker, so
   * it must read clearly straight (FEATURE.hiddenEnter) to count as extended.
   */
  viewer?: readonly [number, number, number];
  /**
   * Which fingers are extended, decided elsewhere (a glass hand keeps what the
   * live hand showed when it set); skips the straightness test.
   */
  fixed?: readonly boolean[];
}

/** Tunables (exported for tests / debug overlays). */
export const FEATURE = {
  longEnter: 0.88,
  /** Narrow hysteresis: a loosely curled finger (0.82-0.86) no longer stays "open". */
  longExit: 0.86,
  longMaxAngle: 60 * DEG,
  thumbEnter: 0.86,
  thumbExit: 0.84,
  /** Straightness a finger hidden from the viewer needs, in or out of hysteresis. */
  hiddenEnter: 0.95,
  /** A point this close to the eye-to-fingertip line (and in front of the tip) hides it. */
  hideRadius: 0.011,
  thumbMaxAngle: 95 * DEG,
  /** Min |xz(T - K)| / |T - K| for a finger to emit into the sheet. */
  minProjected: 0.5,
  bladeMaxNy: 0.35,
  bladeMaxSpread: 20 * DEG,
  fanMinNy: 0.55,
  portOffset: 0.006,
  portR: 0.013,
  wristOffset: 0.01,
  wristR: 0.02,
  boneR: 0.0085,
  thumbBoneR: 0.009,
  tipInset: 0.004,
  mirrorOvershoot: 0.01,
} as const;

const METACARPALS = [1, 5, 10, 15, 20] as const;

type V3s = [number, number, number];

function joint(pos: ArrayLike<number>, j: number): V3s {
  return [pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]];
}
function sub(a: V3s, b: V3s): V3s {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function len(a: V3s): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function angle3(a: V3s, b: V3s): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-9 || lb < 1e-9) return Math.PI;
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}
function unit2(x: number, z: number, fx: number, fz: number): V2 {
  const l = Math.hypot(x, z);
  return l < 1e-9 ? [fx, fz] : [x / l, z / l];
}

/** Joints that can hide a fingertip: every other finger's joints, plus the palm. */
const OCCLUDERS: readonly (readonly number[])[] = [0, 1, 2, 3, 4].map((f) => {
  const out: number[] = [0, KNUCKLE[1], KNUCKLE[2], KNUCKLE[3], KNUCKLE[4]];
  for (let g = 0; g < 5; g++) if (g !== f) for (const j of FINGER_CHAINS[g]) if (!out.includes(j)) out.push(j);
  return out;
});

/**
 * Whether finger f's tip is hidden from `eye` behind another finger or the
 * palm: some occluding joint lies within FEATURE.hideRadius of the segment
 * from the eye to the tip, between them. Allocation-free.
 */
export function hiddenTip(pos: ArrayLike<number>, f: number, eye: readonly [number, number, number]): boolean {
  const t = TIP[f] * 3;
  const tx = pos[t], ty = pos[t + 1], tz = pos[t + 2];
  const dx = tx - eye[0], dy = ty - eye[1], dz = tz - eye[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-6) return false;
  const r2 = FEATURE.hideRadius * FEATURE.hideRadius;
  // Joints of the finger itself (its knuckle and up) never hide its own tip.
  const own = FINGER_CHAINS[f];
  for (const j of OCCLUDERS[f]) {
    if (own.includes(j)) continue;
    const px = pos[j * 3] - eye[0], py = pos[j * 3 + 1] - eye[1], pz = pos[j * 3 + 2] - eye[2];
    const u = (px * dx + py * dy + pz * dz) / l2;
    // In front of the tip (with a margin so a neighbour level with it does not count).
    if (u <= 0 || u >= 0.97) continue;
    const ex = px - u * dx, ey = py - u * dy, ez = pz - u * dz;
    if (ex * ex + ey * ey + ez * ez < r2) return true;
  }
  return false;
}

/** Computes the optical abstraction of a hand pose. */
export function computeOptic(pose: HandPose, opts: OpticOptions): HandOptic {
  const pos = pose.pos;
  const benchY = opts.benchY ?? 0;
  const W = joint(pos, 0);
  const kIndex = joint(pos, KNUCKLE[1]);
  const kMiddle = joint(pos, KNUCKLE[2]);
  const kPinky = joint(pos, KNUCKLE[4]);

  // Palm normal (out of the palm); left hand negated so palm-down is -Y for both.
  const u = sub(kIndex, W);
  const v = sub(kPinky, W);
  let n: V3s = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const nl = len(n) || 1;
  const sgn = pose.hand === 'left' ? -1 : 1;
  n = [(sgn * n[0]) / nl, (sgn * n[1]) / nl, (sgn * n[2]) / nl];
  const axis = sub(kMiddle, W);
  const a2 = unit2(axis[0], axis[2], 0, -1);

  // Per-finger extension and projected direction.
  const extended: boolean[] = [false, false, false, false, false];
  const projectable: boolean[] = [false, false, false, false, false];
  const dirs: V2[] = [];
  const state = opts.state;
  if (state && state.extended.length < 5) {
    for (let f = state.extended.length; f < 5; f++) state.extended[f] = false;
  }
  // Stacked fingers on a hand held on its edge are real (blade): only fans and
  // fists get the hidden-finger rule.
  const edgeOn = Math.abs(n[1]) <= FEATURE.bladeMaxNy;
  for (let f = 0; f < 5; f++) {
    const chain = FINGER_CHAINS[f];
    const k = KNUCKLE[f];
    const thumb = f === 0;
    // The thumb's straightness is measured from its metacarpal: a real tracked
    // fist bends the thumb MCP as much as its IP, which the IP alone misses.
    const base = thumb ? chain[0] : k;
    let L = 0;
    for (let i = chain.indexOf(base); i < chain.length - 1; i++) {
      L += len(sub(joint(pos, chain[i + 1]), joint(pos, chain[i])));
    }
    const K = joint(pos, k);
    const T = joint(pos, TIP[f]);
    const kt = sub(T, K);
    const ktLen = len(kt);
    const reach = thumb ? len(sub(T, joint(pos, base))) : ktLen;
    const s = L > 1e-9 ? reach / L : 0;
    if (state?.ratio) state.ratio[f] = s;
    const was = state ? state.extended[f] : false;
    let threshold: number = thumb
      ? was ? FEATURE.thumbExit : FEATURE.thumbEnter
      : was ? FEATURE.longExit : FEATURE.longEnter;
    if (opts.viewer && !edgeOn && s > threshold && s < FEATURE.hiddenEnter && hiddenTip(pos, f, opts.viewer)) {
      threshold = FEATURE.hiddenEnter;
    }
    const maxAngle = thumb ? FEATURE.thumbMaxAngle : FEATURE.longMaxAngle;
    const ext = opts.fixed ? !!opts.fixed[f] : s > threshold && angle3(kt, axis) < maxAngle;
    extended[f] = ext;
    if (state) state.extended[f] = ext;
    const xzLen = Math.hypot(kt[0], kt[2]);
    projectable[f] = ktLen > 1e-9 && xzLen / ktLen >= FEATURE.minProjected;
    dirs.push(unit2(kt[0], kt[2], a2[0], a2[1]));
  }

  // Mode.
  const anyExt = extended.some((e) => e);
  const ny = Math.abs(n[1]);
  let mode: HandMode;
  if (!anyExt) mode = 'stone';
  else if (
    ny <= FEATURE.bladeMaxNy &&
    extended[1] && extended[2] && extended[3] && extended[4] &&
    Math.abs(Math.atan2(dirs[1][0] * dirs[4][1] - dirs[1][1] * dirs[4][0], dirs[1][0] * dirs[4][0] + dirs[1][1] * dirs[4][1])) <
      FEATURE.bladeMaxSpread
  ) mode = 'blade';
  else if (ny >= FEATURE.fanMinNy) mode = 'fan';
  else mode = 'none';
  const fan = mode === 'fan';

  // Ports.
  const ports: Port[] = [];
  for (let f = 0; f < 5; f++) {
    const T = joint(pos, TIP[f]);
    const d = dirs[f];
    ports.push({
      kind: 'finger',
      finger: f,
      p: [T[0] + FEATURE.portOffset * d[0], T[2] + FEATURE.portOffset * d[1]],
      dir: [d[0], d[1]],
      r: FEATURE.portR,
      open: fan && extended[f] && projectable[f],
      y: T[1] - benchY,
    });
  }
  ports.push({
    kind: 'wrist',
    finger: -1,
    p: [W[0] - FEATURE.wristOffset * a2[0], W[2] - FEATURE.wristOffset * a2[1]],
    dir: [-a2[0], -a2[1]],
    r: FEATURE.wristR,
    open: fan,
    y: W[1] - benchY,
  });

  const mid: V3s = [(W[0] + kMiddle[0]) / 2, (W[1] + kMiddle[1]) / 2, (W[2] + kMiddle[2]) / 2];
  const tints: FingerTints = opts.tints ? [...opts.tints] as FingerTints : [...NO_TINT] as FingerTints;
  const optic: HandOptic = {
    id: opts.id,
    hand: pose.hand,
    mode,
    live: opts.live,
    ports,
    body: [],
    palm: [],
    center: [mid[0], mid[2]],
    height: mid[1] - benchY,
    tints,
  };

  if (mode === 'blade') {
    const tm = joint(pos, TIP[2]);
    const d = unit2(tm[0] - W[0], tm[2] - W[2], a2[0], a2[1]);
    optic.mirror = {
      a: [W[0], W[2]],
      b: [tm[0] + FEATURE.mirrorOvershoot * d[0], tm[2] + FEATURE.mirrorOvershoot * d[1]],
    };
    return optic;
  }

  // Body: one capsule per bone; distal capsules stop short of the tip so the port is reached first.
  const body: Capsule2[] = optic.body;
  for (const [ja, jb] of BONES) {
    const A = joint(pos, ja);
    const B = joint(pos, jb);
    let bx = B[0];
    let bz = B[2];
    if ((TIP as readonly number[]).includes(jb)) {
      const ex = bx - A[0];
      const ez = bz - A[2];
      const l = Math.hypot(ex, ez);
      const cut = Math.min(FEATURE.tipInset, l);
      if (l > 1e-9) {
        bx -= (ex / l) * cut;
        bz -= (ez / l) * cut;
      }
    }
    const isThumb = jb >= 1 && jb <= 4;
    body.push({ a: [A[0], A[2]], b: [bx, bz], r: isThumb ? FEATURE.thumbBoneR : FEATURE.boneR });
  }
  const hullPts: V2[] = [[W[0], W[2]]];
  for (const j of METACARPALS) hullPts.push([pos[j * 3], pos[j * 3 + 2]]);
  for (const j of KNUCKLE) hullPts.push([pos[j * 3], pos[j * 3 + 2]]);
  optic.palm = convexHull(hullPts);
  return optic;
}
