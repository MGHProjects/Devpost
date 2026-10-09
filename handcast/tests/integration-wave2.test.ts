/**
 * Wave-2 integration: the campaign content, the community stack (codec,
 * privacy, moderation, Worker) and the Studio editor model agree with each
 * other. Every campaign board survives a share-code round trip and still
 * validates; every solution cast survives anonymisation (retargeting) with
 * the board still solved; no shipped solution is flagged as offensive; the
 * editor's seal check accepts every campaign board; and the Worker (on a
 * node:sqlite fake D1) accepts a campaign board and its solution.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import worker, { type D1Database, type D1PreparedStatement, type D1Result, type Env } from '../community/worker/src/index';
import { buildFeaturedLevels } from '../src/community/featured';
import { allLevels } from '../src/content/campaign';
import { castToPose, decodeCast, decodeLevel, encodeCast, encodeLevel, poseToCast } from '../src/core/codec';
import { BoardEditor, sealCheck } from '../src/core/editor';
import { computeOptic } from '../src/core/hand-features';
import { checkLevelPublishable, isOffensiveCast, verifySolution } from '../src/core/moderation';
import { anonymizeCast, retargetCast } from '../src/core/privacy';
import { traceLevel } from '../src/core/trace2d';
import type { LevelDef } from '../src/core/types';
import { validateBoard, type ContentLevel } from '../src/core/validate';

const CAMPAIGN = allLevels() as ContentLevel[];
const FEATURED = buildFeaturedLevels();

function solves(level: LevelDef, poses = (level.solution ?? []).map(castToPose)): boolean {
  const optics = poses.map((p, i) => computeOptic(p, { id: `cast-${i}`, live: false }));
  return traceLevel(level, optics).solved;
}

describe('campaign x codec', () => {
  it('has 49 boards to check', () => {
    expect(CAMPAIGN.length).toBe(49);
  });

  it('every board round-trips through a share code and still validates', async () => {
    const bad: string[] = [];
    for (const level of CAMPAIGN) {
      const back = (await decodeLevel(await encodeLevel(level))) as ContentLevel;
      // Geometry and casts come back within codec precision; content extras ride the JSON tail.
      expect(back.id).toBe(level.id);
      expect(back.crystals.length).toBe(level.crystals.length);
      expect(back.crystals.map((c) => c.note)).toEqual(level.crystals.map((c) => c.note));
      expect(level.solutionParams?.length).toBe(level.solution!.length);
      expect(back.solutionParams).toEqual(level.solutionParams);
      expect(back.tags).toEqual(level.tags);
      const r = validateBoard(back, { difficulty: false });
      if (!r.ok) bad.push(`${level.id}: ${r.reasons.join('; ')}`);
      // The wobble seed hashes the solution casts: codec rounding must not change the score.
      const r0 = validateBoard(level, { difficulty: false });
      if (r.robustness !== r0.robustness || r.solveRate !== r0.solveRate) bad.push(`${level.id}: robustness drifted`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('every solution cast round-trips through a cast code', async () => {
    for (const level of CAMPAIGN) {
      for (const c of level.solution!) {
        const back = await decodeCast(await encodeCast(c));
        expect(back.pos).toEqual(c.pos);
        back.rot!.forEach((q, k) => expect(Math.abs(Math.abs(q) - Math.abs(c.rot![k]))).toBeLessThanOrEqual(2));
      }
    }
  });
});

describe('campaign x privacy', () => {
  it('every campaign and featured solution survives retargeting to the canonical hand', () => {
    const bad: string[] = [];
    for (const level of [...CAMPAIGN, ...FEATURED]) {
      const poses = level.solution!.map((c) => retargetCast(castToPose(c)));
      if (!solves(level, poses)) bad.push(`${level.id} (retargetCast)`);
      const anon = level.solution!.map(anonymizeCast);
      if (!solves(level, anon.map(castToPose))) bad.push(`${level.id} (anonymizeCast)`);
    }
    expect(bad).toEqual([]);
  });
});

describe('campaign + featured x moderation', () => {
  it('no shipped solution cast is flagged as offensive', () => {
    const flagged: string[] = [];
    for (const level of [...CAMPAIGN, ...FEATURED]) {
      level.solution!.forEach((c, i) => {
        if (isOffensiveCast(castToPose(c))) flagged.push(`${level.id}#${i}`);
        if (isOffensiveCast(retargetCast(castToPose(c)))) flagged.push(`${level.id}#${i} (anon)`);
      });
    }
    expect(flagged).toEqual([]);
  });

  it('every campaign board is publishable and its solution verifies', () => {
    const bad: string[] = [];
    for (const level of CAMPAIGN) {
      const p = checkLevelPublishable(level);
      if (!p.ok) bad.push(`${level.id}: ${p.reason}`);
      const v = verifySolution(level, level.solution!);
      if (!v.ok) bad.push(`${level.id}: ${v.reason}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('campaign x editor', () => {
  it('sealCheck accepts every campaign and featured board loaded with its solution', () => {
    const bad: string[] = [];
    const warned: string[] = [];
    for (const level of [...CAMPAIGN, ...FEATURED]) {
      const ed = new BoardEditor(level);
      expect(ed.casts.length).toBe(level.solution!.length);
      const s = sealCheck(ed);
      if (!s.ok) bad.push(`${level.id}: ${s.reasons.join('; ')}`);
      if (s.warnings.length) warned.push(level.id);
    }
    expect(bad).toEqual([]);
    // Lazy-hand warnings (non-blocking). Intended: prologue-5 / finale-4 / f-open-palm are spread
    // solutions and f-first-light welcomes any open hand. validateBoard's anti-trivial rule only
    // covers one-cast boards, so a few multi-cast boards also warn; anything new is a regression.
    const KNOWN = ['prologue-5', 'mirror-6', 'mirror-7', 'relay-3', 'finale-4', 'f-first-light', 'f-open-palm', 'f-relay', 'f-mixing-bowl'];
    expect(warned.filter((id) => !KNOWN.includes(id))).toEqual([]);
  });

  it('a campaign board exported from the editor still solves', () => {
    for (const level of CAMPAIGN) {
      const out = new BoardEditor(level).toLevel(level.name, 'Tester');
      expect(solves(out)).toBe(true);
    }
  });

  it('the editor cast codec agrees with codec.poseToCast', () => {
    const level = CAMPAIGN[0];
    const pose = castToPose(level.solution![0]);
    const ed = new BoardEditor(level);
    const viaEditor = ed.toLevel('x', 'y').solution![0];
    expect(viaEditor.pos).toEqual(poseToCast(pose).pos);
    expect(viaEditor.rot).toEqual(poseToCast(pose).rot);
  });
});

// ------------------------------------------------------------------ Worker

type Sqlite = {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  };
};
let sqlite: Sqlite | null = null;
try {
  sqlite = createRequire(import.meta.url)('node:sqlite') as Sqlite;
} catch {
  sqlite = null;
}

/** Same fake D1 as tests/worker.test.ts: node:sqlite with the real schema. */
function fakeD1(): D1Database {
  const db = new sqlite!.DatabaseSync(':memory:');
  db.exec(readFileSync(resolve(__dirname, '../community/worker/schema.sql'), 'utf8'));
  const stmt = (sql: string, params: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async <T>() => ((db.prepare(sql).get(...params) as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(sql).all(...params) as T[], success: true, meta: {} }),
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try {
        const out: D1Result[] = [];
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const ORIGIN = 'https://mghprojects.github.io';

function call(env: Env, method: string, path: string, body: unknown, device: string, ip: string) {
  return worker.fetch(
    new Request(`https://hall.test${path}`, {
      method,
      headers: { Origin: ORIGIN, 'X-Handcast-Device': device, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    {},
  );
}

const d = sqlite ? describe : describe.skip;

d('campaign x Worker', () => {
  it('accepts every campaign board and its solution', async () => {
    const bad: string[] = [];
    let n = 0;
    for (const level of CAMPAIGN) {
      // A fresh DB and device per board keeps the per-device publish rate limit out of the way.
      const env: Env = { HALL: fakeD1(), ALLOWED_ORIGIN: ORIGIN };
      const device = `device-int2-${String(n).padStart(4, '0')}`;
      const ip = `10.2.${n >> 8}.${n & 255}`;
      n++;
      const res = await call(env, 'POST', '/levels', { code: await encodeLevel(level) }, device, ip);
      const pub = (await res.json()) as { entry?: { id: string; code: string }; message?: string; error?: string };
      if (res.status !== 201 || !pub.entry) {
        bad.push(`${level.id}: publish ${res.status} ${pub.error ?? ''} ${pub.message ?? ''}`);
        continue;
      }
      const stored = await decodeLevel(pub.entry.code);
      if (!solves(stored)) bad.push(`${level.id}: stored board does not solve with its stored solution`);
      const casts = await Promise.all(level.solution!.map(encodeCast));
      const sres = await call(env, 'POST', `/levels/${pub.entry.id}/solutions`, { casts }, 'device-int2-solver', ip);
      if (sres.status !== 200) {
        const b = (await sres.json()) as { message?: string };
        bad.push(`${level.id}: solution ${sres.status} ${b.message ?? ''}`);
        continue;
      }
      const stats = (await sres.json()) as { rank: number; solves: number };
      if (stats.rank !== 2 || stats.solves !== 2) bad.push(`${level.id}: stats ${JSON.stringify(stats)}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
