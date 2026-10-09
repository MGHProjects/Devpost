/**
 * Shattering a glass hand: the baked geometry is split into ~60-120 shards
 * (triangle clusters: farthest-point seeds on triangle centroids + two
 * k-means passes) that fly out from the knock point with gravity and spin,
 * bounce once on the bench plane (y = 0 in the geometry's frame), skid to a
 * stop, then dissolve with glowing crack edges (the glass material's uShatter)
 * and fade.
 *
 * Shards are animated on the CPU (a few thousand vertices for ~1.6 s): one
 * mesh, one draw call, preallocated buffers, no per-frame allocation.
 */
import {
  BufferAttribute, BufferGeometry, DoubleSide, DynamicDrawUsage, Mesh, type Color, type Vector3,
} from '@iwsdk/core';
import { createGlassMaterial, type GlassKind, type GlassMaterial } from './glass-material';

export interface ShatterOptions {
  kind?: GlassKind;
  /** Inner light per finger (thumb..pinky) and palm, carried into the shards. */
  fingerLight?: readonly (Color | null)[];
  palmLight?: Color | null;
  /** Number of shards (default 90, clamped to 24..160). */
  shards?: number;
  /** Seconds until fully gone (default 1.7). */
  life?: number;
}

const GRAVITY = 9.81;
const LIGHT_SPILL = 0.45;

export class Shatter {
  readonly object: Mesh;
  readonly material: GlassMaterial;
  private readonly geometry: BufferGeometry;
  private readonly count: number;
  /** Per vertex: shard id, rest offset from the shard centre, rest normal. */
  private readonly vShard: Uint16Array;
  private readonly rest: Float32Array;
  private readonly restN: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly nrmAttr: BufferAttribute;
  /** Per shard state. */
  private readonly centre: Float32Array;
  private readonly vel: Float32Array;
  private readonly quat: Float32Array;
  private readonly spin: Float32Array;
  private readonly radius: Float32Array;
  private readonly bounces: Uint8Array;
  private readonly rot: Float32Array; // 3x3 per shard, scratch
  /** Light the shards carried at the break; it spills out over LIGHT_SPILL seconds. */
  private readonly light0: Color[];
  private t = -1;
  private readonly life: number;

  constructor(source: BufferGeometry, opts: ShatterOptions = {}) {
    const g = source.index ? source.toNonIndexed() : source.clone();
    const pos = g.getAttribute('position').array as Float32Array;
    const nrm = g.getAttribute('normal').array as Float32Array;
    const triCount = pos.length / 9;
    const k = Math.max(24, Math.min(160, Math.round(opts.shards ?? 90), triCount));
    this.count = k;
    this.life = opts.life ?? 1.7;

    // Triangle centroids.
    const tc = new Float32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      for (let a = 0; a < 3; a++) tc[t * 3 + a] = (pos[t * 9 + a] + pos[t * 9 + 3 + a] + pos[t * 9 + 6 + a]) / 3;
    }
    // Farthest-point seeds (deterministic), then k-means refinement.
    const seeds = new Float32Array(k * 3);
    const best = new Float32Array(triCount).fill(Infinity);
    let pick = 0;
    for (let s = 0; s < k; s++) {
      seeds.set(tc.subarray(pick * 3, pick * 3 + 3), s * 3);
      let far = 0;
      for (let t = 0; t < triCount; t++) {
        const d = (tc[t * 3] - seeds[s * 3]) ** 2 + (tc[t * 3 + 1] - seeds[s * 3 + 1]) ** 2 + (tc[t * 3 + 2] - seeds[s * 3 + 2]) ** 2;
        if (d < best[t]) best[t] = d;
        if (best[t] > far) { far = best[t]; pick = t; }
      }
    }
    const triShard = new Uint16Array(triCount);
    const sums = new Float64Array(k * 4);
    for (let pass = 0; pass < 3; pass++) {
      for (let t = 0; t < triCount; t++) {
        let bd = Infinity;
        for (let s = 0; s < k; s++) {
          const d = (tc[t * 3] - seeds[s * 3]) ** 2 + (tc[t * 3 + 1] - seeds[s * 3 + 1]) ** 2 + (tc[t * 3 + 2] - seeds[s * 3 + 2]) ** 2;
          if (d < bd) { bd = d; triShard[t] = s; }
        }
      }
      if (pass === 2) break;
      sums.fill(0);
      for (let t = 0; t < triCount; t++) {
        const s = triShard[t];
        for (let a = 0; a < 3; a++) sums[s * 4 + a] += tc[t * 3 + a];
        sums[s * 4 + 3]++;
      }
      for (let s = 0; s < k; s++) if (sums[s * 4 + 3] > 0) for (let a = 0; a < 3; a++) seeds[s * 3 + a] = sums[s * 4 + a] / sums[s * 4 + 3];
    }

    // Shard centres = mean of their vertices; rest offsets relative to them.
    const vCount = triCount * 3;
    this.vShard = new Uint16Array(vCount);
    this.centre = new Float32Array(k * 3);
    const n = new Float32Array(k);
    for (let v = 0; v < vCount; v++) {
      const s = triShard[Math.floor(v / 3)];
      this.vShard[v] = s;
      for (let a = 0; a < 3; a++) this.centre[s * 3 + a] += pos[v * 3 + a];
      n[s]++;
    }
    for (let s = 0; s < k; s++) for (let a = 0; a < 3; a++) this.centre[s * 3 + a] /= Math.max(1, n[s]);
    this.rest = new Float32Array(vCount * 3);
    this.restN = Float32Array.from(nrm);
    this.radius = new Float32Array(k);
    for (let v = 0; v < vCount; v++) {
      const s = this.vShard[v];
      let r2 = 0;
      for (let a = 0; a < 3; a++) {
        const d = pos[v * 3 + a] - this.centre[s * 3 + a];
        this.rest[v * 3 + a] = d;
        r2 += d * d;
      }
      this.radius[s] = Math.max(this.radius[s], Math.sqrt(r2));
    }

    this.vel = new Float32Array(k * 3);
    this.quat = new Float32Array(k * 4);
    this.spin = new Float32Array(k * 3);
    this.bounces = new Uint8Array(k);
    this.rot = new Float32Array(k * 9);

    this.posAttr = g.getAttribute('position') as BufferAttribute;
    this.nrmAttr = g.getAttribute('normal') as BufferAttribute;
    g.setAttribute('aRest', new BufferAttribute(Float32Array.from(pos), 3));
    this.posAttr.setUsage(DynamicDrawUsage);
    this.nrmAttr.setUsage(DynamicDrawUsage);
    this.geometry = g;

    this.material = createGlassMaterial(opts.kind ?? 'glass', { side: DoubleSide, restAttribute: true });
    const u = this.material.uniforms;
    opts.fingerLight?.forEach((c, f) => { if (c && f < 5) u.uFingerLight.value[f].copy(c); });
    if (opts.palmLight) u.uPalmLight.value.copy(opts.palmLight);
    this.light0 = [...u.uFingerLight.value, u.uPalmLight.value].map((c) => c.clone());
    this.object = new Mesh(g, this.material);
    this.object.name = 'glass-shatter';
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Bursts the shards away from `origin` (in the geometry's frame). */
  start(origin: Vector3): void {
    const k = this.count;
    for (let s = 0; s < k; s++) {
      let dx = this.centre[s * 3] - origin.x;
      let dy = this.centre[s * 3 + 1] - origin.y;
      let dz = this.centre[s * 3 + 2] - origin.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      dx /= d; dy /= d; dz /= d;
      // Closer shards fly faster.
      const speed = (0.18 + Math.random() * 0.3) * (1.2 - Math.min(0.6, d * 4));
      this.vel[s * 3] = dx * speed + (Math.random() - 0.5) * 0.12;
      this.vel[s * 3 + 1] = Math.abs(dy) * speed * 0.6 + 0.4 + Math.random() * 0.5;
      this.vel[s * 3 + 2] = dz * speed + (Math.random() - 0.5) * 0.12;
      this.quat.set([0, 0, 0, 1], s * 4);
      const w = 8 + Math.random() * 16;
      let ax = Math.random() - 0.5, ay = Math.random() - 0.5, az = Math.random() - 0.5;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al; ay /= al; az /= al;
      this.spin[s * 3] = ax * w;
      this.spin[s * 3 + 1] = ay * w;
      this.spin[s * 3 + 2] = az * w;
      this.bounces[s] = 0;
    }
    this.t = 0;
    this.object.visible = true;
    this.material.uniforms.uHeat.value = 0;
    this.material.uniforms.uSelected.value = 1; // white flash on the rims, fades out
    this.writeVertices();
  }

  /** Advances the shards; returns false once they are gone. */
  update(dt: number): boolean {
    if (this.t < 0) return false;
    const h = Math.min(dt, 1 / 30);
    this.t += h;
    const k = this.count;
    for (let s = 0; s < k; s++) {
      const i3 = s * 3;
      const settled = this.bounces[s] >= 2;
      if (!settled) this.vel[i3 + 1] -= GRAVITY * h;
      const drag = Math.exp(-1.2 * h);
      this.vel[i3] *= drag; this.vel[i3 + 2] *= drag;
      this.centre[i3] += this.vel[i3] * h;
      this.centre[i3 + 1] += this.vel[i3 + 1] * h;
      this.centre[i3 + 2] += this.vel[i3 + 2] * h;
      // Bench contact: bounce once, then lie flat-ish and skid.
      const floor = this.radius[s] * 0.35;
      if (this.centre[i3 + 1] < floor) {
        this.centre[i3 + 1] = floor;
        if (this.bounces[s] === 0 && this.vel[i3 + 1] < -0.2) {
          this.vel[i3 + 1] = -this.vel[i3 + 1] * 0.38;
          this.vel[i3] *= 0.6; this.vel[i3 + 2] *= 0.6;
          for (let a = 0; a < 3; a++) this.spin[i3 + a] *= 0.5;
          this.bounces[s] = 1;
        } else {
          this.vel[i3 + 1] = 0;
          this.bounces[s] = 2;
        }
      }
      if (this.bounces[s] >= 2) {
        const f = Math.exp(-6 * h);
        this.vel[i3] *= f; this.vel[i3 + 2] *= f;
        for (let a = 0; a < 3; a++) this.spin[i3 + a] *= f;
      }
      // q += 0.5 * (0, w) * q * h
      const q = this.quat;
      const i4 = s * 4;
      const wx = this.spin[i3], wy = this.spin[i3 + 1], wz = this.spin[i3 + 2];
      const qx = q[i4], qy = q[i4 + 1], qz = q[i4 + 2], qw = q[i4 + 3];
      let nx = qx + 0.5 * h * (wx * qw + wy * qz - wz * qy);
      let ny = qy + 0.5 * h * (wy * qw + wz * qx - wx * qz);
      let nz = qz + 0.5 * h * (wz * qw + wx * qy - wy * qx);
      let nw = qw - 0.5 * h * (wx * qx + wy * qy + wz * qz);
      const l = Math.hypot(nx, ny, nz, nw) || 1;
      nx /= l; ny /= l; nz /= l; nw /= l;
      q[i4] = nx; q[i4 + 1] = ny; q[i4 + 2] = nz; q[i4 + 3] = nw;
    }
    this.writeVertices();

    const u = this.material.uniforms;
    const p = this.t / this.life;
    u.uSelected.value = Math.max(0, 1 - this.t * 4);
    const spill = Math.max(0, 1 - this.t / LIGHT_SPILL);
    for (let f = 0; f < 5; f++) u.uFingerLight.value[f].copy(this.light0[f]).multiplyScalar(1 + 2 * spill * spill).multiplyScalar(spill);
    u.uPalmLight.value.copy(this.light0[5]).multiplyScalar(spill);
    u.uShatter.value = Math.max(0, (p - 0.55) / 0.45);
    u.uOpacity.value = 1 - Math.max(0, (p - 0.75) / 0.25);
    if (p >= 1) {
      this.object.visible = false;
      this.t = -1;
      return false;
    }
    return true;
  }

  private writeVertices(): void {
    const k = this.count;
    const m = this.rot;
    for (let s = 0; s < k; s++) {
      const x = this.quat[s * 4], y = this.quat[s * 4 + 1], z = this.quat[s * 4 + 2], w = this.quat[s * 4 + 3];
      const o = s * 9;
      m[o] = 1 - 2 * (y * y + z * z); m[o + 1] = 2 * (x * y - z * w); m[o + 2] = 2 * (x * z + y * w);
      m[o + 3] = 2 * (x * y + z * w); m[o + 4] = 1 - 2 * (x * x + z * z); m[o + 5] = 2 * (y * z - x * w);
      m[o + 6] = 2 * (x * z - y * w); m[o + 7] = 2 * (y * z + x * w); m[o + 8] = 1 - 2 * (x * x + y * y);
    }
    const out = this.posAttr.array as Float32Array;
    const outN = this.nrmAttr.array as Float32Array;
    const rest = this.rest;
    const restN = this.restN;
    const n = this.vShard.length;
    for (let v = 0; v < n; v++) {
      const s = this.vShard[v];
      const o = s * 9;
      const i = v * 3;
      const rx = rest[i], ry = rest[i + 1], rz = rest[i + 2];
      out[i] = m[o] * rx + m[o + 1] * ry + m[o + 2] * rz + this.centre[s * 3];
      out[i + 1] = m[o + 3] * rx + m[o + 4] * ry + m[o + 5] * rz + this.centre[s * 3 + 1];
      out[i + 2] = m[o + 6] * rx + m[o + 7] * ry + m[o + 8] * rz + this.centre[s * 3 + 2];
      const nx = restN[i], ny = restN[i + 1], nz = restN[i + 2];
      outN[i] = m[o] * nx + m[o + 1] * ny + m[o + 2] * nz;
      outN[i + 1] = m[o + 3] * nx + m[o + 4] * ny + m[o + 5] * nz;
      outN[i + 2] = m[o + 6] * nx + m[o + 7] * ny + m[o + 8] * nz;
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
