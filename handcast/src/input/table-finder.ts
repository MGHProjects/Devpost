/**
 * Finds the player's real table during set-up, before the hand confirms it.
 *
 * Two optional WebXR sources, both read only while calibrating:
 * - plane detection (from the headset's Space Setup): horizontal planes at
 *   table height;
 * - hit-test along the head's forward ray (Quest Browser answers it from depth,
 *   no room scan needed): the surface the player is looking at, kept when it
 *   faces up at table height.
 *
 * It never asks for a room capture and never blocks: with neither feature
 * granted, `best` stays null and set-up works exactly as before (rest a hand).
 */

type V3 = { x: number; y: number; z: number };

export interface TableGuess {
  /** World point on the table surface near where the player is looking. */
  x: number;
  y: number;
  z: number;
  source: 'plane' | 'hit-test';
}

/** Table heights we accept, metres above the floor reference. */
const MIN_Y = 0.4;
const MAX_Y = 1.3;
/** A surface must face up this much (cosine of the tilt from vertical). */
const MIN_UP = 0.9;
/** How far ahead of the head (horizontal) the table point may be. */
const MIN_REACH = 0.15;
const MAX_REACH = 0.9;
/** A depth hit counts only after this many agreeing samples (every 4th frame: ~0.3 s). */
const HIT_STABLE = 6;
/** ...within this height and position spread (m). */
const HIT_DY = 0.03;
const HIT_DXZ = 0.05;
/** Updates without an agreeing hit before a hit-test guess is dropped (~0.5 s). */
const HIT_STALE = 9;

function mulPoint(m: ArrayLike<number>, x: number, y: number, z: number, out: V3): V3 {
  out.x = m[0] * x + m[4] * y + m[8] * z + m[12];
  out.y = m[1] * x + m[5] * y + m[9] * z + m[13];
  out.z = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

function mulDir(m: ArrayLike<number>, x: number, y: number, z: number, out: V3): V3 {
  out.x = m[0] * x + m[4] * y + m[8] * z;
  out.y = m[1] * x + m[5] * y + m[9] * z;
  out.z = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/** Point-in-polygon on the x/z plane (polygon in plane space). */
function inPolygon(px: number, pz: number, poly: readonly DOMPointReadOnly[], margin: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  if (inside || margin <= 0) return inside;
  // Near the edge counts too (a hand resting on the table's edge, a plane slightly short).
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((px - a.x) * ex + (pz - a.z) * ez) / l2));
    if (Math.hypot(px - (a.x + ex * t), pz - (a.z + ez * t)) < margin) return true;
  }
  return false;
}

type PlaneFrame = XRFrame & { detectedPlanes?: Set<XRPlane> };
type XRPlane = { orientation?: string; planeSpace: XRSpace; polygon: readonly DOMPointReadOnly[] };
type HitSession = XRSession & {
  requestHitTestSource?: (o: { space: XRSpace }) => Promise<XRHitTestSource> | undefined;
  enabledFeatures?: readonly string[];
};

export class TableFinder {
  /** The current guess (null: nothing found yet). */
  best: TableGuess | null = null;
  /** What the last update saw (diagnostics for the perf report and tests). */
  readonly seen = { planes: 0, horizontal: 0, hits: 0, source: false };
  private session: HitSession | null = null;
  private source: XRHitTestSource | null = null;
  private frames = 0;
  /** Hit-test candidate being confirmed, and how many samples agree with it. */
  private cand = { x: 0, y: 0, z: 0, n: 0, stale: 0 };
  private p = { x: 0, y: 0, z: 0 };
  private n = { x: 0, y: 0, z: 0 };

  /** Starts looking (call when set-up begins). Safe without the features. */
  begin(session: XRSession | null | undefined): void {
    this.end();
    const s = (this.session = (session as HitSession) ?? null);
    this.best = null;
    this.frames = 0;
    this.cand.n = 0;
    if (!s?.requestHitTestSource || !s.enabledFeatures?.includes('hit-test')) return;
    void s
      .requestReferenceSpace('viewer')
      .then((viewer) => s.requestHitTestSource?.({ space: viewer }))
      .then((src) => {
        if (!src) return;
        if (this.session !== s) src.cancel();
        else this.source = src;
      })
      .catch(() => undefined);
  }

  end(): void {
    this.source?.cancel();
    this.source = null;
    this.session = null;
  }

  /** True when this session can see planes or hit-test results at all. */
  get available(): boolean {
    const f = this.session?.enabledFeatures;
    return !!f && (f.includes('plane-detection') || f.includes('hit-test'));
  }

  /**
   * Updates `best` (every few frames). `toWorld` is the reference-space to
   * world matrix (the player rig), column-major.
   */
  update(frame: XRFrame | null | undefined, ref: XRReferenceSpace | null | undefined, toWorld: ArrayLike<number>, head: V3, fwd: V3): void {
    if (!frame || !ref || ++this.frames % 4 !== 0) return;
    // Where the player is looking, flattened: the table point should be ahead.
    let fx = fwd.x;
    let fz = fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;

    // 1. The surface under the head's forward ray (hit-test).
    let guess: TableGuess | null = null;
    const results = this.source ? frame.getHitTestResults(this.source) : null;
    this.seen.source = !!this.source;
    this.seen.hits = results?.length ?? 0;
    const hit = results?.[0]?.getPose(ref);
    if (hit) {
      const m = hit.transform.matrix;
      const p = mulPoint(toWorld, m[12], m[13], m[14], this.p);
      const n = mulDir(toWorld, m[4], m[5], m[6], this.n);
      const reach = Math.hypot(p.x - head.x, p.z - head.z);
      if (n.y > MIN_UP && p.y > MIN_Y && p.y < MAX_Y && p.y < head.y - 0.15 && reach > MIN_REACH && reach < MAX_REACH) {
        // One upward hit could be a lap, a chair seat or a hand: keep it only
        // once several samples in a row agree.
        const c = this.cand;
        if (c.n > 0 && Math.abs(p.y - c.y) < HIT_DY && Math.hypot(p.x - c.x, p.z - c.z) < HIT_DXZ) {
          c.n++;
          c.x += (p.x - c.x) * 0.3;
          c.y += (p.y - c.y) * 0.3;
          c.z += (p.z - c.z) * 0.3;
        } else {
          c.x = p.x;
          c.y = p.y;
          c.z = p.z;
          c.n = 1;
        }
        c.stale = 0;
        if (c.n >= HIT_STABLE) guess = { x: c.x, y: c.y, z: c.z, source: 'hit-test' };
      }
    }
    if (!guess && ++this.cand.stale > HIT_STALE) {
      this.cand.n = 0;
      if (this.best?.source === 'hit-test') this.best = null;
    }

    // 2. A horizontal plane at table height in front of the player (preferred:
    // it is the room's own model of the table, stable frame to frame).
    const planes = (frame as PlaneFrame).detectedPlanes;
    this.seen.planes = planes?.size ?? 0;
    this.seen.horizontal = 0;
    if (planes?.size) {
      let bestScore = Infinity;
      for (const plane of planes) {
        if (plane.orientation && plane.orientation !== 'horizontal') continue;
        this.seen.horizontal++;
        const pose = frame.getPose(plane.planeSpace, ref);
        if (!pose) continue;
        const pm = pose.transform.matrix;
        const n = mulDir(toWorld, pm[4], pm[5], pm[6], this.n);
        // Horizontal either way up: the plane-space normal's sign differs between
        // runtimes (IWER's floor and tables point it down). Height tells a table
        // from a ceiling.
        if (Math.abs(n.y) < MIN_UP) continue;
        const o = mulPoint(toWorld, pm[12], pm[13], pm[14], this.p);
        if (o.y < MIN_Y || o.y > MAX_Y || o.y > head.y - 0.15) continue;
        // Aim point: along the gaze, 0.42 m out, or the hit-test point if it lies on this plane.
        const ax = guess && Math.abs(guess.y - o.y) < 0.04 ? guess.x : head.x + fx * 0.42;
        const az = guess && Math.abs(guess.y - o.y) < 0.04 ? guess.z : head.z + fz * 0.42;
        const local = this.toPlaneLocal(pose.transform.inverse.matrix, toWorld, ax, o.y, az);
        if (!inPolygon(local.x, local.z, plane.polygon, 0.08)) continue;
        const score = Math.hypot(ax - head.x, az - head.z) + Math.abs(head.y - 0.45 - o.y);
        if (score < bestScore) {
          bestScore = score;
          guess = { x: ax, y: o.y, z: az, source: 'plane' };
        }
      }
    }
    if (guess) this.best = guess;
  }

  /**
   * Height of a detected horizontal plane under world (x, z) within `tol` of
   * `nearY` (the height the resting hand measured), or null. Exact plane
   * heights beat the hand's estimate (joint radii are approximate).
   */
  planeHeightAt(frame: XRFrame | null | undefined, ref: XRReferenceSpace | null | undefined, toWorld: ArrayLike<number>, x: number, z: number, nearY: number, tol: number): number | null {
    const planes = frame ? (frame as PlaneFrame).detectedPlanes : undefined;
    if (!planes?.size || !ref) return null;
    let out: number | null = null;
    for (const plane of planes) {
      if (plane.orientation && plane.orientation !== 'horizontal') continue;
      const pose = frame!.getPose(plane.planeSpace, ref);
      if (!pose) continue;
      const pm = pose.transform.matrix;
      const o = mulPoint(toWorld, pm[12], pm[13], pm[14], this.p);
      if (Math.abs(o.y - nearY) > tol) continue;
      const local = this.toPlaneLocal(pose.transform.inverse.matrix, toWorld, x, o.y, z);
      if (!inPolygon(local.x, local.z, plane.polygon, 0.05)) continue;
      if (out === null || Math.abs(o.y - nearY) < Math.abs(out - nearY)) out = o.y;
    }
    return out;
  }

  /** World point -> plane space (inverse plane pose after undoing the rig). */
  private toPlaneLocal(inv: ArrayLike<number>, toWorld: ArrayLike<number>, x: number, y: number, z: number): V3 {
    // Undo the rig: world -> reference space. The rig is a rigid transform:
    // R^T (p - t).
    const tx = x - toWorld[12];
    const ty = y - toWorld[13];
    const tz = z - toWorld[14];
    const rx = toWorld[0] * tx + toWorld[1] * ty + toWorld[2] * tz;
    const ry = toWorld[4] * tx + toWorld[5] * ty + toWorld[6] * tz;
    const rz = toWorld[8] * tx + toWorld[9] * ty + toWorld[10] * tz;
    return mulPoint(inv, rx, ry, rz, this.n);
  }
}
