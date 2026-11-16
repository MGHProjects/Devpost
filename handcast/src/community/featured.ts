/**
 * The curated "Hall of Hands" shelf that ships with the app: eight small
 * boards built here from FK hands (each with its glass-hand solution, checked
 * by tests against the tracer), their share codes in
 * public/community/featured.json, and a loader that falls back to building
 * the shelf in code when the JSON cannot be fetched, so it is always there.
 */
import { encodeLevel, poseToCast } from '../core/codec';
import { computeOptic } from '../core/hand-features';
import { canonicalPose, type PoseName } from '../core/pose-library';
import { traceLevel } from '../core/trace2d';
import type { CastData, ColorMask, Crystal, Handedness, HandOptic, HandPose, Lamp, LevelDef, V2 } from '../core/types';
import { Color } from '../core/types';
import type { HallEntry } from './client';

const BENCH = { w: 0.5, d: 0.34 };
const FEATURED_AUTHOR = 'Handcast';
/** Fixed shelf date (ms) so the JSON is reproducible. */
const SHELF_DATE = Date.UTC(2026, 9, 1);

interface Hand {
  pose: HandPose;
  optic: HandOptic;
}

function hand(name: PoseName, side: Handedness, at: V2, yaw: number, id: string): Hand {
  const pose = canonicalPose(name, side, at, yaw);
  return { pose, optic: computeOptic(pose, { id, live: false }) };
}

const along = (p: V2, d: V2, t: number): V2 => [p[0] + d[0] * t, p[1] + d[1] * t];
const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const rp = (p: V2): V2 => [r4(p[0]), r4(p[1])];

/** A lamp `dist` behind the wrist port, shining into it. */
function lampIntoWrist(h: Hand, color: ColorMask, dist = 0.035): Lamp {
  const w = h.optic.ports[5];
  return { p: rp(along(w.p, w.dir, dist)), a: Math.atan2(-w.dir[1], -w.dir[0]), color };
}

/** A crystal `dist` out along finger f's beam. */
function crystalOut(h: Hand, f: number, color: ColorMask, dist: number): Crystal {
  const p = h.optic.ports[f];
  return { p: rp(along(p.p, p.dir, dist)), color };
}

function board(id: string, name: string, budget: number, parts: Partial<LevelDef>, hands: Hand[]): LevelDef {
  const solution: CastData[] = hands.map((h) => poseToCast(h.pose));
  return {
    v: 1, id, name, bench: { ...BENCH }, budget,
    lamps: [], wells: [], crystals: [], hush: [], walls: [], mirrors: [],
    ...parts,
    solution,
    author: FEATURED_AUTHOR,
  };
}

/** Places a crystal on the last beam segment that leaves `fromPoint` (within 2 cm), `t` of the way along. */
function crystalOnBeam(level: LevelDef, hands: Hand[], near: V2, color: ColorMask, t = 0.6): Crystal {
  const r = traceLevel(level, hands.map((h) => h.optic));
  let best = r.segments[0];
  let bd = Infinity;
  for (const s of r.segments) {
    const d = Math.hypot(s.a[0] - near[0], s.a[1] - near[1]);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return { p: rp([best.a[0] + (best.b[0] - best.a[0]) * t, best.a[1] + (best.b[1] - best.a[1]) * t]), color };
}

/** The eight shelf boards (solutions included). Deterministic. */
export function buildFeaturedLevels(): LevelDef[] {
  const out: LevelDef[] = [];
  const fwd = -Math.PI / 2;

  // 1. First Light: point the way.
  {
    const h = hand('point', 'right', [0, 0.07], fwd, 'cast-0');
    out.push(board('f-first-light', 'First Light', 1, {
      lamps: [lampIntoWrist(h, Color.W)],
      crystals: [crystalOut(h, 1, Color.W, 0.07)],
    }, [h]));
  }

  // 2. Two Roads: two fingers, two crystals, and a hush stone where a third would go.
  {
    const h = hand('peace', 'right', [0, 0.07], fwd, 'cast-0');
    const flat = hand('four', 'right', [0, 0.07], fwd, 'probe');
    out.push(board('f-two-roads', 'Two Roads', 1, {
      lamps: [lampIntoWrist(h, Color.C)],
      crystals: [crystalOut(h, 1, Color.C, 0.07), crystalOut(h, 2, Color.C, 0.07)],
      hush: [{ p: crystalOut(flat, 3, 0, 0.07).p }],
    }, [h]));
  }

  // 3. Open Palm: rest a spread hand in the well; every finger sings.
  {
    const h = hand('spread', 'left', [0, 0.06], fwd, 'cast-0');
    out.push(board('f-open-palm', 'Open Palm', 1, {
      wells: [{ p: rp(h.optic.center), r: 0.03, color: Color.Y }],
      crystals: [0, 1, 2, 3, 4].map((f) => crystalOut(h, f, Color.Y, 0.05)),
    }, [h]));
  }

  // 4. Mirror Stand: a blade hand turns the beam.
  {
    const h = hand('blade', 'right', [0.02, -0.01], fwd, 'cast-0');
    const m = h.optic.mirror!;
    const hit: V2 = [(m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2];
    // Lamp on the right, aimed 40 degrees off the mirror line at its middle.
    const src: V2 = rp([hit[0] + 0.17, hit[1] + 0.12]);
    const lamp: Lamp = { p: src, a: Math.atan2(hit[1] - src[1], hit[0] - src[0]), color: Color.M };
    const lv = board('f-mirror-stand', 'Mirror Stand', 1, { lamps: [lamp] }, [h]);
    lv.crystals = [crystalOnBeam(lv, [h], hit, Color.M, 0.5)];
    out.push(lv);
  }

  // 5. Relay: one hand passes the light to the next, around the corner.
  {
    const a = hand('point', 'right', [-0.1, 0.07], fwd + 0.75, 'cast-0');
    const ia = a.optic.ports[1];
    const want = along(ia.p, ia.dir, 0.03);
    const yawB = 0.35;
    const probe = hand('point', 'left', [0, 0], yawB, 'probe');
    const b = hand('point', 'left', [want[0] - probe.optic.ports[5].p[0], want[1] - probe.optic.ports[5].p[1]], yawB, 'cast-1');
    out.push(board('f-relay', 'Relay', 2, {
      lamps: [lampIntoWrist(a, Color.G)],
      crystals: [crystalOut(b, 1, Color.G, 0.04)],
    }, [a, b]));
  }

  // 6. Mixing Bowl: red and blue meet in one crystal.
  {
    const a = hand('point', 'right', [-0.05, 0.08], -Math.PI / 2 + 0.45, 'cast-0');
    const b = hand('point', 'left', [0.05, 0.08], -Math.PI / 2 - 0.45, 'cast-1');
    const pa = a.optic.ports[1];
    const pb = b.optic.ports[1];
    // Intersection of the two index rays.
    const den = pa.dir[0] * pb.dir[1] - pa.dir[1] * pb.dir[0];
    const t = ((pb.p[0] - pa.p[0]) * pb.dir[1] - (pb.p[1] - pa.p[1]) * pb.dir[0]) / den;
    out.push(board('f-mixing-bowl', 'Mixing Bowl', 2, {
      lamps: [lampIntoWrist(a, Color.R), lampIntoWrist(b, Color.B)],
      crystals: [{ p: rp(along(pa.p, pa.dir, t)), color: Color.M }],
    }, [a, b]));
  }

  // 7. Three Wishes: three fingers past a wall.
  {
    const h = hand('three', 'right', [0, 0.07], fwd, 'cast-0');
    const c = [1, 2, 3].map((f) => crystalOut(h, f, Color.W, 0.08));
    const lamp = lampIntoWrist(h, Color.W);
    out.push(board('f-three-wishes', 'Three Wishes', 1, {
      lamps: [lamp],
      crystals: c,
      walls: [{ a: [-0.2, -0.02], b: [-0.12, -0.02] }, { a: [0.12, -0.02], b: [0.2, -0.02] }],
    }, [h]));
  }

  // 8. Corner Pocket: a fixed mirror feeds the wrist from the side.
  {
    const h = hand('rock', 'right', [-0.02, 0.02], fwd, 'cast-0');
    const w = h.optic.ports[5];
    const corner = rp(along(w.p, w.dir, 0.045));
    // Mirror at 45 degrees through `corner`, lamp shining in from the left.
    const mirror = { a: rp([corner[0] - 0.02, corner[1] + 0.02]), b: rp([corner[0] + 0.02, corner[1] - 0.02]) };
    const lamp: Lamp = { p: [-0.22, corner[1]], a: 0, color: Color.W };
    out.push(board('f-corner-pocket', 'Corner Pocket', 1, {
      lamps: [lamp],
      mirrors: [mirror],
      crystals: [crystalOut(h, 1, Color.W, 0.04), crystalOut(h, 4, Color.W, 0.04)],
    }, [h]));
  }

  return out.map((l, i) => ({ ...l, index: i }));
}

/** Shelf entries with share codes (what public/community/featured.json holds). */
export async function buildFeaturedEntries(): Promise<HallEntry[]> {
  const levels = buildFeaturedLevels();
  const out: HallEntry[] = [];
  for (const l of levels) {
    out.push({
      id: l.id,
      code: await encodeLevel(l),
      name: l.name,
      author: l.author ?? FEATURED_AUTHOR,
      likes: 0,
      solves: 0,
      featured: true,
      createdAt: SHELF_DATE,
    });
  }
  return out;
}

function isEntry(e: unknown): e is HallEntry {
  const o = e as HallEntry;
  return !!o && typeof o.id === 'string' && typeof o.code === 'string' && typeof o.name === 'string';
}

/**
 * Loads `<baseUrl>community/featured.json` (4 s timeout); on any failure
 * builds the same shelf in code. Never rejects.
 */
export async function loadFeatured(
  baseUrl = './',
  fetchFn: typeof fetch | undefined = globalThis.fetch?.bind(globalThis),
  timeoutMs = 4000,
): Promise<HallEntry[]> {
  if (fetchFn) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        rej(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      const res = await Promise.race([fetchFn(`${base}community/featured.json`, { signal: ctrl?.signal }), timeout]);
      if (res.ok) {
        const data = (await Promise.race([res.json(), timeout])) as { entries?: unknown } | unknown[];
        const entries = Array.isArray(data) ? data : data?.entries;
        if (Array.isArray(entries) && entries.length && entries.every(isEntry)) {
          return entries.map((e) => ({ ...e, featured: true }));
        }
      }
    } catch {
      // Fall through to the built-in shelf.
    } finally {
      clearTimeout(timer);
    }
  }
  return buildFeaturedEntries();
}
