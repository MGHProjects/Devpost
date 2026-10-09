/**
 * "Night studio" ambience over passthrough: a camera-centred, inside-out
 * dimming sphere that darkens the room (~35%) everywhere except a soft clear
 * spotlight around the bench, plus slow dust motes drifting through the light
 * sheet. The sphere is drawn first among transparents and never writes
 * depth, so it can only ever sit behind the bench content.
 *
 * Add `group` to the scene root (world space) and call `setBenchCenter`
 * with the bench-top centre in world coordinates whenever the bench moves.
 */

import { BackSide, Group, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from '@iwsdk/core';
import { BillboardCloud, LIGHT_SHEET_Y } from './props.js';

const domeVertex = /* glsl */ `
  uniform float uRadius;
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec3 wp = cameraPosition + position * uRadius;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const domeFragment = /* glsl */ `
  uniform vec3 uCenter;
  uniform float uDim;
  uniform float uR0;
  uniform float uR1;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec3 d = normalize(vDir);
    vec3 toC = uCenter - cameraPosition;
    float along = dot(d, toC);
    // distance from the bench centre to this view ray
    float perp = along > 0.0 ? length(toC - d * along) : 1e3;
    // flatten the clear zone vertically a little (bench is wide, low)
    float clear = 1.0 - smoothstep(uR0, uR1, perp);
    float a = uDim * (1.0 - clear);
    // a touch darker toward the floor and ceiling, for depth
    a *= 0.9 + 0.2 * abs(d.y);
    a += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
    vec3 night = mix(vec3(0.018, 0.02, 0.05), vec3(0.04, 0.03, 0.07), clamp(d.y * 0.5 + 0.5, 0.0, 1.0));
    gl_FragColor = vec4(night, clamp(a, 0.0, 1.0));
  }
`;

const MOTES = 110;

export class Ambience {
  readonly group = new Group();
  private dome: Mesh;
  private mat: ShaderMaterial;
  private dust: BillboardCloud;
  private center = new Vector3();
  private dim = 0.35;
  private dimTarget = 0.35;
  private seeds = new Float32Array(MOTES * 6);
  /** Half extents (m) of the dust volume around the bench centre. */
  private spread = { x: 0.3, z: 0.22, y: 0.16 };

  constructor() {
    this.group.name = 'ambience';
    this.mat = new ShaderMaterial({
      vertexShader: domeVertex,
      fragmentShader: domeFragment,
      uniforms: {
        uRadius: { value: 6 },
        uCenter: { value: this.center },
        uDim: { value: this.dim },
        uR0: { value: 0.3 },
        uR1: { value: 0.75 },
      },
      side: BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.dome = new Mesh(new SphereGeometry(1, 48, 24), this.mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.raycast = () => {};
    this.dust = new BillboardCloud(MOTES, 60, 14);
    let s = 0x9e3779b9;
    const rand = () => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < MOTES * 6; i++) this.seeds[i] = rand();
    this.group.add(this.dome, this.dust.mesh);
  }

  /** Dimming of the room outside the bench spotlight (0 = none, 1 = black). Default 0.35. */
  setDim(v: number): void {
    this.dimTarget = Math.min(1, Math.max(0, v));
  }

  /** Bench-top centre in world space. */
  setBenchCenter(worldPos: Vector3): void {
    this.center.copy(worldPos);
  }

  update(dt: number, time: number): void {
    this.dim += (this.dimTarget - this.dim) * Math.min(1, dt * 2);
    this.mat.uniforms.uDim.value = this.dim;
    const c = this.center;
    const { x: sx, y: sy, z: sz } = this.spread;
    for (let i = 0; i < MOTES; i++) {
      const k = i * 6;
      const r0 = this.seeds[k];
      const r1 = this.seeds[k + 1];
      const r2 = this.seeds[k + 2];
      const r3 = this.seeds[k + 3];
      const r4 = this.seeds[k + 4];
      const r5 = this.seeds[k + 5];
      // slow Lissajous drift inside the volume, gently sinking and wrapping
      const x = (r0 * 2 - 1) * sx + Math.sin(time * (0.05 + r3 * 0.07) + r4 * 6.28) * 0.03;
      const z = (r1 * 2 - 1) * sz + Math.cos(time * (0.04 + r5 * 0.06) + r3 * 6.28) * 0.03;
      let y = (r2 - time * (0.004 + r4 * 0.006)) % 1;
      if (y < 0) y += 1;
      const yy = 0.003 + y * sy;
      // motes glint when they cross the light sheet
      const sheet = Math.exp(-((yy - LIGHT_SHEET_Y) * (yy - LIGHT_SHEET_Y)) / (0.03 * 0.03));
      const tw = 0.55 + 0.45 * Math.sin(time * (0.8 + r5 * 2.2) + r0 * 40);
      const edge = Math.min(1, y * 8, (1 - y) * 8);
      const bright = (0.16 + 0.5 * sheet) * tw * edge * Math.min(1, this.dim * 3 + 0.2);
      this.dust.set(i, c.x + x, c.y + yy, c.z + z, 0.0022 + r3 * 0.0022, 1, 0.9, 0.78, bright);
    }
    this.dust.commit(MOTES);
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.mat.dispose();
    this.dust.dispose();
    this.group.removeFromParent();
  }
}
