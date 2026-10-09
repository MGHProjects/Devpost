/**
 * Light-sheet beams as additive, view-dependent glowing tubes between
 * arbitrary 2D [x, z] points at a fixed height above the bench. All tubes are
 * one instanced draw (core) plus one (halo); impact glints and aim-assist
 * sparkles share a billboard cloud. Beams that persist between traces stay
 * lit, new ones grow out from the source in path order (BeamSeg.d0). The
 * trace may be re-run every frame while a live hand moves, so `setSegments`
 * and `update` are allocation-free once capacity is reached.
 */

import {
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
} from '@iwsdk/core';
import type { BeamSeg } from '../../core/types.js';
import { BillboardCloud, LIGHT_SHEET_Y, lightColor, XR_ADDITIVE } from './props.js';

const vertex = /* glsl */ `
  attribute vec4 iSeg;    // a.x, a.z, end.x, end.z (end = a + shown length)
  attribute vec4 iParams; // radius scale, intensity, live (0/1), seed
  attribute vec3 iColor;
  attribute vec2 iY;      // heights at a and at the shown end (beams leave real fingertips)
  uniform float uRadius;
  uniform float uHeight;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vAlong;
  varying vec3 vColor;
  varying vec3 vParams;
  void main() {
    vec2 d = iSeg.zw - iSeg.xy;
    float hlen = length(d);
    vec2 dir = hlen > 1e-6 ? d / hlen : vec2(1.0, 0.0);
    vec3 a3 = vec3(iSeg.x, iY.x, iSeg.y);
    vec3 b3 = vec3(iSeg.z, iY.y, iSeg.w);
    vec3 d3 = b3 - a3;
    float len = length(d3);
    vec3 fwd = len > 1e-6 ? d3 / len : vec3(dir.x, 0.0, dir.y);
    vec3 side = vec3(-dir.y, 0.0, dir.x);
    vec3 up = normalize(cross(side, fwd));
    float r = uRadius * iParams.x;
    vec3 p = a3 + fwd * (position.y * len) + side * (position.x * r) + up * (position.z * r);
    vec3 n = side * normal.x + up * normal.z;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vNormalV = normalize(normalMatrix * n);
    vViewDir = normalize(-mv.xyz);
    vAlong = position.y * len;
    vColor = iColor;
    vParams = iParams.yzw;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uCore;
  uniform float uBoost;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vAlong;
  varying vec3 vColor;
  varying vec3 vParams; // intensity, live, seed
  void main() {
    float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
    float body = pow(facing, uCore);
    float flow = 0.8 + 0.2 * sin(vAlong * 170.0 - uTime * 9.0);
    float live = vParams.y;
    float flick = 1.0 - live * (0.18 + 0.18 * sin(uTime * 31.0 + vParams.z * 17.0) * sin(uTime * 13.0 + vAlong * 40.0));
    vec3 col = mix(vColor, vec3(1.0), body * body * 0.55);
    gl_FragColor = vec4(col * body * flow * flick * vParams.x * uIntensity * (1.0 + uBoost), 1.0);
  }
`;

/** Beams grow at this speed (metres of path per second). */
const GROW_SPEED = 1.0;
const SPARKS_PER_ASSIST = 4;
const CORE_RADIUS = 0.0012;
const HALO_RADIUS = 0.0042;

/** Struct-of-arrays segment records (double-buffered for matching). */
class SegTable {
  ax!: Float32Array;
  az!: Float32Array;
  bx!: Float32Array;
  bz!: Float32Array;
  len!: Float32Array;
  shown!: Float32Array;
  delay!: Float32Array;
  color!: Uint8Array;
  live!: Uint8Array;
  assisted!: Uint8Array;
  ya!: Float32Array;
  yb!: Float32Array;
  used!: Uint8Array;
  count = 0;
  capacity = 0;
  constructor(cap: number) {
    this.resize(cap);
  }
  resize(cap: number): void {
    const f = (old?: Float32Array) => {
      const a = new Float32Array(cap);
      if (old) a.set(old.subarray(0, Math.min(old.length, cap)));
      return a;
    };
    const u = (old?: Uint8Array) => {
      const a = new Uint8Array(cap);
      if (old) a.set(old.subarray(0, Math.min(old.length, cap)));
      return a;
    };
    this.ax = f(this.ax);
    this.az = f(this.az);
    this.bx = f(this.bx);
    this.bz = f(this.bz);
    this.len = f(this.len);
    this.shown = f(this.shown);
    this.delay = f(this.delay);
    this.color = u(this.color);
    this.live = u(this.live);
    this.ya = f(this.ya);
    this.yb = f(this.yb);
    this.assisted = u(this.assisted);
    this.used = u(this.used);
    this.capacity = cap;
  }
}

export class BeamRenderer2D {
  readonly group = new Group();
  private cur = new SegTable(64);
  private prev = new SegTable(64);
  private geo: InstancedBufferGeometry;
  private segAttr!: InstancedBufferAttribute;
  private paramAttr!: InstancedBufferAttribute;
  private colorAttr!: InstancedBufferAttribute;
  private yAttr!: InstancedBufferAttribute;
  private coreMat: ShaderMaterial;
  private haloMat: ShaderMaterial;
  private sparks: BillboardCloud;
  private boost = 0;

  constructor(private height = LIGHT_SHEET_Y) {
    this.group.name = 'beams2d';
    const tube = new CylinderGeometry(1, 1, 1, 10, 1, true);
    tube.translate(0, 0.5, 0); // y in [0, 1] along the beam
    // cylinder radial axis is (x, z); remap z -> "up" in the shader
    this.geo = new InstancedBufferGeometry();
    this.geo.setIndex(tube.getIndex());
    this.geo.setAttribute('position', tube.getAttribute('position'));
    this.geo.setAttribute('normal', tube.getAttribute('normal'));
    tube.dispose();
    this.allocAttrs(64);
    this.geo.instanceCount = 0;
    this.coreMat = this.material(CORE_RADIUS, 1.3, 2.0, height);
    this.haloMat = this.material(HALO_RADIUS, 0.42, 1.2, height);
    const core = new Mesh(this.geo, this.coreMat);
    const halo = new Mesh(this.geo, this.haloMat);
    core.renderOrder = 10;
    halo.renderOrder = 11;
    core.frustumCulled = halo.frustumCulled = false;
    core.raycast = halo.raycast = () => {};
    this.sparks = new BillboardCloud(64 * 2, 36, 12);
    this.group.add(core, halo, this.sparks.mesh);
  }

  private material(radius: number, intensity: number, core: number, height: number): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uRadius: { value: radius },
        uHeight: { value: height },
        uTime: { value: 0 },
        uIntensity: { value: intensity },
        uCore: { value: core },
        uBoost: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      ...XR_ADDITIVE,
    });
  }

  private allocAttrs(cap: number): void {
    this.segAttr = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.paramAttr = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.colorAttr = new InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.yAttr = new InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.geo.setAttribute('iY', this.yAttr);
    this.geo.setAttribute('iSeg', this.segAttr);
    this.geo.setAttribute('iParams', this.paramAttr);
    this.geo.setAttribute('iColor', this.colorAttr);
  }

  /**
   * Replace the beam set. A segment that continues an existing one (same
   * colour, start within 2 cm, direction within ~14 deg) keeps its reveal
   * progress; the rest grow in from the source in path order.
   */
  setSegments(segs: BeamSeg[]): void {
    const n = segs.length;
    if (n > this.cur.capacity) {
      const cap = Math.max(n, this.cur.capacity * 2);
      this.cur.resize(cap);
      this.prev.resize(cap);
      this.allocAttrs(cap);
    }
    let assisted = 0;
    for (let i = 0; i < n; i++) if (segs[i].assisted) assisted++;
    this.sparks.ensure(n + assisted * SPARKS_PER_ASSIST);
    // swap buffers: last frame's records become `prev`
    const prev = this.cur;
    this.cur = this.prev;
    this.prev = prev;
    prev.used.fill(0, 0, prev.count);
    const cur = this.cur;
    cur.count = n;
    let firstFresh = Infinity;
    for (let i = 0; i < n; i++) {
      const s = segs[i];
      const ax = s.a[0];
      const az = s.a[1];
      const dx = s.b[0] - ax;
      const dz = s.b[1] - az;
      const len = Math.sqrt(dx * dx + dz * dz);
      cur.ax[i] = ax;
      cur.az[i] = az;
      cur.bx[i] = s.b[0];
      cur.bz[i] = s.b[1];
      cur.len[i] = len;
      cur.color[i] = s.color;
      cur.live[i] = s.live ? 1 : 0;
      cur.assisted[i] = s.assisted ? 1 : 0;
      cur.ya[i] = s.ya ?? this.height;
      cur.yb[i] = s.yb ?? this.height;
      let match = -1;
      for (let j = 0; j < prev.count; j++) {
        if (prev.used[j] || prev.color[j] !== s.color) continue;
        const ox = prev.ax[j] - ax;
        const oz = prev.az[j] - az;
        if (ox * ox + oz * oz > 0.0004) continue;
        const pl = prev.len[j];
        if (pl > 1e-5 && len > 1e-5) {
          const dot = ((prev.bx[j] - prev.ax[j]) * dx + (prev.bz[j] - prev.az[j]) * dz) / (pl * len);
          if (dot < 0.97) continue;
        }
        match = j;
        break;
      }
      if (match >= 0) {
        prev.used[match] = 1;
        cur.shown[i] = Math.min(prev.shown[match], len);
        cur.delay[i] = prev.delay[match];
      } else {
        cur.shown[i] = 0;
        cur.delay[i] = -1; // fresh, resolved below
        if (s.d0 < firstFresh) firstFresh = s.d0;
      }
    }
    for (let i = 0; i < n; i++) {
      if (cur.delay[i] === -1 && cur.shown[i] === 0) {
        const d0 = segs[i].d0;
        cur.delay[i] = Math.max(0, (d0 - firstFresh) / GROW_SPEED);
      }
    }
    for (let i = 0; i < n; i++) {
      const c = lightColor(cur.color[i]);
      this.colorAttr.setXYZ(i, c.r, c.g, c.b);
    }
    this.colorAttr.needsUpdate = true;
  }

  /** Brighten everything (solve flourish). 0 = normal. */
  setBoost(v: number): void {
    this.boost = v;
  }

  update(dt: number, time: number): void {
    const cur = this.cur;
    const seg = this.segAttr.array as Float32Array;
    const par = this.paramAttr.array as Float32Array;
    const sparks = this.sparks;
    let sp = 0;
    for (let i = 0; i < cur.count; i++) {
      if (cur.delay[i] > 0) cur.delay[i] = Math.max(0, cur.delay[i] - dt);
      const len = cur.len[i];
      if (cur.delay[i] <= 0 && cur.shown[i] < len) cur.shown[i] = Math.min(len, cur.shown[i] + GROW_SPEED * dt);
      const shown = cur.shown[i];
      const u = len > 1e-6 ? shown / len : 0;
      const ax = cur.ax[i];
      const az = cur.az[i];
      const ex = ax + (cur.bx[i] - ax) * u;
      const ez = az + (cur.bz[i] - az) * u;
      seg[i * 4] = ax;
      seg[i * 4 + 1] = az;
      seg[i * 4 + 2] = ex;
      seg[i * 4 + 3] = ez;
      const ys = this.yAttr.array as Float32Array;
      const ya = cur.ya[i];
      const ey = ya + (cur.yb[i] - ya) * u;
      ys[i * 2] = ya;
      ys[i * 2 + 1] = ey;
      const live = cur.live[i];
      par[i * 4] = live ? 0.6 : 1;
      par[i * 4 + 1] = shown > 1e-5 ? (live ? 0.5 : 1) : 0;
      par[i * 4 + 2] = live;
      par[i * 4 + 3] = (i * 0.618) % 1;
      if (shown <= 1e-5) continue;
      // glint at the beam head / impact point
      const c = lightColor(cur.color[i]);
      const growing = shown < len - 1e-5;
      const tw = 0.85 + 0.15 * Math.sin(time * 11 + i * 2.3);
      const gi = (live ? 0.35 : 0.7) * tw * (growing ? 1.6 : 1);
      sparks.set(sp++, ex, ey, ez, growing ? 0.016 : 0.011, c.r, c.g, c.b, gi * (1 + this.boost));
      if (cur.assisted[i]) {
        for (let k = 0; k < SPARKS_PER_ASSIST; k++) {
          const f = (time * 0.45 + k / SPARKS_PER_ASSIST + i * 0.37) % 1;
          if (f > u) continue;
          const wob = Math.sin(time * 7 + k * 3.1) * 0.0018;
          const nx = -(cur.bz[i] - az) / (len || 1);
          const nz = (cur.bx[i] - ax) / (len || 1);
          const x = ax + (cur.bx[i] - ax) * f + nx * wob;
          const z = az + (cur.bz[i] - az) * f + nz * wob;
          const twk = 0.5 + 0.5 * Math.sin(time * 17 + k * 5.7 + i);
          sparks.set(sp++, x, this.height + wob * 0.6, z, 0.0055, 1, 1, 1, 0.45 * twk);
        }
      }
    }
    this.geo.instanceCount = cur.count;
    this.segAttr.needsUpdate = true;
    this.paramAttr.needsUpdate = true;
    this.yAttr.needsUpdate = true;
    sparks.commit(sp);
    this.coreMat.uniforms.uTime.value = time;
    this.haloMat.uniforms.uTime.value = time;
    this.coreMat.uniforms.uBoost.value = this.boost * 1.2;
    this.haloMat.uniforms.uBoost.value = this.boost * 2;
  }

  dispose(): void {
    this.geo.dispose();
    this.coreMat.dispose();
    this.haloMat.dispose();
    this.sparks.dispose();
    this.group.removeFromParent();
  }
}
