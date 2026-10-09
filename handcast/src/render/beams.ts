/**
 * Light beams as additive, view-dependent tubes. A pooled set of meshes is
 * re-targeted whenever the trace changes; new segments "grow" out from the
 * emitter at the speed of (very slow) light.
 */

import {
  AdditiveBlending,
  Color as ThreeColor,
  CylinderGeometry,
  Group,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from '@iwsdk/core';
import { BeamSegment } from '../game/trace.js';
import { lightColor } from './palette.js';

const vertex = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vAlong;
  void main() {
    vAlong = uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uLength;
  uniform float uIntensity;
  uniform float uCore;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  varying float vAlong;
  void main() {
    float facing = abs(dot(normalize(vNormalV), normalize(vViewDir)));
    float body = pow(facing, uCore);
    float flow = 0.78 + 0.22 * sin(vAlong * uLength * 90.0 - uTime * 9.0);
    vec3 col = mix(uColor, vec3(1.0), body * body * 0.55);
    gl_FragColor = vec4(col * body * flow * uIntensity, 1.0);
  }
`;

interface BeamMesh {
  core: Mesh;
  glow: Mesh;
  coreMat: ShaderMaterial;
  glowMat: ShaderMaterial;
}

const UP = new Vector3(0, 1, 0);

export class BeamRenderer {
  readonly group = new Group();
  private pool: BeamMesh[] = [];
  private active: {
    seg: BeamSegment;
    a: Vector3;
    b: Vector3;
    len: number;
    revealAt: number;
  }[] = [];
  private geo = new CylinderGeometry(1, 1, 1, 10, 1, true);
  private tmpDir = new Vector3();
  private tmpQuat = new Quaternion();
  private tmpMid = new Vector3();
  private clock = 0;
  /** Board-local metres per grid cell, beam height above board. */
  constructor(
    private cell: number,
    private size: number,
    private height: number,
  ) {
    this.group.name = 'beams';
    this.geo.translate(0, 0.5, 0);
  }

  private material(core: boolean): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        uColor: { value: new ThreeColor() },
        uTime: { value: 0 },
        uLength: { value: 1 },
        uIntensity: { value: core ? 1.25 : 0.45 },
        uCore: { value: core ? 2.0 : 1.2 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
  }

  private ensure(n: number): void {
    while (this.pool.length < n) {
      const coreMat = this.material(true);
      const glowMat = this.material(false);
      const core = new Mesh(this.geo, coreMat);
      const glow = new Mesh(this.geo, glowMat);
      core.renderOrder = 10;
      glow.renderOrder = 11;
      core.frustumCulled = glow.frustumCulled = false;
      this.group.add(core, glow);
      this.pool.push({ core, glow, coreMat, glowMat });
    }
  }

  gridToLocal(x: number, y: number, out: Vector3): Vector3 {
    const half = (this.size - 1) / 2;
    return out.set((x - half) * this.cell, this.height, -(y - half) * this.cell);
  }

  /** Replace the beam set; unchanged segments stay lit, new ones grow in. */
  setSegments(segments: BeamSegment[]): void {
    const key = (s: BeamSegment) => `${s.x0},${s.y0},${s.x1},${s.y1},${s.color}`;
    const old = new Set(this.active.filter((a) => a.revealAt <= this.clock).map((a) => key(a.seg)));
    let firstNew = Infinity;
    for (const s of segments) if (!old.has(key(s))) firstNew = Math.min(firstNew, s.d0);
    this.active = segments.map((seg) => {
      const a = this.gridToLocal(seg.x0, seg.y0, new Vector3());
      const b = this.gridToLocal(seg.x1, seg.y1, new Vector3());
      const fresh = !old.has(key(seg));
      const revealAt = fresh ? this.clock + (seg.d0 - firstNew) * 0.045 : -1;
      return { seg, a, b, len: a.distanceTo(b), revealAt };
    });
    this.ensure(this.active.length);
    for (let i = 0; i < this.pool.length; i++) {
      const visible = i < this.active.length;
      this.pool[i].core.visible = this.pool[i].glow.visible = visible;
      if (visible) {
        const c = lightColor(this.active[i].seg.color);
        this.pool[i].coreMat.uniforms.uColor.value.copy(c);
        this.pool[i].glowMat.uniforms.uColor.value.copy(c);
      }
    }
  }

  update(dt: number, time: number): void {
    this.clock += dt;
    const growSpeed = this.cell * 22; // metres per second
    for (let i = 0; i < this.active.length; i++) {
      const s = this.active[i];
      const { core, glow, coreMat, glowMat } = this.pool[i];
      const shown =
        s.revealAt < 0 ? s.len : Math.min(s.len, Math.max(0, (this.clock - s.revealAt) * growSpeed));
      if (shown <= 1e-4) {
        core.visible = glow.visible = false;
        continue;
      }
      core.visible = glow.visible = true;
      this.tmpDir.subVectors(s.b, s.a).normalize();
      this.tmpQuat.setFromUnitVectors(UP, this.tmpDir);
      this.tmpMid.copy(s.a);
      for (const m of [core, glow]) {
        m.position.copy(this.tmpMid);
        m.quaternion.copy(this.tmpQuat);
      }
      const coreR = this.cell * 0.035;
      core.scale.set(coreR, shown, coreR);
      glow.scale.set(coreR * 3.2, shown, coreR * 3.2);
      coreMat.uniforms.uTime.value = time;
      glowMat.uniforms.uTime.value = time;
      coreMat.uniforms.uLength.value = shown;
      glowMat.uniforms.uLength.value = shown;
    }
  }

  /** Brighten everything for the solve flourish. */
  setBoost(v: number): void {
    for (const p of this.pool) {
      p.coreMat.uniforms.uIntensity.value = 1.25 + v * 1.5;
      p.glowMat.uniforms.uIntensity.value = 0.45 + v * 0.9;
    }
  }

  dispose(): void {
    this.geo.dispose();
    for (const p of this.pool) {
      p.coreMat.dispose();
      p.glowMat.dispose();
    }
    this.group.removeFromParent();
  }
}
