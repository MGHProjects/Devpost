/**
 * Continuous 2D light-sheet tracer: the HANDCAST rules engine.
 *
 * Lamps emit rays; wells feed any open port (or a fan palm) sitting in them.
 * FAN hands catch light at their open ends and re-emit the union of what they
 * carry from every other open fingertip (filtered by finger tints); BLADE
 * hands are two-sided mirrors; everything else absorbs. Because a hand's
 * emission depends on what it receives, the whole level is re-traced until
 * every hand's input masks stop changing (a fixpoint, max 8 rounds).
 *
 * Cyclic relays can oscillate (a finger that is lit stops emitting, which
 * unlights it...). From round STICKY_FROM on, a finger port that has received
 * light stays non-emitting for the rest of the call, which makes the
 * iteration monotone and settles it deterministically.
 *
 * Ray geometry never depends on colour, so each emitter's path (lamp or hand
 * finger, including aim assist) is traced once per call and replayed each
 * round. Only the final round's segments are returned; rounds write into
 * module-level scratch buffers, so a call allocates little beyond its result.
 * Not re-entrant (shared scratch), which is fine for a single-threaded caller.
 */

import type { BeamSeg, HandIO, HandOptic, LevelDef, TargetState, TraceOptions, TraceResult, V2 } from './types.js';
import { DEG, len2, rayBoxExit, rayCapsule, rayCircle, rayConvexPolygon, raySegment } from './vec2.js';

export const CRYSTAL_R = 0.014;
export const HUSH_R = 0.014;
export const DEFAULT_ASSIST = 6 * DEG;
export const DEFAULT_MAX_DEPTH = 12;
export const MAX_SEGMENTS = 512;
export const MAX_ROUNDS = 8;
/** Assist only considers targets within this distance of the ray origin (m). */
export const ASSIST_RANGE = 0.6;
/** Offset applied to rays leaving a surface (m). */
export const RAY_EPS = 1e-4;
const COS_CATCH = Math.cos(80 * DEG);
const STICKY_FROM = 3;
const PORTS = 6;
const WRIST = 5;

export function targetStateFor(need: number, got: number): TargetState {
  if (got === 0) return 'off';
  if (got === need) return 'lit';
  if ((got & ~need) !== 0) return 'wrong';
  return 'partial';
}

// ------------------------------------------------------------- scratch state

const enum Hit {
  Edge,
  Crystal,
  Hush,
  Wall,
  Mirror,
  Port,
  Body,
  Blade,
}

const SEG_STRIDE = 7; // ax, az, bx, bz, color, d0, flags (1 live, 2 assisted)
const segBuf = new Float64Array(MAX_SEGMENTS * SEG_STRIDE);
let segCount = 0;

let cap = 0;
let curIn = new Int32Array(0);
let prevIn = new Int32Array(0);
let outMask = new Int32Array(0);
let sticky = new Uint8Array(0);
let curDist = new Float64Array(0);
let prevDist = new Float64Array(0);
let curEntry = new Int32Array(0);
let prevEntry = new Int32Array(0);
let curLive = new Uint8Array(0);
let prevLive = new Uint8Array(0);
let curDepth = new Int32Array(0);
let prevDepth = new Int32Array(0);
/** Per-hand bounding circle (cx, cz, r) for early-out. */
let bounds = new Float64Array(0);

let targetCap = 0;
let crystalRecv = new Int32Array(0);
let hushRecv = new Int32Array(0);

function ensureHands(n: number): void {
  if (n <= cap) return;
  cap = Math.max(n, cap * 2, 8);
  curIn = new Int32Array(cap * PORTS);
  prevIn = new Int32Array(cap * PORTS);
  outMask = new Int32Array(cap * PORTS);
  sticky = new Uint8Array(cap * PORTS);
  curDist = new Float64Array(cap);
  prevDist = new Float64Array(cap);
  curEntry = new Int32Array(cap);
  prevEntry = new Int32Array(cap);
  curLive = new Uint8Array(cap);
  prevLive = new Uint8Array(cap);
  curDepth = new Int32Array(cap);
  prevDepth = new Int32Array(cap);
  bounds = new Float64Array(cap * 3);
}

function ensureTargets(n: number): void {
  if (n <= targetCap) return;
  targetCap = Math.max(n, targetCap * 2, 16);
  crystalRecv = new Int32Array(targetCap);
  hushRecv = new Int32Array(targetCap);
}

// Current call context (set by traceLevel; avoids threading args through hot loops).
let L: LevelDef;
let H: readonly HandOptic[];
let maxDepth = DEFAULT_MAX_DEPTH;
let hw = 0;
let hd = 0;

// Nearest-hit result.
let hitT = 0;
let hitKind: Hit = Hit.Edge;
let hitA = -1;
let hitB = -1;

let bcx = 0;
let bcz = 0;
let br = 0;
function growBounds(p: V2, pr: number): void {
  const d = len2(p[0] - bcx, p[1] - bcz) + pr;
  if (d > br) br = d;
}

function computeBounds(h: number): void {
  const o = H[h];
  bcx = o.center[0];
  bcz = o.center[1];
  br = 0;
  for (let i = 0; i < o.body.length; i++) {
    growBounds(o.body[i].a, o.body[i].r);
    growBounds(o.body[i].b, o.body[i].r);
  }
  for (let i = 0; i < o.palm.length; i++) growBounds(o.palm[i], 0);
  for (let i = 0; i < o.ports.length; i++) growBounds(o.ports[i].p, o.ports[i].r);
  if (o.mirror) {
    growBounds(o.mirror.a, 0);
    growBounds(o.mirror.b, 0);
  }
  bounds[h * 3] = bcx;
  bounds[h * 3 + 1] = bcz;
  bounds[h * 3 + 2] = br + 1e-3;
}

/**
 * Finds the first thing a ray meets. `skipHand` ignores that hand's ports
 * (a hand never feeds itself); `skipMirror` / `skipBlade` ignore the mirror the
 * ray just left.
 */
function nearestHit(
  ox: number, oz: number, dx: number, dz: number,
  skipHand: number, skipMirror: number, skipBlade: number,
): void {
  let best = rayBoxExit(ox, oz, dx, dz, hw, hd);
  let kind: Hit = Hit.Edge;
  let a = -1;
  let b = -1;
  let t: number;

  const crystals = L.crystals;
  for (let i = 0; i < crystals.length; i++) {
    const p = crystals[i].p;
    t = rayCircle(ox, oz, dx, dz, p[0], p[1], CRYSTAL_R);
    if (t < best) { best = t; kind = Hit.Crystal; a = i; }
  }
  const hush = L.hush;
  for (let i = 0; i < hush.length; i++) {
    const p = hush[i].p;
    t = rayCircle(ox, oz, dx, dz, p[0], p[1], HUSH_R);
    if (t < best) { best = t; kind = Hit.Hush; a = i; }
  }
  const walls = L.walls;
  for (let i = 0; i < walls.length; i++) {
    const s = walls[i];
    t = raySegment(ox, oz, dx, dz, s.a[0], s.a[1], s.b[0], s.b[1]);
    if (t < best) { best = t; kind = Hit.Wall; a = i; }
  }
  const mirrors = L.mirrors;
  for (let i = 0; i < mirrors.length; i++) {
    if (i === skipMirror) continue;
    const s = mirrors[i];
    t = raySegment(ox, oz, dx, dz, s.a[0], s.a[1], s.b[0], s.b[1]);
    if (t < best) { best = t; kind = Hit.Mirror; a = i; }
  }

  for (let h = 0; h < H.length; h++) {
    if (rayCircle(ox, oz, dx, dz, bounds[h * 3], bounds[h * 3 + 1], bounds[h * 3 + 2]) >= best) continue;
    const o = H[h];
    if (o.mode === 'blade') {
      if (o.mirror && h !== skipBlade) {
        const m = o.mirror;
        t = raySegment(ox, oz, dx, dz, m.a[0], m.a[1], m.b[0], m.b[1]);
        if (t < best) { best = t; kind = Hit.Blade; a = h; }
      }
      continue;
    }
    if (o.mode === 'fan' && h !== skipHand) {
      const ports = o.ports;
      for (let i = 0; i < ports.length; i++) {
        const p = ports[i];
        if (!p.open) continue;
        // Caught only when arriving against the port's outward direction (within 80 deg).
        if (-(dx * p.dir[0] + dz * p.dir[1]) <= COS_CATCH) continue;
        t = rayCircle(ox, oz, dx, dz, p.p[0], p.p[1], p.r);
        if (t < best) { best = t; kind = Hit.Port; a = h; b = i; }
      }
    }
    const body = o.body;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      t = rayCapsule(ox, oz, dx, dz, c.a[0], c.a[1], c.b[0], c.b[1], c.r, best);
      if (t < best) { best = t; kind = Hit.Body; a = h; b = i; }
    }
    if (o.palm.length >= 3) {
      t = rayConvexPolygon(ox, oz, dx, dz, o.palm);
      if (t < best) { best = t; kind = Hit.Body; a = h; b = -1; }
    }
  }
  hitT = best;
  hitKind = kind;
  hitA = a;
  hitB = b;
}

function pushSeg(ax: number, az: number, bx: number, bz: number, color: number, d0: number, live: boolean, assisted: boolean): void {
  if (segCount >= MAX_SEGMENTS) return;
  const o = segCount * SEG_STRIDE;
  segBuf[o] = ax;
  segBuf[o + 1] = az;
  segBuf[o + 2] = bx;
  segBuf[o + 3] = bz;
  segBuf[o + 4] = color;
  segBuf[o + 5] = d0;
  segBuf[o + 6] = (live ? 1 : 0) | (assisted ? 2 : 0);
  segCount++;
}

/** Receives light at hand h, port i, arriving after `dist` metres. */
function receive(h: number, i: number, color: number, dist: number, live: boolean, depth: number): void {
  curIn[h * PORTS + i] |= color;
  if (dist < curDist[h]) {
    curDist[h] = dist;
    curEntry[h] = i;
  }
  if (live) curLive[h] = 1;
  if (depth < curDepth[h]) curDepth[h] = depth;
}

// Path cache. A ray's geometry depends only on its origin/direction and the
// (fixed) level + hand shapes, never on colour, so each emitter (lamp or hand
// finger) is traced once per call and its path is replayed every round.

const PATH_STRIDE = 6; // ax, az, bx, bz, distance from the emitter to a, blade-live flag
let pathBuf = new Float64Array(256 * PATH_STRIDE);
let pathUsed = 0;
let emCap = 0;
let emReady = new Uint8Array(0);
let emStart = new Int32Array(0);
let emCount = new Int32Array(0);
let emEndKind = new Int8Array(0);
let emEndA = new Int32Array(0);
let emEndB = new Int32Array(0);
let emEndD = new Float64Array(0);
let emEndLive = new Uint8Array(0);
let emAssisted = new Uint8Array(0);

function ensureEmitters(n: number): void {
  if (n <= emCap) return;
  emCap = Math.max(n, emCap * 2, 32);
  emReady = new Uint8Array(emCap);
  emStart = new Int32Array(emCap);
  emCount = new Int32Array(emCap);
  emEndKind = new Int8Array(emCap);
  emEndA = new Int32Array(emCap);
  emEndB = new Int32Array(emCap);
  emEndD = new Float64Array(emCap);
  emEndLive = new Uint8Array(emCap);
  emAssisted = new Uint8Array(emCap);
}

function pushPathSeg(ax: number, az: number, bx: number, bz: number, d: number, bladeLive: number): void {
  if ((pathUsed + 1) * PATH_STRIDE > pathBuf.length) {
    const grown = new Float64Array(pathBuf.length * 2);
    grown.set(pathBuf);
    pathBuf = grown;
  }
  const o = pathUsed * PATH_STRIDE;
  pathBuf[o] = ax;
  pathBuf[o + 1] = az;
  pathBuf[o + 2] = bx;
  pathBuf[o + 3] = bz;
  pathBuf[o + 4] = d;
  pathBuf[o + 5] = bladeLive;
  pathUsed++;
}

/**
 * Traces emitter `e` from (ox, oz) along unit (dx, dz) through up to maxDepth
 * reflections and caches its segments and what it finally hits.
 */
function tracePath(e: number, ox: number, oz: number, dx: number, dz: number, skipHand: number, assisted: boolean): void {
  emReady[e] = 1;
  emStart[e] = pathUsed;
  emAssisted[e] = assisted ? 1 : 0;
  emEndKind[e] = Hit.Edge;
  let skipMirror = -1;
  let skipBlade = -1;
  let dist = 0;
  let bladeLive = 0;
  let refl = 0;
  for (;;) {
    nearestHit(ox, oz, dx, dz, skipHand, skipMirror, skipBlade);
    const t = hitT;
    const bx = ox + dx * t;
    const bz = oz + dz * t;
    pushPathSeg(ox, oz, bx, bz, dist, bladeLive);
    let sx: number, sz: number, ex: number, ez: number;
    if (hitKind === Hit.Mirror) {
      const m = L.mirrors[hitA];
      sx = m.a[0]; sz = m.a[1]; ex = m.b[0]; ez = m.b[1];
      skipMirror = hitA;
      skipBlade = -1;
    } else if (hitKind === Hit.Blade) {
      const o = H[hitA];
      const m = o.mirror!;
      sx = m.a[0]; sz = m.a[1]; ex = m.b[0]; ez = m.b[1];
      skipBlade = hitA;
      skipMirror = -1;
      if (o.live) bladeLive = 1;
    } else {
      if (hitKind === Hit.Crystal || hitKind === Hit.Hush || hitKind === Hit.Port) {
        emEndKind[e] = hitKind;
        emEndA[e] = hitA;
        emEndB[e] = hitB;
        emEndD[e] = dist + t;
        emEndLive[e] = bladeLive;
      }
      break;
    }
    // Reflect across the segment (two-sided): d' = d - 2(d.n)n.
    const lx = ex - sx;
    const lz = ez - sz;
    const ll = len2(lx, lz);
    if (refl + 1 > maxDepth || ll < 1e-12) break;
    refl++;
    const nx = -lz / ll;
    const nz = lx / ll;
    const k = 2 * (dx * nx + dz * nz);
    dx -= k * nx;
    dz -= k * nz;
    ox = bx + dx * RAY_EPS;
    oz = bz + dz * RAY_EPS;
    dist += t + RAY_EPS;
    skipHand = -1;
  }
  emCount[e] = pathUsed - emStart[e];
}

/** Replays emitter e's cached path with a colour, recording segments and what it lights. */
function replayPath(e: number, color: number, d0: number, live: boolean, depth: number): void {
  const n = emCount[e];
  let o = emStart[e] * PATH_STRIDE;
  for (let j = 0; j < n; j++, o += PATH_STRIDE) {
    if (j > 0) {
      if (depth + 1 > maxDepth) return;
      depth++;
    }
    if (segCount >= MAX_SEGMENTS) return;
    const ax = pathBuf[o];
    const az = pathBuf[o + 1];
    const bx = pathBuf[o + 2];
    const bz = pathBuf[o + 3];
    if (len2(bx - ax, bz - az) > 1e-7) {
      pushSeg(ax, az, bx, bz, color, d0 + pathBuf[o + 4], live || pathBuf[o + 5] === 1, j === 0 && emAssisted[e] === 1);
    }
  }
  const a = emEndA[e];
  switch (emEndKind[e]) {
    case Hit.Crystal:
      crystalRecv[a] |= color;
      break;
    case Hit.Hush:
      hushRecv[a] |= color;
      break;
    case Hit.Port:
      receive(a, emEndB[e], color, d0 + emEndD[e], live || emEndLive[e] === 1, depth);
      break;
  }
}

// Aim-assist scratch: candidate search state and the chosen direction.
let assistDx = 0;
let assistDz = 0;
let candCos = 0;
let candKind: Hit = Hit.Edge;
let candA = -1;
let candB = -1;
let candX = 0;
let candZ = 0;

/** Keeps (x, z) as the candidate if it is closer in angle than the current one but farther than `maxCos`. */
function considerTarget(
  px: number, pz: number, dx: number, dz: number, maxCos: number,
  x: number, z: number, k: Hit, a: number, b: number,
): void {
  const vx = x - px;
  const vz = z - pz;
  const d2 = vx * vx + vz * vz;
  if (d2 < 1e-18 || d2 > ASSIST_RANGE * ASSIST_RANGE) return;
  const c = (dx * vx + dz * vz) / Math.sqrt(d2);
  if (c > candCos && c < maxCos) {
    candCos = c;
    candKind = k;
    candA = a;
    candB = b;
    candX = x;
    candZ = z;
  }
}

/** Candidates tried per emitted ray, in order of increasing angle. */
const ASSIST_TRIES = 3;

/**
 * Looks for a crystal or another hand's open port within the assist cone of
 * a ray leaving hand `h` at (px, pz). Hush stones are never targets, and a
 * ray that already reaches a crystal or port is left alone. The
 * closest-in-angle candidate is used if a ray aimed at its centre reaches it
 * first; otherwise the next one is tried (e.g. a port hidden behind another
 * hand's wrist). On success the exact direction is written to
 * assistDx/assistDz and true is returned.
 */
function findAssist(h: number, px: number, pz: number, dx: number, dz: number, assist: number): boolean {
  const cosAssist = Math.cos(assist);
  // A ray that already reaches a crystal or a port is never bent (nor flagged as assisted).
  nearestHit(px + dx * RAY_EPS, pz + dz * RAY_EPS, dx, dz, h, -1, -1);
  if (hitKind === Hit.Crystal || hitKind === Hit.Port) return false;
  let maxCos = 2;
  for (let attempt = 0; attempt < ASSIST_TRIES; attempt++) {
    candCos = cosAssist;
    candKind = Hit.Edge;
    const crystals = L.crystals;
    for (let i = 0; i < crystals.length; i++) {
      considerTarget(px, pz, dx, dz, maxCos, crystals[i].p[0], crystals[i].p[1], Hit.Crystal, i, -1);
    }
    for (let g = 0; g < H.length; g++) {
      if (g === h || H[g].mode !== 'fan') continue;
      const ports = H[g].ports;
      for (let i = 0; i < ports.length; i++) {
        if (ports[i].open) considerTarget(px, pz, dx, dz, maxCos, ports[i].p[0], ports[i].p[1], Hit.Port, g, i);
      }
    }
    if (candKind === Hit.Edge) return false;
    const l = len2(candX - px, candZ - pz);
    const ax = (candX - px) / l;
    const az = (candZ - pz) / l;
    nearestHit(px + ax * RAY_EPS, pz + az * RAY_EPS, ax, az, h, -1, -1);
    if (hitKind === candKind && hitA === candA && (candKind !== Hit.Port || hitB === candB)) {
      assistDx = ax;
      assistDz = az;
      return true;
    }
    maxCos = candCos;
  }
  return false;
}

function runRound(level: LevelDef, assist: number, round: number): void {
  const nh = H.length;
  segCount = 0;
  crystalRecv.fill(0, 0, level.crystals.length);
  hushRecv.fill(0, 0, level.hush.length);
  curIn.fill(0, 0, nh * PORTS);
  outMask.fill(0, 0, nh * PORTS);
  curDist.fill(Infinity, 0, nh);
  curEntry.fill(-1, 0, nh);
  curLive.fill(0, 0, nh);
  curDepth.fill(0x7fffffff, 0, nh);

  // Wells: open ports inside a pool drink its colour; a fan palm in a pool feeds the wrist.
  for (let h = 0; h < nh; h++) {
    const o = H[h];
    if (o.mode !== 'fan') continue;
    for (let k = 0; k < level.wells.length; k++) {
      const w = level.wells[k];
      const r2 = w.r * w.r;
      for (let i = 0; i < o.ports.length; i++) {
        const p = o.ports[i];
        if (!p.open) continue;
        const ddx = p.p[0] - w.p[0];
        const ddz = p.p[1] - w.p[1];
        if (ddx * ddx + ddz * ddz < r2) receive(h, i, w.color, 0, false, 0);
      }
      const cx = o.center[0] - w.p[0];
      const cz = o.center[1] - w.p[1];
      if (cx * cx + cz * cz < r2) receive(h, WRIST, w.color, 0, false, 0);
    }
  }

  for (let k = 0; k < level.lamps.length; k++) {
    const lamp = level.lamps[k];
    if (!lamp.color) continue;
    if (!emReady[k]) tracePath(k, lamp.p[0], lamp.p[1], Math.cos(lamp.a), Math.sin(lamp.a), -1, false);
    replayPath(k, lamp.color, 0, false, 0);
  }

  // Hand emissions from the previous round's inputs.
  for (let h = 0; h < nh; h++) {
    const o = H[h];
    if (o.mode !== 'fan') continue;
    const base = h * PORTS;
    let carried = 0;
    for (let i = 0; i < PORTS; i++) carried |= prevIn[base + i];
    if (!carried) continue;
    const depth = prevDepth[h] + 1;
    if (depth > maxDepth) continue;
    const entry = o.ports[prevEntry[h] >= 0 ? prevEntry[h] : WRIST].p;
    const live = o.live || prevLive[h] === 1;
    for (let f = 0; f < 5; f++) {
      const port = o.ports[f];
      if (!port.open || prevIn[base + f] !== 0) continue;
      if (round >= STICKY_FROM && sticky[base + f]) continue;
      const color = carried & o.tints[f];
      if (!color) continue;
      outMask[base + f] = color;
      const e = level.lamps.length + h * 5 + f;
      const px = port.p[0];
      const pz = port.p[1];
      if (!emReady[e]) {
        let dx = port.dir[0];
        let dz = port.dir[1];
        let assisted = false;
        if (assist > 0 && findAssist(h, px, pz, dx, dz, assist)) {
          dx = assistDx;
          dz = assistDz;
          assisted = true;
        }
        tracePath(e, px + dx * RAY_EPS, pz + dz * RAY_EPS, dx, dz, h, assisted);
      }
      replayPath(e, color, prevDist[h] + len2(px - entry[0], pz - entry[1]) + RAY_EPS, live, depth);
    }
  }
}

/** Traces a level with the given hands (live and cast) to its optical fixpoint. */
export function traceLevel(level: LevelDef, hands: HandOptic[], opts?: TraceOptions): TraceResult {
  const assist = opts?.assist ?? DEFAULT_ASSIST;
  maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  L = level;
  H = hands;
  hw = level.bench.w / 2;
  hd = level.bench.d / 2;
  const nh = hands.length;
  ensureHands(nh);
  ensureTargets(Math.max(level.crystals.length, level.hush.length));
  for (let h = 0; h < nh; h++) computeBounds(h);
  const ne = level.lamps.length + nh * 5;
  ensureEmitters(ne);
  emReady.fill(0, 0, ne);
  pathUsed = 0;
  prevIn.fill(0, 0, nh * PORTS);
  sticky.fill(0, 0, nh * PORTS);
  prevDist.fill(Infinity, 0, nh);
  prevEntry.fill(-1, 0, nh);
  prevLive.fill(0, 0, nh);
  prevDepth.fill(0, 0, nh);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    runRound(level, assist, round);
    let same = true;
    for (let i = 0; i < nh * PORTS; i++) {
      if (curIn[i] !== prevIn[i]) { same = false; break; }
    }
    for (let h = 0; same && h < nh; h++) if (curLive[h] !== prevLive[h]) same = false;
    if (same) break;
    if (round >= STICKY_FROM - 1) {
      for (let i = 0; i < nh * PORTS; i++) if (curIn[i] !== 0 && i % PORTS !== WRIST) sticky[i] = 1;
    }
    prevIn.set(curIn.subarray(0, nh * PORTS));
    prevDist.set(curDist.subarray(0, nh));
    prevEntry.set(curEntry.subarray(0, nh));
    prevLive.set(curLive.subarray(0, nh));
    prevDepth.set(curDepth.subarray(0, nh));
  }

  // Materialize the final round.
  const segments: BeamSeg[] = new Array(segCount);
  for (let s = 0; s < segCount; s++) {
    const o = s * SEG_STRIDE;
    const flags = segBuf[o + 6];
    const seg: BeamSeg = {
      a: [segBuf[o], segBuf[o + 1]],
      b: [segBuf[o + 2], segBuf[o + 3]],
      color: segBuf[o + 4],
      d0: segBuf[o + 5],
      live: (flags & 1) !== 0,
    };
    if (flags & 2) seg.assisted = true;
    segments[s] = seg;
  }
  let solved = level.crystals.length > 0;
  const crystals = level.crystals.map((c, i) => {
    const received = crystalRecv[i];
    const state = targetStateFor(c.color, received);
    if (state !== 'lit') solved = false;
    return { received, state };
  });
  const hush = level.hush.map((_, i) => {
    const received = hushRecv[i];
    if (received) solved = false;
    return { received, awake: received !== 0 };
  });
  const handsIO: HandIO[] = hands.map((o, h) => {
    const base = h * PORTS;
    const inMask: number[] = [];
    const out: number[] = [];
    let carried = 0;
    for (let i = 0; i < PORTS; i++) {
      inMask.push(curIn[base + i]);
      out.push(outMask[base + i]);
      carried |= curIn[base + i];
    }
    return { id: o.id, inMask, outMask: out, carried };
  });
  return { segments, crystals, hush, hands: handsIO, solved };
}
