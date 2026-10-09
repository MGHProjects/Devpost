/**
 * Share codec: compact binary encoding of LevelDef and CastData, deflate-raw
 * compressed (CompressionStream, available in browsers, Node 22 and Workers)
 * and base64url'd, so a whole board plus its solution fits in a URL hash.
 *
 * Quantisation: board geometry in 0.1 mm (int16), lamp angles in 1/65536
 * turns (uint16), colours in 3 bits; casts store the wrist in mm (int16) and
 * every other joint as an int8 mm delta from its parent (int16 when a bone is
 * longer than 127 mm), joint rotations as smallest-three quaternions (int16,
 * tips that share their distal joint's frame are flagged and skipped)
 * and tints as 5 x 3 bits. Unknown top-level LevelDef keys ride along as a
 * JSON tail so newer fields survive older encoders. Decoding treats its input
 * as hostile: every count, string and the inflated size is bounded.
 *
 * Also hosts CastData <-> HandPose conversion. Pure: no three.js, no DOM.
 */
import { FINGER_CHAINS, TIP } from './joints';
import type {
  CastData, Crystal, HandPose, Ink, Lamp, LevelDef, Segment, V2, Well,
} from './types';

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

/** Decoder limits (also the hard ceiling for anything the Worker accepts). */
export const CODEC_LIMITS = {
  maxCode: 12000, // base64url chars
  maxInflated: 32768, // bytes
  maxItems: 64, // per list (lamps, crystals, walls...)
  maxCasts: 16,
  maxString: 256, // utf-8 bytes
  maxExtras: 4096,
} as const;

const KIND_LEVEL = 0x11; // kind 1 (level), version 1
const KIND_CAST = 0x21; // kind 2 (cast), version 1

// ------------------------------------------------------------------ casts <-> poses

/** Joint parents (wrist = -1, metacarpals hang off the wrist). */
export const JOINT_PARENT: readonly number[] = (() => {
  const p = new Array<number>(25).fill(-1);
  for (const chain of FINGER_CHAINS) chain.forEach((j, i) => (p[j] = i === 0 ? 0 : chain[i - 1]));
  return p;
})();

/** Bench-space pose (metres, unit quaternions) from stored cast data (mm, quats x 10000). */
export function castToPose(cast: CastData): HandPose {
  const pos = new Float32Array(75);
  for (let i = 0; i < 75; i++) pos[i] = (cast.pos[i] ?? 0) / 1000;
  const pose: HandPose = { hand: cast.hand, pos };
  if (cast.rot && cast.rot.length >= 100) {
    const rot = new Float32Array(100);
    for (let j = 0; j < 25; j++) {
      const o = j * 4;
      const l = Math.hypot(cast.rot[o], cast.rot[o + 1], cast.rot[o + 2], cast.rot[o + 3]);
      if (!(l > 1e-9)) rot[o + 3] = 1; // degenerate -> identity
      else for (let i = 0; i < 4; i++) rot[o + i] = cast.rot[o + i] / l;
    }
    pose.rot = rot;
  }
  return pose;
}

/** Stored cast data from a pose: positions rounded to mm, rotations x 10000 with w >= 0. */
export function poseToCast(pose: HandPose, tints?: readonly number[]): CastData {
  const pos: number[] = new Array(75);
  for (let i = 0; i < 75; i++) pos[i] = Math.round(pose.pos[i] * 1000) + 0; // +0: no -0
  const cast: CastData = { hand: pose.hand, pos };
  if (pose.rot && pose.rot.length >= 100) {
    const rot: number[] = new Array(100);
    for (let j = 0; j < 25; j++) {
      const o = j * 4;
      const s = pose.rot[o + 3] < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) rot[o + i] = Math.round(pose.rot[o + i] * s * 10000) + 0; // +0: no -0
    }
    cast.rot = rot;
  }
  if (tints && tints.length === 5 && tints.some((t) => t !== 7)) cast.tints = tints.slice(0, 5);
  return cast;
}

// ------------------------------------------------------------------ byte IO

class Writer {
  buf = new Uint8Array(512);
  n = 0;
  private grow(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  u8(v: number): void {
    if (!(v >= 0 && v <= 255)) throw new CodecError(`uint8 out of range: ${v}`);
    this.grow(1);
    this.buf[this.n++] = v & 0xff;
  }
  u16(v: number): void {
    if (!(v >= 0 && v <= 65535)) throw new CodecError(`uint16 out of range: ${v}`);
    this.grow(2);
    this.buf[this.n++] = v & 0xff;
    this.buf[this.n++] = (v >>> 8) & 0xff;
  }
  i8(v: number): void {
    if (v < -128 || v > 127) throw new CodecError(`int8 out of range: ${v}`);
    this.u8(v & 0xff);
  }
  i16(v: number): void {
    if (!(v >= -32768 && v <= 32767)) throw new CodecError(`int16 out of range: ${v}`);
    this.u16(v & 0xffff);
  }
  varint(v: number): void {
    if (!(v >= 0) || !Number.isSafeInteger(v)) throw new CodecError(`bad varint: ${v}`);
    while (v >= 0x80) {
      this.u8((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.u8(v);
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    this.grow(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  bytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.n);
  }
}

class Reader {
  i = 0;
  constructor(private b: Uint8Array) {}
  private need(k: number): void {
    if (this.i + k > this.b.length) throw new CodecError('truncated data');
  }
  u8(): number {
    this.need(1);
    return this.b[this.i++];
  }
  u16(): number {
    this.need(2);
    const v = this.b[this.i] | (this.b[this.i + 1] << 8);
    this.i += 2;
    return v;
  }
  i8(): number {
    const v = this.u8();
    return v > 127 ? v - 256 : v;
  }
  i16(): number {
    const v = this.u16();
    return v > 32767 ? v - 65536 : v;
  }
  varint(max: number): number {
    let v = 0;
    let m = 1;
    for (let k = 0; k < 6; k++) {
      const b = this.u8();
      v += (b & 0x7f) * m;
      if (!(b & 0x80)) {
        if (v > max) throw new CodecError(`value ${v} exceeds ${max}`);
        return v;
      }
      m *= 0x80;
    }
    throw new CodecError('bad varint');
  }
  str(max: number = CODEC_LIMITS.maxString): string {
    const n = this.varint(max);
    this.need(n);
    const s = new TextDecoder('utf-8', { fatal: false }).decode(this.b.subarray(this.i, this.i + n));
    this.i += n;
    return s;
  }
  get done(): boolean {
    return this.i >= this.b.length;
  }
}

// ------------------------------------------------------------------ quantisation

const P = 10000; // level geometry: 0.1 mm units
const qp = (m: number): number => Math.round(m * P);
const dp = (q: number): number => q / P;
const TURN = 65536;
function qAngle(a: number): number {
  const t = a / (2 * Math.PI);
  return ((Math.round((t - Math.floor(t)) * TURN) % TURN) + TURN) % TURN;
}
function dAngle(q: number): number {
  const a = (q / TURN) * 2 * Math.PI;
  return a > Math.PI ? a - 2 * Math.PI : a;
}
function color3(c: number): number {
  if (!Number.isInteger(c) || c < 0 || c > 7) throw new CodecError(`bad colour: ${c}`);
  return c;
}
function pt(w: Writer, p: V2): void {
  w.i16(qp(p[0]));
  w.i16(qp(p[1]));
}
function rpt(r: Reader): V2 {
  return [dp(r.i16()), dp(r.i16())];
}

const SQRT1_2 = Math.SQRT1_2;
const QS = 32767;

function writeCast(w: Writer, c: CastData): void {
  if (c.hand !== 'left' && c.hand !== 'right') throw new CodecError('bad handedness');
  if (!Array.isArray(c.pos) || c.pos.length !== 75) throw new CodecError('cast needs 75 positions');
  const pos = c.pos.map((v) => {
    if (!Number.isFinite(v)) throw new CodecError('non-finite cast position');
    return Math.round(v);
  });
  const hasRot = Array.isArray(c.rot) && c.rot.length === 100;
  const hasTints = Array.isArray(c.tints) && c.tints.length === 5;
  let wide = false;
  for (let j = 1; j < 25; j++) {
    const p = JOINT_PARENT[j];
    for (let i = 0; i < 3; i++) {
      const d = pos[j * 3 + i] - pos[p * 3 + i];
      if (d < -128 || d > 127) wide = true;
    }
  }
  w.u8((c.hand === 'left' ? 1 : 0) | (hasRot ? 2 : 0) | (hasTints ? 4 : 0) | (wide ? 8 : 0));
  for (let i = 0; i < 3; i++) w.i16(pos[i]);
  for (let j = 1; j < 25; j++) {
    const p = JOINT_PARENT[j];
    for (let i = 0; i < 3; i++) {
      const d = pos[j * 3 + i] - pos[p * 3 + i];
      if (wide) w.i16(d);
      else w.i8(d);
    }
  }
  if (hasRot) {
    const rot = c.rot!;
    const idx: number[] = [];
    const rest: number[] = [];
    for (let j = 0; j < 25; j++) {
      const q = [rot[j * 4], rot[j * 4 + 1], rot[j * 4 + 2], rot[j * 4 + 3]];
      if (!q.every(Number.isFinite)) throw new CodecError('non-finite cast rotation');
      const l = Math.hypot(q[0], q[1], q[2], q[3]);
      if (l < 1e-9) {
        q[0] = q[1] = q[2] = 0;
        q[3] = 1;
      } else for (let i = 0; i < 4; i++) q[i] /= l;
      let m = 3;
      for (let i = 0; i < 3; i++) if (Math.abs(q[i]) > Math.abs(q[m])) m = i;
      const s = q[m] < 0 ? -1 : 1;
      idx.push(m);
      for (let i = 0; i < 4; i++) {
        if (i === m) continue;
        const v = Math.max(-1, Math.min(1, (q[i] * s) / SQRT1_2));
        rest.push(Math.round(v * QS));
      }
    }
    // Tips usually share their distal joint's frame: flag those and skip them.
    let same = 0;
    TIP.forEach((t, f) => {
      if (idx[t] === idx[t - 1] && [0, 1, 2].every((i) => rest[t * 3 + i] === rest[(t - 1) * 3 + i])) same |= 1 << f;
    });
    w.u8(same);
    for (let k = 0; k < 25; k += 4) {
      w.u8(idx[k] | ((idx[k + 1] ?? 0) << 2) | ((idx[k + 2] ?? 0) << 4) | ((idx[k + 3] ?? 0) << 6));
    }
    for (let j = 0; j < 25; j++) {
      const f = TIP.indexOf(j as (typeof TIP)[number]);
      if (f >= 0 && same & (1 << f)) continue;
      for (let i = 0; i < 3; i++) w.i16(rest[j * 3 + i]);
    }
  }
  if (hasTints) {
    const t = c.tints!;
    let v = 0;
    for (let f = 0; f < 5; f++) v |= color3(t[f]) << (f * 3);
    w.u16(v);
  }
}

function readCast(r: Reader): CastData {
  const flags = r.u8();
  if (flags & ~15) throw new CodecError('bad cast flags');
  const wide = (flags & 8) !== 0;
  const pos: number[] = new Array(75);
  for (let i = 0; i < 3; i++) pos[i] = r.i16();
  for (let j = 1; j < 25; j++) {
    const p = JOINT_PARENT[j];
    for (let i = 0; i < 3; i++) pos[j * 3 + i] = pos[p * 3 + i] + (wide ? r.i16() : r.i8());
  }
  const cast: CastData = { hand: flags & 1 ? 'left' : 'right', pos };
  if (flags & 2) {
    const same = r.u8();
    if (same & ~31) throw new CodecError('bad cast flags');
    const idx: number[] = [];
    for (let k = 0; k < 25; k += 4) {
      const b = r.u8();
      for (let s = 0; s < 4 && k + s < 25; s++) idx.push((b >> (s * 2)) & 3);
    }
    const rot: number[] = new Array(100);
    for (let j = 0; j < 25; j++) {
      const f = TIP.indexOf(j as (typeof TIP)[number]);
      if (f >= 0 && same & (1 << f)) {
        for (let i = 0; i < 4; i++) rot[j * 4 + i] = rot[(j - 1) * 4 + i];
        continue;
      }
      const q = [0, 0, 0, 0];
      let ss = 0;
      for (let i = 0; i < 4; i++) {
        if (i === idx[j]) continue;
        q[i] = (r.i16() / QS) * SQRT1_2;
        ss += q[i] * q[i];
      }
      q[idx[j]] = Math.sqrt(Math.max(0, 1 - ss));
      const s = q[3] < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) rot[j * 4 + i] = Math.round(q[i] * s * 10000) + 0;
    }
    cast.rot = rot;
  }
  if (flags & 4) {
    const v = r.u16();
    cast.tints = [0, 1, 2, 3, 4].map((f) => (v >> (f * 3)) & 7);
  }
  return cast;
}

// ------------------------------------------------------------------ level

const KNOWN_KEYS = new Set([
  'v', 'id', 'name', 'bench', 'budget', 'lamps', 'wells', 'crystals', 'hush', 'walls', 'mirrors',
  'inks', 'solution', 'hint', 'author', 'chapter', 'index',
]);

function list<T>(w: Writer, items: readonly T[] | undefined, each: (t: T) => void): void {
  const a = items ?? [];
  if (a.length > CODEC_LIMITS.maxItems) throw new CodecError('too many items');
  w.varint(a.length);
  for (const t of a) each(t);
}
function rlist<T>(r: Reader, each: () => T, max: number = CODEC_LIMITS.maxItems): T[] {
  const n = r.varint(max);
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(each());
  return out;
}

function writeLevel(w: Writer, l: LevelDef): void {
  const extras: Record<string, unknown> = {};
  for (const k of Object.keys(l)) {
    const v = (l as unknown as Record<string, unknown>)[k];
    if (!KNOWN_KEYS.has(k) && v !== undefined) extras[k] = v;
  }
  const extrasJson = Object.keys(extras).length ? JSON.stringify(extras) : '';
  const flags =
    (l.solution ? 1 : 0) |
    (l.hint !== undefined ? 2 : 0) |
    (l.author !== undefined ? 4 : 0) |
    (l.chapter !== undefined ? 8 : 0) |
    (l.index !== undefined ? 16 : 0) |
    (l.inks ? 32 : 0) |
    (extrasJson ? 64 : 0);
  w.u8(KIND_LEVEL);
  w.varint(flags);
  w.str(l.id ?? '');
  w.str(l.name ?? '');
  w.u16(qp(l.bench.w));
  w.u16(qp(l.bench.d));
  w.u8(l.budget);
  list<Lamp>(w, l.lamps, (o) => {
    pt(w, o.p);
    w.u16(qAngle(o.a));
    w.u8(color3(o.color));
  });
  list<Well>(w, l.wells, (o) => {
    pt(w, o.p);
    w.u16(qp(o.r));
    w.u8(color3(o.color));
  });
  list<Crystal>(w, l.crystals, (o) => {
    pt(w, o.p);
    const hasNote = o.note !== undefined;
    w.u8(color3(o.color) | (hasNote ? 0x80 : 0));
    if (hasNote) w.u8(Math.max(0, Math.min(127, Math.round(o.note!))));
  });
  list(w, l.hush, (o) => pt(w, o.p));
  list<Segment>(w, l.walls, (o) => (pt(w, o.a), pt(w, o.b)));
  list<Segment>(w, l.mirrors, (o) => (pt(w, o.a), pt(w, o.b)));
  if (l.inks) list<Ink>(w, l.inks, (o) => (pt(w, o.p), w.u8(color3(o.color))));
  if (l.solution) {
    if (l.solution.length > CODEC_LIMITS.maxCasts) throw new CodecError('too many casts');
    w.varint(l.solution.length);
    for (const c of l.solution) writeCast(w, c);
  }
  if (l.hint !== undefined) w.str(l.hint);
  if (l.author !== undefined) w.str(l.author);
  if (l.chapter !== undefined) w.varint(l.chapter);
  if (l.index !== undefined) w.varint(l.index);
  if (extrasJson) w.str(extrasJson);
}

function readLevel(r: Reader): LevelDef {
  if (r.u8() !== KIND_LEVEL) throw new CodecError('not a level code');
  const flags = r.varint(127);
  const id = r.str();
  const name = r.str();
  const w = dp(r.u16());
  const d = dp(r.u16());
  const budget = r.u8();
  const lamps = rlist<Lamp>(r, () => ({ p: rpt(r), a: dAngle(r.u16()), color: r.u8() & 7 }));
  const wells = rlist<Well>(r, () => ({ p: rpt(r), r: dp(r.u16()), color: r.u8() & 7 }));
  const crystals = rlist<Crystal>(r, () => {
    const p = rpt(r);
    const b = r.u8();
    const c: Crystal = { p, color: b & 7 };
    if (b & 0x80) c.note = r.u8() & 127;
    return c;
  });
  const hush = rlist(r, () => ({ p: rpt(r) }));
  const walls = rlist<Segment>(r, () => ({ a: rpt(r), b: rpt(r) }));
  const mirrors = rlist<Segment>(r, () => ({ a: rpt(r), b: rpt(r) }));
  const level: LevelDef = { v: 1, id, name, bench: { w, d }, budget, lamps, wells, crystals, hush, walls, mirrors };
  if (flags & 32) level.inks = rlist<Ink>(r, () => ({ p: rpt(r), color: r.u8() & 7 }));
  if (flags & 1) level.solution = rlist(r, () => readCast(r), CODEC_LIMITS.maxCasts);
  if (flags & 2) level.hint = r.str();
  if (flags & 4) level.author = r.str();
  if (flags & 8) level.chapter = r.varint(1e6);
  if (flags & 16) level.index = r.varint(1e6);
  if (flags & 64) {
    try {
      const extras = JSON.parse(r.str(CODEC_LIMITS.maxExtras)) as Record<string, unknown>;
      if (extras && typeof extras === 'object' && !Array.isArray(extras)) {
        for (const [k, v] of Object.entries(extras)) {
          if (!KNOWN_KEYS.has(k) && k !== '__proto__' && k !== 'constructor') {
            (level as unknown as Record<string, unknown>)[k] = v;
          }
        }
      }
    } catch (e) {
      if (e instanceof CodecError) throw e;
      throw new CodecError('bad extras');
    }
  }
  if (!r.done) throw new CodecError('trailing bytes');
  return level;
}

// ------------------------------------------------------------------ deflate + base64url

async function pump(
  input: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  writer.write(input).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > limit) {
        reader.cancel().catch(() => undefined);
        throw new CodecError('data too large');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof CodecError) throw e;
    throw new CodecError('corrupt data');
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_INV[B64.charCodeAt(i)] = i;

export function toBase64Url(b: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  if (i < b.length) {
    const v = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    s += B64[v >> 18] + B64[(v >> 12) & 63];
    if (i + 1 < b.length) s += B64[(v >> 6) & 63];
  }
  return s;
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new CodecError('bad base64 length');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_INV[c] : -1;
    if (v < 0) throw new CodecError('bad base64 character');
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o).slice();
}

async function pack(w: Writer): Promise<string> {
  const z = await pump(w.bytes(), new CompressionStream('deflate-raw'), CODEC_LIMITS.maxInflated * 2);
  return toBase64Url(z);
}

async function unpack(code: string): Promise<Reader> {
  if (typeof code !== 'string' || code.length === 0) throw new CodecError('empty code');
  if (code.length > CODEC_LIMITS.maxCode) throw new CodecError('code too long');
  const raw = await pump(fromBase64Url(code.trim()), new DecompressionStream('deflate-raw'), CODEC_LIMITS.maxInflated);
  return new Reader(raw);
}

// ------------------------------------------------------------------ public API

/** Encodes a level (including its solution casts) as a URL-safe share code. */
export async function encodeLevel(level: LevelDef): Promise<string> {
  const w = new Writer();
  writeLevel(w, level);
  return pack(w);
}

/** Decodes a share code; throws CodecError on anything malformed. */
export async function decodeLevel(code: string): Promise<LevelDef> {
  return readLevel(await unpack(code));
}

export async function encodeCast(cast: CastData): Promise<string> {
  const w = new Writer();
  w.u8(KIND_CAST);
  writeCast(w, cast);
  return pack(w);
}

export async function decodeCast(code: string): Promise<CastData> {
  const r = await unpack(code);
  if (r.u8() !== KIND_CAST) throw new CodecError('not a cast code');
  const c = readCast(r);
  if (!r.done) throw new CodecError('trailing bytes');
  return c;
}

/** `baseUrl` with its hash replaced by '#l=<code>'. */
export function levelShareUrl(code: string, baseUrl: string): string {
  const i = baseUrl.indexOf('#');
  return `${i >= 0 ? baseUrl.slice(0, i) : baseUrl}#l=${code}`;
}

/** The level code in a location hash ('#l=...', also among '&'-joined params), or null. */
export function parseShareHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of h.split('&')) {
    if (part.startsWith('l=')) {
      const code = part.slice(2).trim();
      return /^[A-Za-z0-9_-]+$/.test(code) && code.length <= CODEC_LIMITS.maxCode ? code : null;
    }
  }
  return null;
}
