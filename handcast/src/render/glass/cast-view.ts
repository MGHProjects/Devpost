/**
 * CastView: the visual of one frozen glass hand on the bench.
 *
 * - The pose is baked (bake.ts) relative to the cast's FOOT point: the palm
 *   centre ((wrist + middle knuckle) / 2) projected onto the bench (y = 0).
 *   `root` sits at that point in bench space, so nudging / twisting a cast is
 *   just moving `root` along the bench and rotating it about its +Y axis.
 * - 'glass' draws two meshes sharing one set of uniforms: the
 *   BackSide pass first (the far wall seen through the glass), then the
 *   FrontSide pass, for a believable thick look. 'silver' (opaque) and 'ghost'
 *   (a faint hologram) are one mesh each.
 * - A thin frosted stem from the underside of the palm down to the bench and
 *   a small frosted foot disc (the grab handle, `foot`).
 * - A baked contact shadow on the bench: a 64x64 soft footprint of the hand
 *   (closer glass = darker) plus coloured caustic pools under the fingers that
 *   carry light.
 *
 * update() eases light colours and the selection glow; it does not allocate.
 */
import {
  BufferGeometry, ClampToEdgeWrapping, Color, CylinderGeometry, CustomBlending, DataTexture,
  FrontSide, BackSide, Group, LinearFilter, Mesh, OneFactor, OneMinusSrcAlphaFactor,
  PlaneGeometry, RGBAFormat, ShaderMaterial, UnsignedByteType, Vector2, Vector3,
} from '@iwsdk/core';
import type { HandPose } from '../../core/types';
import { bakePose } from './bake';
import { createGlassMaterial, type GlassKind, type GlassMaterial, type GlassUniforms } from './glass-material';
import type { HandTemplate } from './hand-model';
import { Shatter } from './shatter';

export interface CastViewOptions {
  /** Glass shell offset outside the skin, metres (default 0.0015). */
  inflate?: number;
  /** Bake subdivision levels (default 1; see BakeOptions.subdivide). */
  subdivide?: number;
  /** Base render order (default 10): shadow +0, stem / foot +1, glass +2. */
  renderOrder?: number;
}

const LIGHT_EASE = 7; // 1/s
const SELECT_EASE = 10;
const SHADOW_RES = 64;

function premultipliedBlend(m: ShaderMaterial): ShaderMaterial {
  m.transparent = true;
  m.depthWrite = false;
  m.premultipliedAlpha = true;
  m.blending = CustomBlending;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
  return m;
}

const FROST_VERTEX = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vL = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FROST_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uSelected;
uniform float uOpacity;
uniform float uMolten;
uniform float uShatter;
uniform vec3 uPalmLight;
uniform float uFootRadius;
varying vec3 vW;
varying vec3 vN;
varying vec3 vL;
void main() {
  vec3 V = normalize(cameraPosition - vW);
  vec3 N = normalize(vN);
  float ndv = abs(dot(N, V));
  float fr = pow(1.0 - ndv, 3.0);
  float grain = fract(sin(dot(floor(vL * 3000.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  vec3 col = vec3(0.78, 0.85, 0.92) * (0.07 + 0.6 * fr + 0.03 * grain) + uPalmLight * (0.18 + 0.3 * fr);
  float a = 0.14 + 0.55 * fr + 0.03 * grain;
  // Handle ring around the foot's top edge; breathes when selected.
  float r = length(vL.xz);
  float ring = smoothstep(uFootRadius * 0.72, uFootRadius * 0.86, r) * (1.0 - smoothstep(uFootRadius * 0.9, uFootRadius, r)) * step(0.0015, vL.y);
  float glow = ring * (0.25 + uSelected * (0.9 + 0.4 * sin(uTime * 5.0)));
  col += vec3(0.6, 0.86, 1.0) * glow;
  a = max(a, glow * 0.7);
  float vis = smoothstep(0.0, 0.3, uMolten) * (1.0 - uShatter) * uOpacity;
  gl_FragColor = vec4(col * vis, a * vis);
  #include <colorspace_fragment>
}
`;

const SHADOW_VERTEX = /* glsl */ `
uniform vec2 uMin;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vUv = (position.xz - uMin) / uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
uniform sampler2D uOcc0;
uniform sampler2D uOcc1;
uniform vec3 uFingerLight[5];
uniform vec3 uPalmLight;
uniform float uOpacity;
uniform float uMolten;
uniform float uShatter;
uniform float uTime;
uniform float uShadow;
uniform float uCaustic;
varying vec2 vUv;
void main() {
  vec4 a = texture2D(uOcc0, vUv);
  vec4 b = texture2D(uOcc1, vUv);
  vec3 caustic = a.r * uFingerLight[0] + a.g * uFingerLight[1] + a.b * uFingerLight[2]
               + a.a * uFingerLight[3] + b.r * uFingerLight[4] + b.g * uPalmLight * 0.4;
  float shimmer = 0.85 + 0.15 * sin(uTime * 2.3 + vUv.x * 40.0 + vUv.y * 23.0);
  float vis = smoothstep(0.4, 1.0, uMolten) * (1.0 - uShatter) * uOpacity;
  gl_FragColor = vec4(caustic * uCaustic * shimmer * vis, b.b * uShadow * vis);
  #include <colorspace_fragment>
}
`;

/** Rasterises the baked hand's footprint into two blurred RGBA8 textures (see SHADOW_FRAGMENT). */
function bakeFootprint(g: BufferGeometry, min: Vector2, size: Vector2): [DataTexture, DataTexture] {
  const N = SHADOW_RES;
  const ch = new Float32Array(N * N * 8); // thumb..pinky, palm, total, (unused)
  const pos = g.getAttribute('position').array;
  const fin = g.getAttribute('aFinger').array;
  const idx = g.getIndex()!.array;
  const px = (x: number): number => ((x - min.x) / size.x) * N - 0.5;
  const pz = (z: number): number => ((z - min.y) / size.y) * N - 0.5;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = px(pos[a * 3]), az = pz(pos[a * 3 + 2]);
    const bx = px(pos[b * 3]), bz = pz(pos[b * 3 + 2]);
    const cx = px(pos[c * 3]), cz = pz(pos[c * 3 + 2]);
    const y = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
    const close = Math.pow(Math.max(0, 1 - y / 0.09), 1.5);
    const group = fin[a];
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx)));
    const z0 = Math.max(0, Math.floor(Math.min(az, bz, cz))), z1 = Math.min(N - 1, Math.ceil(Math.max(az, bz, cz)));
    for (let zi = z0; zi <= z1; zi++) {
      for (let xi = x0; xi <= x1; xi++) {
        const l1 = ((bz - cz) * (xi - cx) + (cx - bx) * (zi - cz)) / det;
        const l2 = ((cz - az) * (xi - cx) + (ax - cx) * (zi - cz)) / det;
        if (l1 < -0.05 || l2 < -0.05 || l1 + l2 > 1.05) continue;
        const o = (zi * N + xi) * 8;
        ch[o + group] = Math.max(ch[o + group], close);
        ch[o + 6] = Math.max(ch[o + 6], close);
      }
    }
  }
  // Separable box blur x3 ~ gaussian.
  const tmp = new Float32Array(ch.length);
  const R = 2;
  for (let pass = 0; pass < 3; pass++) {
    for (const [src, dst, horizontal] of [[ch, tmp, true], [tmp, ch, false]] as const) {
      for (let zi = 0; zi < N; zi++) {
        for (let xi = 0; xi < N; xi++) {
          for (let k = 0; k < 7; k++) {
            let s = 0;
            for (let d = -R; d <= R; d++) {
              const xx = horizontal ? xi + d : xi, zz = horizontal ? zi : zi + d;
              if (xx < 0 || zz < 0 || xx >= N || zz >= N) continue;
              s += src[(zz * N + xx) * 8 + k];
            }
            dst[(zi * N + xi) * 8 + k] = s / (2 * R + 1);
          }
        }
      }
    }
  }
  const d0 = new Uint8Array(N * N * 4);
  const d1 = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    for (let k = 0; k < 4; k++) d0[i * 4 + k] = Math.min(255, Math.round(ch[i * 8 + k] * 255 * 1.6));
    d1[i * 4] = Math.min(255, Math.round(ch[i * 8 + 4] * 255 * 1.6));
    d1[i * 4 + 1] = Math.min(255, Math.round(ch[i * 8 + 5] * 255 * 1.6));
    d1[i * 4 + 2] = Math.min(255, Math.round(ch[i * 8 + 6] * 255 * 1.3));
    d1[i * 4 + 3] = 255;
  }
  const make = (data: Uint8Array): DataTexture => {
    const tex = new DataTexture(data, N, N, RGBAFormat, UnsignedByteType);
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  return [make(d0), make(d1)];
}

export class CastView {
  readonly root = new Group();
  readonly kind: GlassKind;
  /** Baked geometry, relative to the foot point. */
  readonly geometry: BufferGeometry;
  readonly uniforms: GlassUniforms;
  /** The grab handle (frosted disc on the bench). */
  readonly foot: Mesh;
  /** Palm centre relative to the root (foot point). */
  readonly palmCenter = new Vector3();
  private readonly glass: Mesh[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly extras: Mesh[] = [];
  private readonly textures: DataTexture[] = [];
  private readonly lightTarget = [new Color(0), new Color(0), new Color(0), new Color(0), new Color(0)];
  private readonly palmTarget = new Color(0);
  private palmOverride = false;
  private selectTarget = 0;
  private readonly template: HandTemplate;
  private readonly pose: HandPose;
  private readonly bakeOrigin: number[];

  constructor(
    templates: { left: HandTemplate; right: HandTemplate },
    pose: HandPose,
    kind: GlassKind = 'glass',
    opts: CastViewOptions = {},
  ) {
    this.kind = kind;
    const p = pose.pos;
    const cx = (p[0] + p[33]) / 2, cy = (p[1] + p[34]) / 2, cz = (p[2] + p[35]) / 2;
    this.root.name = 'glass-cast';
    this.root.position.set(cx, 0, cz);
    this.palmCenter.set(0, cy, 0);
    const template = pose.hand === 'left' ? templates.left : templates.right;
    this.template = template;
    this.pose = { hand: pose.hand, pos: Array.from(pose.pos), rot: pose.rot ? Array.from(pose.rot) : undefined };
    this.bakeOrigin = [cx, 0, cz];
    const g = bakePose(template, pose, { inflate: opts.inflate ?? 0.0015, origin: this.bakeOrigin, subdivide: opts.subdivide ?? 1 });
    this.geometry = g;
    const order = opts.renderOrder ?? 10;

    // Glass passes.
    const front = createGlassMaterial(kind, { side: FrontSide });
    this.uniforms = front.uniforms;
    if (kind === 'glass') {
      const back = createGlassMaterial(kind, { side: BackSide, uniforms: front.uniforms });
      this.addGlass(new Mesh(g, back), order + 2);
    }
    // Same render order for both passes: three then sorts casts far -> near by
    // position and, within a cast (equal depth), by id: back pass first.
    this.addGlass(new Mesh(g, front), order + 2);

    // Stem from the palm's underside to the bench, and the foot disc.
    const footRadius = 0.016;
    const frost = premultipliedBlend(new ShaderMaterial({
      name: 'glass-frost',
      uniforms: {
        uTime: this.uniforms.uTime, uSelected: this.uniforms.uSelected, uOpacity: this.uniforms.uOpacity,
        uMolten: this.uniforms.uMolten, uShatter: this.uniforms.uShatter, uPalmLight: this.uniforms.uPalmLight,
        uFootRadius: { value: footRadius },
      },
      vertexShader: FROST_VERTEX,
      fragmentShader: FROST_FRAGMENT,
    }));
    this.materials.push(frost);
    const top = this.palmUnderside(g, cy);
    if (kind !== 'ghost' && top > 0.008) {
      const h = top - 0.003;
      const stemGeo = new CylinderGeometry(0.0022, 0.0032, h, 12, 1, true);
      stemGeo.translate(0, 0.003 + h / 2, 0);
      this.addExtra(new Mesh(stemGeo, frost), order + 1);
    }
    const footGeo = new CylinderGeometry(footRadius * 0.92, footRadius, 0.003, 40, 1);
    footGeo.translate(0, 0.0015, 0);
    this.foot = this.addExtra(new Mesh(footGeo, frost), order + 1);
    this.foot.name = 'glass-cast-foot';
    this.foot.visible = kind !== 'ghost';

    // Contact shadow + caustics.
    if (kind !== 'ghost') {
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      const m = 0.035;
      const min = new Vector2(bb.min.x - m, bb.min.z - m);
      const size = new Vector2(bb.max.x - bb.min.x + 2 * m, bb.max.z - bb.min.z + 2 * m);
      const [t0, t1] = bakeFootprint(g, min, size);
      this.textures.push(t0, t1);
      const shadowMat = premultipliedBlend(new ShaderMaterial({
        name: 'glass-shadow',
        uniforms: {
          uOcc0: { value: t0 }, uOcc1: { value: t1 },
          uFingerLight: this.uniforms.uFingerLight, uPalmLight: this.uniforms.uPalmLight,
          uOpacity: this.uniforms.uOpacity, uMolten: this.uniforms.uMolten, uShatter: this.uniforms.uShatter,
          uTime: this.uniforms.uTime,
          uShadow: { value: kind === 'silver' ? 0.55 : 0.32 },
          uCaustic: { value: kind === 'silver' ? 0 : 0.4 },
          uMin: { value: min }, uSize: { value: size },
        },
        vertexShader: SHADOW_VERTEX,
        fragmentShader: SHADOW_FRAGMENT,
      }));
      this.materials.push(shadowMat);
      const plane = new PlaneGeometry(size.x, size.y);
      plane.rotateX(-Math.PI / 2);
      plane.translate(min.x + size.x / 2, 0.0006, min.y + size.y / 2);
      this.addExtra(new Mesh(plane, shadowMat), order);
    }
  }

  private addGlass(mesh: Mesh, order: number): void {
    mesh.renderOrder = order;
    this.glass.push(mesh);
    this.materials.push(mesh.material as GlassMaterial);
    this.root.add(mesh);
  }

  private addExtra(mesh: Mesh, order: number): Mesh {
    mesh.renderOrder = order;
    this.extras.push(mesh);
    this.root.add(mesh);
    return mesh;
  }

  /** Height where the stem meets the glass: lowest baked vertex near the palm centre. */
  private palmUnderside(g: BufferGeometry, fallback: number): number {
    const pos = g.getAttribute('position').array;
    let low = Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.hypot(pos[i], pos[i + 2]) < 0.012 && pos[i + 1] < low) low = pos[i + 1];
    }
    return Number.isFinite(low) ? low + 0.004 : fallback;
  }

  /** Light carried by finger f (0 thumb .. 4 pinky); null = dark. Eased in update(). */
  setFingerLight(f: number, color: Color | null): void {
    if (f < 0 || f > 4) return;
    if (color) this.lightTarget[f].copy(color); else this.lightTarget[f].setRGB(0, 0, 0);
  }

  /** Light carried in the palm; null = automatic (per-channel max of the fingers). */
  setPalmLight(color: Color | null): void {
    this.palmOverride = !!color;
    if (color) this.palmTarget.copy(color);
  }

  /** front: molten front along the hand (0 wrist .. 1 tips, >= 1 set); heat: 0..1 glow. */
  setMolten(front: number, heat: number): void {
    this.uniforms.uMolten.value = front;
    this.uniforms.uHeat.value = heat;
  }

  setSelected(on: boolean): void {
    this.selectTarget = on ? 1 : 0;
  }

  setOpacity(opacity: number): void {
    this.uniforms.uOpacity.value = opacity;
  }

  update(dt: number, time: number): void {
    const u = this.uniforms;
    u.uTime.value = time;
    const k = 1 - Math.exp(-LIGHT_EASE * dt);
    if (!this.palmOverride) {
      this.palmTarget.setRGB(0, 0, 0);
      const p = this.palmTarget;
      for (let f = 0; f < 5; f++) {
        const c = this.lightTarget[f];
        p.setRGB(Math.max(p.r, c.r), Math.max(p.g, c.g), Math.max(p.b, c.b));
      }
    }
    for (let f = 0; f < 5; f++) u.uFingerLight.value[f].lerp(this.lightTarget[f], k);
    u.uPalmLight.value.lerp(this.palmTarget, k);
    u.uSelected.value += (this.selectTarget - u.uSelected.value) * (1 - Math.exp(-SELECT_EASE * dt));
  }

  /**
   * Breaks the cast: hides it and returns a running Shatter, added to the
   * root's parent with the root's transform (so it outlives this view).
   * Keep calling shatter.update(dt) until it returns false, then dispose it.
   */
  shatter(origin?: Vector3): Shatter {
    const u = this.uniforms;
    // Shards come from the unsubdivided bake: larger facets, straighter edges, fewer vertices.
    const coarse = bakePose(this.template, this.pose, { inflate: 0.0015, origin: this.bakeOrigin });
    const s = new Shatter(coarse, {
      kind: this.kind,
      fingerLight: u.uFingerLight.value,
      palmLight: u.uPalmLight.value,
    });
    coarse.dispose();
    const parent = this.root.parent ?? this.root;
    if (parent !== this.root) {
      s.object.position.copy(this.root.position);
      s.object.quaternion.copy(this.root.quaternion);
      s.object.scale.copy(this.root.scale);
    }
    parent.add(s.object);
    s.object.renderOrder = (this.glass[this.glass.length - 1]?.renderOrder ?? 12) + 1;
    for (const m of this.glass) m.visible = false;
    for (const m of this.extras) m.visible = false;
    s.start(origin ?? this.palmCenter);
    return s;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geometry.dispose();
    for (const m of this.extras) m.geometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
