/**
 * Level props for the light-bench ("a night glass studio on your own desk"):
 * brass lanterns, liquid-light wells, quartz crystals, hush stones, frosted
 * walls and silver mirrors, plus the shared palette, procedural matcaps and an
 * instanced additive billboard cloud reused by the beams and the ambience.
 *
 * Every material is unlit (ShaderMaterial / matcap) so the props look the
 * same whatever lighting the host scene has, and read well over passthrough.
 * All props live in bench space: y = 0 is the bench top, metres.
 */

import {
  AddEquation,
  CustomBlending,
  OneFactor,
  SrcAlphaFactor,
  ZeroFactor,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color as ThreeColor,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  BoxGeometry,
} from '@iwsdk/core';
import type { ColorMask } from '../../core/types.js';

// ------------------------------------------------------------------ palette

/** Display colours per additive light mask; tuned to read over passthrough. */
const LIGHT_HEX: Record<number, number> = {
  0: 0x2a2f3a,
  1: 0xff4d5e, // red
  2: 0x3dff8b, // green
  4: 0x4d8dff, // blue
  3: 0xffe14d, // yellow
  5: 0xff4dff, // magenta
  6: 0x4dfff3, // cyan
  7: 0xfff6e8, // white
};
const colorCache = new Map<number, ThreeColor>();

/** Shared, read-only display colour for a light mask (do not mutate). */
export function lightColor(mask: ColorMask): ThreeColor {
  let c = colorCache.get(mask & 7);
  if (!c) {
    c = new ThreeColor(LIGHT_HEX[mask & 7] ?? 0xffffff);
    colorCache.set(mask & 7, c);
  }
  return c;
}

/** Height (m) of the horizontal light sheet above the bench top. */
export const LIGHT_SHEET_Y = 0.02;

/**
 * Additive blending that adds colour but leaves destination alpha alone. In
 * passthrough (alpha-blend) sessions the compositor treats framebuffer alpha
 * as coverage, so plain AdditiveBlending (which also adds alpha) would turn
 * every glow halo into an opaque dark disc over the real room.
 */
export const XR_ADDITIVE = {
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: SrcAlphaFactor,
  blendDst: OneFactor,
  blendSrcAlpha: ZeroFactor,
  blendDstAlpha: OneFactor,
} as const;

/** The "sour" red-violet of an awake hush stone. */
export const HUSH_COLOR = new ThreeColor(0.95, 0.16, 0.55);

/** Shared time uniform: every prop shader reads it, BenchView writes it once a frame. */
export interface TimeUniform {
  value: number;
}

// ----------------------------------------------------------------- matcaps

type MatcapKind = 'brass' | 'silver' | 'obsidian';
const matcaps = new Map<MatcapKind, CanvasTexture>();

/** Procedural studio matcap (soft key light top-left, cool night fill below). */
export function matcap(kind: MatcapKind): CanvasTexture {
  const cached = matcaps.get(kind);
  if (cached) return cached;
  const s = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = s;
  const g = canvas.getContext('2d')!;
  const spec = {
    brass: {
      stops: ['#ffe9b0', '#d9a64c', '#8a5d1e', '#3a2408', '#160d03'],
      fill: 'rgba(110,130,190,0.35)',
      hi: 'rgba(255,250,225,0.95)',
    },
    silver: {
      stops: ['#ffffff', '#dfe6f0', '#9aa3b2', '#3c414c', '#14161b'],
      fill: 'rgba(140,160,220,0.45)',
      hi: 'rgba(255,255,255,1)',
    },
    obsidian: {
      stops: ['#5a6178', '#272b3a', '#12141c', '#08090e', '#030304'],
      fill: 'rgba(90,100,160,0.30)',
      hi: 'rgba(205,215,255,0.9)',
    },
  }[kind];
  const body = g.createRadialGradient(s * 0.38, s * 0.32, s * 0.02, s * 0.5, s * 0.5, s * 0.5);
  spec.stops.forEach((c, i) => body.addColorStop(i / (spec.stops.length - 1), c));
  g.fillStyle = body;
  g.fillRect(0, 0, s, s);
  // cool fill from below (the night room), as a crescent
  const fill = g.createRadialGradient(s * 0.55, s * 0.95, 0, s * 0.55, s * 0.95, s * 0.45);
  fill.addColorStop(0, spec.fill);
  fill.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = fill;
  g.fillRect(0, 0, s, s);
  // tight key highlight
  const hi = g.createRadialGradient(s * 0.33, s * 0.27, 0, s * 0.33, s * 0.27, s * 0.13);
  hi.addColorStop(0, spec.hi);
  hi.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hi;
  g.fillRect(0, 0, s, s);
  // a second, softer warm kick on the right (the lamps)
  const kick = g.createRadialGradient(s * 0.82, s * 0.48, 0, s * 0.82, s * 0.48, s * 0.12);
  kick.addColorStop(0, kind === 'obsidian' ? 'rgba(255,190,140,0.25)' : 'rgba(255,220,170,0.45)');
  kick.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = kick;
  g.fillRect(0, 0, s, s);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  matcaps.set(kind, tex);
  return tex;
}

export function matcapMaterial(kind: MatcapKind, tint = 0xffffff): MeshMatcapMaterial {
  return new MeshMatcapMaterial({ matcap: matcap(kind), color: tint });
}

/**
 * Concatenates indexed geometries that share position/normal/uv layouts into
 * one (fewer draw calls for static props). Inputs are disposed.
 */
export function mergeGeometries(geos: BufferGeometry[]): BufferGeometry {
  let verts = 0;
  let idx = 0;
  for (const g of geos) {
    verts += g.getAttribute('position').count;
    idx += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(verts * 3);
  const nor = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const index = new Uint32Array(idx);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    const n = g.getAttribute('position').count;
    pos.set((g.getAttribute('position') as BufferAttribute).array as Float32Array, vo * 3);
    if (g.getAttribute('normal')) nor.set((g.getAttribute('normal') as BufferAttribute).array as Float32Array, vo * 3);
    if (g.getAttribute('uv')) uv.set((g.getAttribute('uv') as BufferAttribute).array as Float32Array, vo * 2);
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) index[io + i] = src[i] + vo;
      io += src.length;
    } else {
      for (let i = 0; i < n; i++) index[io + i] = vo + i;
      io += n;
    }
    vo += n;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}

// ------------------------------------------------------- billboard cloud

const cloudVertex = /* glsl */ `
  attribute vec4 iPos; // xyz, size (m)
  attribute vec4 iCol; // rgb, intensity
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos.xyz, 1.0);
    mv.xy += position.xy * iPos.w;
    vUv = position.xy * 2.0;
    vCol = iCol;
    gl_Position = projectionMatrix * mv;
  }
`;

const cloudFragment = /* glsl */ `
  uniform float uCore;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    float d2 = dot(vUv, vUv);
    if (d2 > 1.0) discard;
    float a = exp(-d2 * 5.0) * 0.55 + exp(-d2 * uCore) * 0.9;
    a *= 1.0 - d2;
    gl_FragColor = vec4(vCol.rgb * (vCol.a * a), 1.0);
  }
`;

/**
 * Many additive, camera-facing soft dots in one draw call. Callers write
 * slots with `set` and call `commit` once per frame; no allocation.
 */
export class BillboardCloud {
  readonly mesh: Mesh;
  private geo: InstancedBufferGeometry;
  private posAttr!: InstancedBufferAttribute;
  private colAttr!: InstancedBufferAttribute;
  pos!: Float32Array;
  col!: Float32Array;
  capacity = 0;

  /** @param core sharpness of the bright centre (higher = tighter point). */
  constructor(capacity: number, core = 30, renderOrder = 12) {
    const plane = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.setIndex(plane.getIndex());
    this.geo.setAttribute('position', plane.getAttribute('position'));
    plane.dispose();
    this.allocate(capacity);
    const mat = new ShaderMaterial({
      vertexShader: cloudVertex,
      fragmentShader: cloudFragment,
      uniforms: { uCore: { value: core } },
      transparent: true,
      depthWrite: false,
      ...XR_ADDITIVE,
    });
    this.mesh = new Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.raycast = () => {};
    this.geo.instanceCount = 0;
  }

  private allocate(capacity: number): void {
    const pos = new Float32Array(capacity * 4);
    const col = new Float32Array(capacity * 4);
    if (this.pos) {
      pos.set(this.pos);
      col.set(this.col);
    }
    this.pos = pos;
    this.col = col;
    this.capacity = capacity;
    this.posAttr = new InstancedBufferAttribute(pos, 4);
    this.colAttr = new InstancedBufferAttribute(col, 4);
    this.geo.setAttribute('iPos', this.posAttr);
    this.geo.setAttribute('iCol', this.colAttr);
  }

  /** Grow (allocates; call outside the frame loop when possible). */
  ensure(capacity: number): void {
    if (capacity > this.capacity) this.allocate(Math.max(capacity, this.capacity * 2));
  }

  set(i: number, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number): void {
    const k = i * 4;
    this.pos[k] = x;
    this.pos[k + 1] = y;
    this.pos[k + 2] = z;
    this.pos[k + 3] = size;
    this.col[k] = r;
    this.col[k + 1] = g;
    this.col[k + 2] = b;
    this.col[k + 3] = a;
  }

  /** Upload the first `count` slots. */
  commit(count: number): void {
    this.geo.instanceCount = count;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
    this.mesh.removeFromParent();
  }
}

// --------------------------------------------------------------- glyphs

let glyphTexture: CanvasTexture | null = null;

/** Colour-blind glyph atlas: cell 0 = triangle (red), 1 = circle (green), 2 = square (blue). */
export function glyphAtlas(): CanvasTexture {
  if (glyphTexture) return glyphTexture;
  const cell = 128;
  const canvas = document.createElement('canvas');
  canvas.width = cell * 3;
  canvas.height = cell;
  const g = canvas.getContext('2d')!;
  const shapes: ((x: number) => void)[] = [
    (x) => {
      g.beginPath();
      g.moveTo(x + 64, 18);
      g.lineTo(x + 114, 106);
      g.lineTo(x + 14, 106);
      g.closePath();
    },
    (x) => {
      g.beginPath();
      g.arc(x + 64, 64, 44, 0, Math.PI * 2);
    },
    (x) => {
      g.beginPath();
      g.rect(x + 24, 24, 80, 80);
    },
  ];
  shapes.forEach((shape, i) => {
    const x = i * cell;
    g.lineJoin = 'round';
    shape(x);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.fill();
    g.lineWidth = 12;
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.stroke();
  });
  glyphTexture = new CanvasTexture(canvas);
  glyphTexture.colorSpace = SRGBColorSpace;
  return glyphTexture;
}

/** A flat glyph quad (lying on the bench) using one atlas cell. */
function glyphGeometry(cellIndex: number, size: number): PlaneGeometry {
  const geo = new PlaneGeometry(size, size);
  const uv = geo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (cellIndex + uv.getX(i)) / 3);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// ------------------------------------------------------------------ lamps

const lensFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOn;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    float core = exp(-d * d * 2.5);
    float ring = smoothstep(0.62, 0.8, d) * smoothstep(1.0, 0.86, d);
    float flick = 0.94 + 0.06 * sin(uTime * 7.3) * sin(uTime * 3.1);
    vec3 c = mix(uColor, vec3(1.0), core * 0.65 * uOn) * (0.18 + uOn * 1.1 * flick) * (0.55 + 0.45 * core);
    c += ring * vec3(1.0, 0.92, 0.75) * 0.35;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const uvVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const spillVertex = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const spillFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOn;
  uniform float uLen;
  varying vec2 vP;
  void main() {
    float x = vP.x / uLen;
    float w = 0.004 + vP.x * 0.32;
    float side = 1.0 - smoothstep(w * 0.25, w, abs(vP.y));
    float fall = smoothstep(0.0, 0.08, x) * pow(max(1.0 - x, 0.0), 2.2);
    gl_FragColor = vec4(uColor * side * fall * 0.42 * uOn, 1.0);
  }
`;

/** A small brass lantern whose glowing lens points along the beam. */
export class LampProp {
  readonly group = new Group();
  private lensMat: ShaderMaterial;
  private spillMat: ShaderMaterial;
  private on = 1;
  private target = 1;
  /** Lens centre (bench space). */
  readonly lensPos = new Vector2();

  constructor(p: [number, number], angle: number, color: ColorMask, time: TimeUniform, beamHeight: number) {
    this.group.name = 'lamp';
    this.group.position.set(p[0], 0, p[1]);
    this.group.rotation.y = -angle; // local +X = beam direction
    const brass = matcapMaterial('brass');
    const darkBrass = matcapMaterial('brass', 0x8a7a66);
    const y = beamHeight;
    const bright: BufferGeometry[] = [];
    const dark: BufferGeometry[] = [];
    // foot, stem, barrel
    dark.push(new CylinderGeometry(0.0125, 0.015, 0.004, 28).translate(-0.004, 0.002, 0));
    bright.push(new TorusGeometry(0.0128, 0.0011, 8, 28).rotateX(Math.PI / 2).translate(-0.004, 0.004, 0));
    bright.push(new CylinderGeometry(0.0028, 0.0042, y - 0.006, 12).translate(-0.004, 0.004 + (y - 0.006) / 2, 0));
    dark.push(new CylinderGeometry(0.0085, 0.0085, 0.024, 24, 1, true).rotateZ(-Math.PI / 2).translate(-0.004, y, 0));
    // decorative bands and the lens hood
    for (const bx of [-0.0155, -0.006, 0.0082]) {
      const hood = bx > 0.008;
      bright.push(new TorusGeometry(hood ? 0.0094 : 0.0089, hood ? 0.0019 : 0.001, 8, 28).rotateY(Math.PI / 2).translate(bx, y, 0));
    }
    // back cap dome
    bright.push(
      new SphereGeometry(0.0086, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)
        .scale(1, 0.5, 1)
        .rotateZ(Math.PI / 2)
        .translate(-0.016, y, 0),
    );
    // handle arching over the barrel, and a finial
    bright.push(new TorusGeometry(0.0066, 0.001, 6, 20, Math.PI).rotateY(Math.PI / 2).translate(-0.004, y + 0.0085, 0));
    bright.push(new SphereGeometry(0.0016, 10, 8).translate(-0.004, y + 0.0155, 0));
    this.group.add(new Mesh(mergeGeometries(bright), brass), new Mesh(mergeGeometries(dark), darkBrass));

    this.lensMat = new ShaderMaterial({
      vertexShader: uvVertex,
      fragmentShader: lensFragment,
      uniforms: { uColor: { value: lightColor(color).clone() }, uOn: { value: 1 }, uTime: time },
    });
    const lens = new Mesh(new CircleGeometry(0.0076, 28).rotateY(Math.PI / 2).translate(0.0086, y, 0), this.lensMat);
    this.group.add(lens);

    const len = 0.075;
    this.spillMat = new ShaderMaterial({
      vertexShader: spillVertex,
      fragmentShader: spillFragment,
      uniforms: { uColor: { value: lightColor(color).clone() }, uOn: { value: 1 }, uLen: { value: len } },
      transparent: true,
      depthWrite: false,
      ...XR_ADDITIVE,
    });
    const spill = new Mesh(new PlaneGeometry(len, 0.06).rotateX(-Math.PI / 2).translate(len / 2 + 0.006, 0.0006, 0), this.spillMat);
    spill.renderOrder = -4;
    this.group.add(spill);
    this.lensPos.set(p[0] + Math.cos(angle) * 0.0125, p[1] + Math.sin(angle) * 0.0125);
  }

  setActive(on: boolean): void {
    this.target = on ? 1 : 0;
  }

  /** Returns the current lens brightness (0..1) for the halo. */
  update(dt: number): number {
    this.on += (this.target - this.on) * Math.min(1, dt * 6);
    this.lensMat.uniforms.uOn.value = this.on;
    this.spillMat.uniforms.uOn.value = this.on;
    return this.on;
  }
}

// ------------------------------------------------------------------ wells

const poolFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uR;
  uniform float uTime;
  uniform float uOn;
  uniform float uSeed;
  varying vec2 vP;
  float caustic(vec2 p, float t) {
    float v = 0.0;
    vec2 q = p;
    for (int k = 0; k < 3; k++) {
      float fk = float(k) + 1.0;
      q += 0.55 * vec2(sin(q.y * 1.3 + t * 0.8 * fk + uSeed), cos(q.x * 1.1 - t * 0.6 * fk)) / fk;
      v += abs(sin(q.x * 1.7 * fk + t * 0.5) * sin(q.y * 1.9 * fk - t * 0.4));
    }
    return pow(clamp(1.0 - v / 3.0, 0.0, 1.0), 4.0);
  }
  void main() {
    float d = length(vP) / uR;
    if (d > 1.0) discard;
    float t = uTime;
    vec2 p = vP * (7.5 / max(uR, 0.01));
    float c = caustic(p, t);
    float ripple = 0.5 + 0.5 * sin(d * 26.0 - t * 2.4);
    float body = smoothstep(1.0, 0.82, d);
    float meniscus = smoothstep(0.80, 0.92, d) * smoothstep(1.0, 0.94, d);
    float depth = 0.45 + 0.55 * (1.0 - d * d);
    vec3 col = uColor * body * depth * (0.55 + 0.25 * ripple);
    col += mix(uColor, vec3(1.0), 0.5) * c * body * 1.6;
    col += mix(uColor, vec3(1.0), 0.4) * meniscus * 0.9;
    gl_FragColor = vec4(col * uOn, 1.0);
  }
`;

/** A recessed pool of liquid light with animated caustics and a brass lip. */
export class WellProp {
  readonly group = new Group();
  readonly mat: ShaderMaterial;

  constructor(p: [number, number], r: number, color: ColorMask, time: TimeUniform, seed: number) {
    this.group.name = 'well';
    this.group.position.set(p[0], 0, p[1]);
    this.mat = new ShaderMaterial({
      vertexShader: spillVertex,
      fragmentShader: poolFragment,
      uniforms: {
        uColor: { value: lightColor(color).clone() },
        uR: { value: r },
        uTime: time,
        uOn: { value: 1 },
        uSeed: { value: seed * 1.37 },
      },
      transparent: true,
      depthWrite: false,
      ...XR_ADDITIVE,
    });
    const pool = new Mesh(new CircleGeometry(r, 64).rotateX(-Math.PI / 2).translate(0, -0.0012, 0), this.mat);
    pool.renderOrder = -5;
    // dark recess under the liquid so it reads as sunk into the slab
    const recess = new Mesh(
      new CircleGeometry(r * 1.02, 48).rotateX(-Math.PI / 2).translate(0, -0.0018, 0),
      new MeshBasicMaterial({ color: 0x020205, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    recess.renderOrder = -6;
    const lip = new Mesh(new TorusGeometry(r + 0.0012, 0.0014, 8, 64).rotateX(Math.PI / 2).translate(0, 0.0002, 0), matcapMaterial('brass'));
    this.group.add(recess, pool, lip);
  }
}

// --------------------------------------------------------------- crystals

const crystalVertex = /* glsl */ `
  varying vec3 vViewPos;
  varying float vH;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    vH = position.y;
    gl_Position = projectionMatrix * mv;
  }
`;

const crystalFragment = /* glsl */ `
  uniform vec3 uGlowColor;
  uniform vec3 uTint;
  uniform float uGlow;
  uniform float uHeight;
  uniform float uSeed;
  varying vec3 vViewPos;
  varying float vH;
  void main() {
    vec3 n = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    vec3 v = normalize(-vViewPos);
    if (dot(n, v) < 0.0) n = -n;
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 2.5);
    vec3 L = normalize(vec3(-0.4, 0.75, 0.55));
    float spec = pow(max(dot(n, normalize(L + v)), 0.0), 48.0);
    float facet = 0.5 + 0.5 * dot(n, L);
    float h = clamp(vH / uHeight, 0.0, 1.0);
    float veil = 0.5 + 0.5 * sin(vH * 310.0 + uSeed * 6.0 + facet * 4.0);
    float g = uGlow;
    vec3 glass = uTint * (0.06 + 0.2 * facet);
    vec3 inner = uGlowColor * g * (0.3 + 1.1 * pow(h, 1.3)) * (0.72 + 0.28 * veil);
    vec3 col = glass + inner + vec3(0.85, 0.92, 1.0) * (fres * 0.45 + spec * 0.85) + uGlowColor * fres * g * 0.5;
    float alpha = clamp(0.3 + fres * 0.45 + spec + g * 0.4, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

/** Pillar heights (m) cycled by crystal index, for a little visual rhythm. */
export const CRYSTAL_HEIGHTS = [0.062, 0.084, 0.05, 0.096, 0.07, 0.044, 0.088, 0.056];

const tmpObj = new Object3D();

function quartzGeometry(h: number, r: number): LatheGeometry {
  const pts = [new Vector2(0, 0), new Vector2(r * 0.92, 0), new Vector2(r, h * 0.12), new Vector2(r * 0.96, h * 0.74), new Vector2(0, h)];
  return new LatheGeometry(pts, 6, Math.PI / 6);
}

/** A faceted quartz cluster on an obsidian plinth, colour glyphs at its foot. */
export class CrystalProp {
  readonly group = new Group();
  /** Bobbing part (pillars only). */
  readonly cluster = new Group();
  readonly mat: ShaderMaterial;
  readonly height: number;
  readonly radius: number;
  readonly glyphs: { comp: number; mat: MeshBasicMaterial }[] = [];
  readonly ringMat: MeshBasicMaterial;
  readonly ring: Mesh;

  constructor(p: [number, number], color: ColorMask, index: number) {
    this.group.name = 'crystal';
    this.group.position.set(p[0], 0, p[1]);
    const h = CRYSTAL_HEIGHTS[index % CRYSTAL_HEIGHTS.length];
    const r = 0.0105 + 0.02 * (h - 0.044);
    this.height = h;
    this.radius = r;
    this.mat = new ShaderMaterial({
      vertexShader: crystalVertex,
      fragmentShader: crystalFragment,
      uniforms: {
        uGlowColor: { value: lightColor(color).clone() },
        uTint: { value: new ThreeColor(0.75, 0.82, 1.0).lerp(lightColor(color), 0.18) },
        uGlow: { value: 0 },
        uHeight: { value: h },
        uSeed: { value: index * 0.71 },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    // three pillars baked into one mesh: a main point and two leaning side points
    const place = (geo: BufferGeometry, x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
      tmpObj.position.set(x, y, z);
      tmpObj.rotation.set(rx, ry, rz);
      tmpObj.updateMatrix();
      return geo.applyMatrix4(tmpObj.matrix);
    };
    const pillars = new Mesh(
      mergeGeometries([
        place(quartzGeometry(h * 0.46, r * 0.62), -r * 1.05, 0.002, r * 0.35, 0.15, 0.3, 0.42),
        place(quartzGeometry(h * 0.33, r * 0.5), r * 1.0, 0.002, -r * 0.25, -0.1, 1.1, -0.48),
        place(quartzGeometry(h, r), 0, 0.0025, 0, 0, index * 0.6, 0),
      ]),
      this.mat,
    );
    pillars.renderOrder = 2;
    this.cluster.add(pillars);

    const plinth = new Mesh(
      new CylinderGeometry(r * 1.75, r * 1.95, 0.003, 6).translate(0, 0.0015, 0),
      matcapMaterial('obsidian'),
    );
    plinth.rotation.y = Math.PI / 6;
    this.group.add(plinth, this.cluster);

    // colour-blind glyphs in front of the plinth (toward the player)
    const comps = [1, 2, 4].filter((c) => color & c);
    const size = 0.012;
    comps.forEach((comp, k) => {
      const mat = new MeshBasicMaterial({
        map: glyphAtlas(),
        color: lightColor(comp),
        transparent: true,
        depthWrite: false,
        opacity: 0.5,
      });
      const m = new Mesh(glyphGeometry(comp === 1 ? 0 : comp === 2 ? 1 : 2, size), mat);
      m.position.set((k - (comps.length - 1) / 2) * size * 1.25, 0.0007, r * 1.95 + size * 0.85);
      m.renderOrder = 1;
      this.group.add(m);
      this.glyphs.push({ comp, mat });
    });

    this.ringMat = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      ...XR_ADDITIVE,
    });
    this.ring = new Mesh(new RingGeometry(r * 2.3, r * 2.3 + 0.0018, 48).rotateX(-Math.PI / 2).translate(0, 0.0008, 0), this.ringMat);
    this.ring.visible = false;
    this.group.add(this.ring);
  }
}

// ------------------------------------------------------------ hush stones

const pebbleVertex = /* glsl */ `
  varying vec3 vObj;
  varying vec3 vN;
  void main() {
    vObj = position;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const pebbleFragment = /* glsl */ `
  uniform sampler2D uMatcap;
  uniform float uOpen;
  uniform float uTime;
  uniform vec3 uGlow;
  varying vec3 vObj;
  varying vec3 vN;
  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h);
  }
  float lowerLid(float u) { return -0.20 * (1.0 - u * u) + 0.04; }
  void main() {
    vec3 n = normalize(vN);
    vec3 base = texture2D(uMatcap, n.xy * 0.48 + 0.5).rgb;
    // eye frame on the upper-front of the pebble (unit-sphere coordinates)
    vec3 eyeN = normalize(vec3(0.0, 0.8, 0.6));
    vec3 tV = normalize(vec3(0.0, 0.6, -0.8));
    float facing = dot(normalize(vObj), eyeN);
    vec2 e = vec2(vObj.x / 0.64, dot(vObj, tV) / 0.6);
    float inFace = smoothstep(0.45, 0.6, facing);
    float u = e.x;
    float lo = lowerLid(u);
    float span = max(1.0 - u * u, 0.0);
    float up = lo + uOpen * 0.7 * span;
    // carved lid line and lashes
    float lid = abs(e.y - lo);
    float lash = 1e3;
    for (int k = 0; k < 5; k++) {
      float uk = -0.6 + 0.3 * float(k);
      vec2 a = vec2(uk, lowerLid(uk));
      vec2 dir = normalize(vec2(uk * 0.6, -1.0));
      lash = min(lash, segDist(e, a, a + dir * 0.17));
    }
    float line = min(lid, lash);
    float uMask = 1.0 - smoothstep(0.95, 1.05, abs(u));
    float groove = (1.0 - smoothstep(0.03, 0.055, line)) * uMask * inFace;
    // carved channel with a pale silver-violet inlay, so the closed eye reads at arm's length
    vec3 col = base * (1.0 - 0.6 * groove);
    col += vec3(0.62, 0.6, 0.85) * 0.55 * (1.0 - smoothstep(0.012, 0.03, line)) * uMask * inFace;
    // open eye: glowing sclera, iris and a slit pupil
    float inside = step(abs(u), 1.0) * smoothstep(lo, lo + 0.03, e.y) * (1.0 - smoothstep(up - 0.03, up, e.y)) * inFace;
    float mid = (lo + up) * 0.5;
    vec2 ic = vec2(0.0, mid);
    float id = length((e - ic) * vec2(1.0, 1.0));
    float iris = 1.0 - smoothstep(0.2, 0.24, id);
    float pupil = 1.0 - smoothstep(0.035, 0.06, abs(e.x) + max(abs(e.y - mid) - 0.12, 0.0) * 0.6);
    float pulse = 0.8 + 0.2 * sin(uTime * 9.0);
    vec3 eye = uGlow * (0.8 + 0.6 * iris) * pulse;
    eye += vec3(1.0, 0.75, 0.9) * (1.0 - smoothstep(0.0, 0.05, up - e.y)) * 0.5;
    eye = mix(eye, vec3(0.05, 0.0, 0.03), pupil * iris * 0.9);
    eye += vec3(1.0, 0.8, 0.9) * exp(-pow(length(e - ic - vec2(-0.08, 0.07)) * 14.0, 2.0)) * 0.6;
    col = mix(col, eye, inside * clamp(uOpen * 1.6, 0.0, 1.0));
    // a faint sour rim when awake
    float rim = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 3.0);
    col += uGlow * rim * uOpen * 0.35;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** A rounded obsidian pebble with a carved, closed eye that opens when lit. */
export class HushProp {
  readonly group = new Group();
  readonly body = new Group();
  readonly mat: ShaderMaterial;
  open = 0;
  awake = false;

  constructor(p: [number, number], time: TimeUniform, index: number) {
    this.group.name = 'hush';
    this.group.position.set(p[0], 0, p[1]);
    this.mat = new ShaderMaterial({
      vertexShader: pebbleVertex,
      fragmentShader: pebbleFragment,
      uniforms: {
        uMatcap: { value: matcap('obsidian') },
        uOpen: { value: 0 },
        uTime: time,
        uGlow: { value: HUSH_COLOR.clone() },
      },
    });
    const pebble = new Mesh(new SphereGeometry(1, 40, 24), this.mat);
    pebble.scale.set(0.0165, 0.0135, 0.0135);
    pebble.position.y = 0.0062;
    this.body.rotation.y = (index % 2 ? 1 : -1) * 0.12;
    this.body.add(pebble);
    this.group.add(this.body);
  }
}

// ------------------------------------------------------- walls & mirrors

const paneVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vViewPos;
  varying vec3 vLocal;
  void main() {
    vUv = uv;
    vLocal = position;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const frostFragment = /* glsl */ `
  uniform vec2 uSize;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vViewPos;
  varying vec3 vLocal;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(-vViewPos);
    float fres = pow(1.0 - abs(dot(n, v)), 2.0);
    float ex = min(vUv.x, 1.0 - vUv.x) * uSize.x;
    float ey = min(vUv.y, 1.0 - vUv.y) * uSize.y;
    float edge = 1.0 - smoothstep(0.0005, 0.0028, min(ex, ey));
    float top = smoothstep(uSize.y * 0.86, uSize.y, vLocal.y + uSize.y * 0.5);
    float grain = hash(floor(vLocal.xy * 3000.0) + floor(vLocal.z * 3000.0));
    float grad = 1.0 - clamp((vLocal.y + uSize.y * 0.5) / uSize.y, 0.0, 1.0);
    vec3 col = vec3(0.72, 0.8, 0.95) * (0.32 + 0.22 * grad + 0.08 * grain);
    col += vec3(0.9, 0.95, 1.0) * (edge * 0.75 + top * 0.35 + fres * 0.25);
    float alpha = clamp(0.30 + 0.22 * grad + 0.05 * grain + edge * 0.5 + top * 0.25 + fres * 0.2, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

const mirrorFragment = /* glsl */ `
  uniform vec2 uSize;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vViewPos;
  varying vec3 vLocal;
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(-vViewPos);
    vec3 r = reflect(-v, n);
    vec3 rw = (vec4(r, 0.0) * viewMatrix).xyz;
    float y = rw.y;
    vec3 sky = mix(vec3(0.22, 0.23, 0.28), vec3(0.85, 0.88, 0.95), smoothstep(-0.4, 0.6, y));
    float band = exp(-pow((y + 0.02) * 7.0, 2.0));
    float az = atan(rw.z, rw.x);
    float panels = pow(abs(sin(az * 2.5)), 24.0) * smoothstep(0.05, 0.45, y);
    float sweep = 0.5 + 0.5 * sin(dot(vLocal.xy, vec2(120.0, 40.0)) + rw.x * 6.0);
    vec3 col = sky * (0.85 + 0.15 * sweep) + vec3(1.0, 0.86, 0.66) * band * 0.45 + vec3(0.9, 0.95, 1.0) * panels * 0.5;
    float ex = min(vUv.x, 1.0 - vUv.x) * uSize.x;
    float ey = min(vUv.y, 1.0 - vUv.y) * uSize.y;
    float edge = 1.0 - smoothstep(0.0004, 0.0022, min(ex, ey));
    float top = smoothstep(uSize.y * 0.9, uSize.y, vLocal.y + uSize.y * 0.5);
    col = col * vec3(0.9, 0.94, 1.0) + vec3(1.0) * (edge * 0.85 + top * 0.6);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** A wall (frosted glass) or fixed mirror (polished silver) standing on a 2D segment. */
export class PaneProp {
  readonly group = new Group();
  readonly mid: [number, number];

  constructor(a: [number, number], b: [number, number], kind: 'wall' | 'mirror') {
    this.group.name = kind;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.max(Math.hypot(dx, dz), 0.002);
    const h = kind === 'wall' ? 0.04 : 0.038;
    const thick = kind === 'wall' ? 0.0045 : 0.0028;
    this.mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    this.group.position.set(this.mid[0], 0, this.mid[1]);
    this.group.rotation.y = -Math.atan2(dz, dx);
    const mat = new ShaderMaterial({
      vertexShader: paneVertex,
      fragmentShader: kind === 'wall' ? frostFragment : mirrorFragment,
      uniforms: { uSize: { value: new Vector2(len, h) } },
      transparent: kind === 'wall',
      depthWrite: kind !== 'wall',
    });
    const pane = new Mesh(new BoxGeometry(len, h, thick), mat);
    pane.position.y = h / 2 + 0.0015;
    pane.renderOrder = kind === 'wall' ? 3 : 0;
    this.group.add(pane);
    // brass (wall) or silver (mirror) shoes along the foot
    const shoe = matcapMaterial(kind === 'wall' ? 'brass' : 'silver', kind === 'wall' ? 0xc8b49a : 0xffffff);
    const rail = mergeGeometries([
      new BoxGeometry(len + 0.003, 0.003, thick + 0.004).translate(0, 0.0015, 0),
      new BoxGeometry(0.004, 0.006, thick + 0.008).translate(-(len / 2 - 0.002), 0.003, 0),
      new BoxGeometry(0.004, 0.006, thick + 0.008).translate(len / 2 - 0.002, 0.003, 0),
    ]);
    this.group.add(new Mesh(rail, shoe));
  }
}
