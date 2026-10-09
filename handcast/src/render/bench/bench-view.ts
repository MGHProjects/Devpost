/**
 * The light-bench as seen in the headset: a smoked-obsidian slab engraved
 * with a star chart, sized exactly to the level's bench, carrying the level
 * props (lamps, wells, crystals, hush stones, walls, mirrors). Game state is
 * pushed in through small setters; `update` animates everything with no
 * per-frame allocation. `root` is in bench space (y = 0 is the bench top).
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color as ThreeColor,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  BufferGeometry,
} from '@iwsdk/core';
import type { ColorMask, LevelDef, TargetState } from '../../core/types.js';
import {
  BillboardCloud,
  CrystalProp,
  HUSH_COLOR,
  HushProp,
  LampProp,
  LIGHT_SHEET_Y,
  lightColor,
  PaneProp,
  TimeUniform,
  WellProp,
} from './props.js';

export type BenchPropKind = 'lamp' | 'well' | 'crystal' | 'hush' | 'wall' | 'mirror';

const RIM_COLOR = new ThreeColor(0.55, 0.62, 1.0);
const MAX_MOTES = 192;

// ------------------------------------------------------------ star chart

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Engraving mask, one feature per channel: R = ruler/grid/astrolabe lines,
 * G = constellation lines, B = stars. Seeded per level so each board has its own sky.
 */
function drawStarChart(w: number, d: number, seed: number): CanvasTexture {
  const W = 1536;
  const H = Math.round((W * d) / w);
  const ppm = W / w; // pixels per metre
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  const rand = mulberry32(seed);
  const m = (v: number) => v * ppm;
  const red = (a: number) => `rgba(255,0,0,${a})`;

  // double border and ruler ticks
  g.strokeStyle = red(0.9);
  g.lineWidth = 2.2;
  g.strokeRect(m(0.006), m(0.006), W - m(0.012), H - m(0.012));
  g.lineWidth = 1.3;
  g.strokeStyle = red(0.55);
  g.strokeRect(m(0.0085), m(0.0085), W - m(0.017), H - m(0.017));
  g.strokeStyle = red(0.8);
  g.lineWidth = 1.6;
  const tick = (x0: number, y0: number, x1: number, y1: number) => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  for (let cm = 1; cm * 0.01 < w; cm++) {
    const x = (W / 2) + m((cm - Math.round((w * 100) / 2)) * 0.01);
    if (x < m(0.01) || x > W - m(0.01)) continue;
    const len = m(cm % 5 === 0 ? 0.005 : 0.0025);
    tick(x, m(0.006), x, m(0.006) + len);
    tick(x, H - m(0.006), x, H - m(0.006) - len);
  }
  for (let cm = 1; cm * 0.01 < d; cm++) {
    const y = H / 2 + m((cm - Math.round((d * 100) / 2)) * 0.01);
    if (y < m(0.01) || y > H - m(0.01)) continue;
    const len = m(cm % 5 === 0 ? 0.005 : 0.0025);
    tick(m(0.006), y, m(0.006) + len, y);
    tick(W - m(0.006), y, W - m(0.006) - len, y);
  }

  // 2 cm grid in a band near the edges, fading inward
  const band = 0.04;
  g.save();
  g.beginPath();
  g.rect(m(0.0085), m(0.0085), W - m(0.017), H - m(0.017));
  g.rect(m(band), m(band), W - m(2 * band), H - m(2 * band));
  g.clip('evenodd');
  g.lineWidth = 1.1;
  g.strokeStyle = red(0.4);
  for (let x = W / 2 % m(0.02); x < W; x += m(0.02)) tick(x, 0, x, H);
  for (let y = H / 2 % m(0.02); y < H; y += m(0.02)) tick(0, y, W, y);
  g.restore();
  // plus-marks where the grid would continue inside
  g.strokeStyle = red(0.35);
  g.lineWidth = 1.1;
  for (let x = W / 2 % m(0.04); x < W; x += m(0.04)) {
    for (let y = H / 2 % m(0.04); y < H; y += m(0.04)) {
      if (x < m(band) || x > W - m(band) || y < m(band) || y > H - m(band)) continue;
      tick(x - m(0.0018), y, x + m(0.0018), y);
      tick(x, y - m(0.0018), x, y + m(0.0018));
    }
  }

  // astrolabe rings in the centre
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(w, d);
  g.strokeStyle = red(0.32);
  for (const [rr, lw] of [
    [0.16, 1.1],
    [0.3, 1.4],
    [0.38, 1.1],
  ] as const) {
    g.lineWidth = lw;
    g.beginPath();
    g.arc(cx, cy, m(R * rr), 0, Math.PI * 2);
    g.stroke();
  }
  g.lineWidth = 1.1;
  for (let deg = 0; deg < 360; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const r0 = m(R * 0.38);
    const r1 = r0 - m(deg % 30 === 0 ? 0.006 : 0.0025);
    tick(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  }
  g.setLineDash([m(0.003), m(0.004)]);
  g.strokeStyle = red(0.22);
  for (let deg = 0; deg < 360; deg += 30) {
    const a = (deg * Math.PI) / 180;
    tick(cx + Math.cos(a) * m(R * 0.16), cy + Math.sin(a) * m(R * 0.16), cx + Math.cos(a) * m(R * 0.3), cy + Math.sin(a) * m(R * 0.3));
  }
  g.setLineDash([]);

  // constellations
  const star = (x: number, y: number, r: number, a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 2.2);
    grad.addColorStop(0, `rgba(0,0,255,${a})`);
    grad.addColorStop(0.4, `rgba(0,0,255,${a * 0.6})`);
    grad.addColorStop(1, 'rgba(0,0,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r * 2.2, 0, Math.PI * 2);
    g.fill();
  };
  const clusters = 6 + Math.floor(rand() * 3);
  for (let c = 0; c < clusters; c++) {
    const ccx = m(0.05 + rand() * (w - 0.1));
    const ccy = m(0.05 + rand() * (d - 0.1));
    const n = 4 + Math.floor(rand() * 4);
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const a = rand() * Math.PI * 2;
      const r = m(0.008 + rand() * 0.035);
      pts.push([ccx + Math.cos(a) * r, ccy + Math.sin(a) * r * 0.8]);
    }
    // nearest-neighbour chain
    const chain = [pts.shift()!];
    while (pts.length) {
      const last = chain[chain.length - 1];
      let best = 0;
      let bd = Infinity;
      pts.forEach((p, i) => {
        const dd = (p[0] - last[0]) ** 2 + (p[1] - last[1]) ** 2;
        if (dd < bd) {
          bd = dd;
          best = i;
        }
      });
      chain.push(pts.splice(best, 1)[0]);
    }
    g.strokeStyle = 'rgba(0,255,0,0.75)';
    g.lineWidth = 1.5;
    g.beginPath();
    chain.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    if (rand() < 0.35) g.lineTo(chain[1][0], chain[1][1]);
    g.stroke();
    for (const p of chain) star(p[0], p[1], 1.6 + rand() * 2.4, 0.95);
  }
  for (let k = 0; k < 260; k++) star(rand() * W, rand() * H, 0.6 + rand() * 1.1, 0.25 + rand() * 0.55);

  const tex = new CanvasTexture(canvas);
  tex.anisotropy = 8;
  return tex;
}

// ----------------------------------------------------------------- slab

const slabVertex = /* glsl */ `
  varying vec2 vP;
  varying vec3 vWorld;
  varying vec3 vWorldN;
  void main() {
    vP = position.xz;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vWorldN = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const slabFragment = /* glsl */ `
  uniform sampler2D uChart;
  uniform vec2 uHalf;
  uniform float uTime;
  uniform float uWave;
  uniform float uRim;
  uniform vec3 uRimColor;
  varying vec2 vP;
  varying vec3 vWorld;
  varying vec3 vWorldN;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 q = abs(vP) - uHalf;
    float outside = max(q.x, q.y);
    float wave = 0.0;
    if (uWave > 0.0) {
      float wr = uWave * 0.3;
      wave = exp(-pow((length(vP) - wr) * 20.0, 2.0)) * (1.0 - smoothstep(0.8, 1.8, uWave));
    }
    if (outside > 0.0) {
      // soft rim light spilling onto the real table
      float halo = (exp(-outside / 0.006) * 0.35 + exp(-outside / 0.02) * 0.12) * uRim;
      halo *= 1.0 - smoothstep(0.03, 0.045, outside);
      gl_FragColor = vec4(uRimColor, clamp(halo + wave * 0.2, 0.0, 1.0));
      return;
    }
    vec2 uv = vec2(vP.x / (2.0 * uHalf.x) + 0.5, 0.5 - vP.y / (2.0 * uHalf.y));
    vec4 ch = texture2D(uChart, uv);
    float edge = -outside;
    float r = length(vP / uHalf);
    vec3 base = vec3(0.016, 0.018, 0.032) + vec3(0.018, 0.02, 0.04) * (1.0 - smoothstep(0.0, 1.25, r));
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 n = normalize(vWorldN);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 4.0);
    vec3 rr = reflect(-v, n);
    vec3 sheen = mix(vec3(0.03, 0.035, 0.06), vec3(0.3, 0.34, 0.48), smoothstep(0.1, 0.95, rr.y)) * (0.18 + 0.82 * fres);
    float tw = 0.55 + 0.45 * sin(uTime * 1.3 + hash(floor(uv * vec2(260.0, 180.0))) * 6.283);
    vec3 lines = vec3(0.95, 0.76, 0.48) * ch.r * 0.26 + vec3(0.5, 0.72, 1.0) * ch.g * 0.3 + vec3(0.85, 0.9, 1.0) * ch.b * 0.75 * tw;
    lines *= 1.0 + wave * 5.0;
    float rim = exp(-edge / 0.0018) * 0.9 + exp(-edge / 0.01) * 0.18;
    vec3 col = base + sheen + lines + uRimColor * (rim * uRim + wave * 0.5);
    float alpha = clamp(0.62 + rim * 0.3 + dot(lines, vec3(0.3)) + fres * 0.2, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
  }
`;

// ------------------------------------------------------------- the view

interface CrystalState {
  prop: CrystalProp;
  needed: ColorMask;
  state: TargetState;
  received: ColorMask;
  glow: number;
  color: ThreeColor;
  highlight: boolean;
  ringFade: number;
  spawn: number;
}

export class BenchView {
  readonly root = new Group();
  private time: TimeUniform = { value: 0 };
  private lamps: LampProp[] = [];
  private wells: WellProp[] = [];
  private crystals: CrystalState[] = [];
  private hush: HushProp[] = [];
  private walls: PaneProp[] = [];
  private mirrors: PaneProp[] = [];
  private slabMat: ShaderMaterial;
  private chart: Texture;
  private halos: BillboardCloud;
  private motes: BillboardCloud;
  private lampOn: number[] = [];
  private solveT = -1;
  private boost = 0;
  // mote particles (struct of arrays)
  private mPos = new Float32Array(MAX_MOTES * 3);
  private mVel = new Float32Array(MAX_MOTES * 3);
  private mLife = new Float32Array(MAX_MOTES);
  private mMax = new Float32Array(MAX_MOTES);
  private mCol = new Float32Array(MAX_MOTES * 3);
  private mNext = 0;

  constructor(private level: LevelDef) {
    this.root.name = 'bench';
    const { w, d } = level.bench;

    // slab: dark glass sides (top/bottom faces hidden) plus the engraved top
    const hidden = new MeshBasicMaterial({ visible: false });
    const side = new MeshBasicMaterial({ color: 0x07080e, transparent: true, opacity: 0.88, depthWrite: false });
    const body = new Mesh(new BoxGeometry(w, 0.006, d), [side, side, hidden, hidden, side, side]);
    body.position.y = -0.0035;
    body.renderOrder = -11;
    this.chart = drawStarChart(w, d, hashString(level.id || 'bench'));
    const margin = 0.045;
    this.slabMat = new ShaderMaterial({
      vertexShader: slabVertex,
      fragmentShader: slabFragment,
      uniforms: {
        uChart: { value: this.chart },
        uHalf: { value: new Vector2(w / 2, d / 2) },
        uTime: this.time,
        uWave: { value: 0 },
        uRim: { value: 1 },
        uRimColor: { value: RIM_COLOR.clone() },
      },
      transparent: true,
      depthWrite: false,
    });
    const top = new Mesh(new PlaneGeometry(w + margin * 2, d + margin * 2).rotateX(-Math.PI / 2), this.slabMat);
    top.renderOrder = -10;
    top.raycast = () => {};
    this.root.add(body, top);

    const props = new Group();
    props.name = 'props';
    this.root.add(props);
    level.lamps.forEach((l) => {
      const lamp = new LampProp(l.p, l.a, l.color, this.time, LIGHT_SHEET_Y);
      this.lamps.push(lamp);
      this.lampOn.push(1);
      props.add(lamp.group);
    });
    level.wells.forEach((wl, i) => {
      const well = new WellProp(wl.p, wl.r, wl.color, this.time, i);
      this.wells.push(well);
      props.add(well.group);
    });
    level.crystals.forEach((c, i) => {
      const prop = new CrystalProp(c.p, c.color, i);
      props.add(prop.group);
      this.crystals.push({
        prop,
        needed: c.color,
        state: 'off',
        received: 0,
        glow: 0.07,
        color: lightColor(c.color).clone(),
        highlight: false,
        ringFade: 0,
        spawn: 0,
      });
    });
    level.hush.forEach((h, i) => {
      const prop = new HushProp(h.p, this.time, i);
      this.hush.push(prop);
      props.add(prop.group);
    });
    level.walls.forEach((s) => {
      const p = new PaneProp(s.a, s.b, 'wall');
      this.walls.push(p);
      props.add(p.group);
    });
    level.mirrors.forEach((s) => {
      const p = new PaneProp(s.a, s.b, 'mirror');
      this.mirrors.push(p);
      props.add(p.group);
    });

    const haloCount = this.lamps.length + this.wells.length + this.crystals.length + this.hush.length;
    this.halos = new BillboardCloud(Math.max(1, haloCount), 12, 12);
    this.motes = new BillboardCloud(MAX_MOTES, 40, 13);
    this.root.add(this.halos.mesh, this.motes.mesh);
  }

  setCrystal(i: number, state: TargetState, received: ColorMask): void {
    const c = this.crystals[i];
    if (!c) return;
    c.state = state;
    c.received = received;
  }

  setHush(i: number, awake: boolean): void {
    const h = this.hush[i];
    if (h) h.awake = awake;
  }

  setLampActive(i: number, on: boolean): void {
    this.lamps[i]?.setActive(on);
  }

  highlightCrystal(i: number, on: boolean): void {
    const c = this.crystals[i];
    if (c) c.highlight = on;
  }

  /** Solve flourish: a ring wave through the engraving, crystals flare and shed motes. */
  pulseSolved(): void {
    this.solveT = 0;
    for (const c of this.crystals) {
      for (let k = 0; k < 16; k++) this.spawnMote(c, true);
    }
  }

  /** Bench-space position of a prop (lamp lens, crystal middle, ...), for sound and gaze. */
  worldOf(kind: BenchPropKind, i: number, out = new Vector3()): Vector3 {
    const L = this.level;
    switch (kind) {
      case 'lamp': {
        const lamp = this.lamps[i];
        return lamp ? out.set(lamp.lensPos.x, LIGHT_SHEET_Y, lamp.lensPos.y) : out.set(0, 0, 0);
      }
      case 'well': {
        const wl = L.wells[i];
        return wl ? out.set(wl.p[0], 0.004, wl.p[1]) : out.set(0, 0, 0);
      }
      case 'crystal': {
        const c = this.crystals[i];
        return c ? out.set(L.crystals[i].p[0], c.prop.height * 0.55, L.crystals[i].p[1]) : out.set(0, 0, 0);
      }
      case 'hush': {
        const h = L.hush[i];
        return h ? out.set(h.p[0], 0.008, h.p[1]) : out.set(0, 0, 0);
      }
      case 'wall':
      case 'mirror': {
        const p = (kind === 'wall' ? this.walls : this.mirrors)[i];
        return p ? out.set(p.mid[0], 0.02, p.mid[1]) : out.set(0, 0, 0);
      }
    }
  }

  private spawnMote(c: CrystalState, burst: boolean): void {
    const k = this.mNext;
    this.mNext = (this.mNext + 1) % MAX_MOTES;
    const p = c.prop.group.position;
    const a = Math.random() * Math.PI * 2;
    const r = c.prop.radius * (0.5 + Math.random() * 1.2);
    this.mPos[k * 3] = p.x + Math.cos(a) * r;
    this.mPos[k * 3 + 1] = c.prop.height * (burst ? 0.5 + Math.random() * 0.5 : 0.25 + Math.random() * 0.7);
    this.mPos[k * 3 + 2] = p.z + Math.sin(a) * r;
    const sp = burst ? 0.05 + Math.random() * 0.06 : 0.008;
    this.mVel[k * 3] = Math.cos(a) * sp * (burst ? 0.6 : 0.3);
    this.mVel[k * 3 + 1] = burst ? 0.05 + Math.random() * 0.08 : 0.018 + Math.random() * 0.02;
    this.mVel[k * 3 + 2] = Math.sin(a) * sp * (burst ? 0.6 : 0.3);
    this.mMax[k] = this.mLife[k] = burst ? 1.4 + Math.random() : 1.6 + Math.random() * 1.2;
    const col = c.color;
    const wmix = Math.random() * 0.45;
    this.mCol[k * 3] = col.r + (1 - col.r) * wmix;
    this.mCol[k * 3 + 1] = col.g + (1 - col.g) * wmix;
    this.mCol[k * 3 + 2] = col.b + (1 - col.b) * wmix;
  }

  update(dt: number, time: number): void {
    this.time.value = time;
    const t = time;

    // solve flourish
    if (this.solveT >= 0) {
      this.solveT += dt;
      this.boost = 1.3 * Math.exp(-this.solveT * 1.6);
      this.slabMat.uniforms.uWave.value = this.solveT;
      if (this.solveT > 3) {
        this.solveT = -1;
        this.boost = 0;
        this.slabMat.uniforms.uWave.value = 0;
      }
    }
    this.slabMat.uniforms.uRim.value = 0.85 + 0.15 * Math.sin(t * 0.7) + this.boost * 1.8;

    let h = 0;
    const halos = this.halos;
    for (let i = 0; i < this.lamps.length; i++) {
      const lamp = this.lamps[i];
      const on = lamp.update(dt);
      const c = lightColor(this.level.lamps[i].color);
      const a = this.level.lamps[i].a;
      halos.set(
        h++,
        lamp.lensPos.x + Math.cos(a) * 0.002,
        LIGHT_SHEET_Y,
        lamp.lensPos.y + Math.sin(a) * 0.002,
        0.05,
        c.r,
        c.g,
        c.b,
        on * (0.55 + 0.05 * Math.sin(t * 5.1 + i)),
      );
    }
    for (let i = 0; i < this.wells.length; i++) {
      const wl = this.level.wells[i];
      const c = lightColor(wl.color);
      halos.set(h++, wl.p[0], 0.006, wl.p[1], wl.r * 3.4, c.r, c.g, c.b, 0.2 + 0.05 * Math.sin(t * 1.3 + i * 2));
    }

    // crystals
    for (let i = 0; i < this.crystals.length; i++) {
      const c = this.crystals[i];
      const prop = c.prop;
      let target: number;
      let rate = 5;
      let colorMask = c.needed;
      switch (c.state) {
        case 'lit':
          target = 1 + 0.1 * Math.sin(t * 1.7 + i * 1.3);
          break;
        case 'partial':
          target = 0.22 + 0.14 * Math.sin(t * 3.2 + i);
          colorMask = c.received || c.needed;
          break;
        case 'wrong': {
          const q = Math.floor(t * 22 + i * 7.3);
          const j = Math.sin(q * 12.9898) * 43758.5453;
          target = 0.12 + 0.6 * (j - Math.floor(j));
          rate = 30;
          colorMask = c.received || c.needed;
          break;
        }
        default:
          target = 0.07;
      }
      c.glow += (target - c.glow) * Math.min(1, dt * rate);
      c.color.lerp(lightColor(colorMask), Math.min(1, dt * 6));
      const shown = c.glow + this.boost * (c.state === 'lit' ? 1 : 0.3);
      prop.mat.uniforms.uGlow.value = shown;
      (prop.mat.uniforms.uGlowColor.value as ThreeColor).copy(c.color);
      const lit = c.state === 'lit';
      const bobTarget = lit ? 0.0018 + 0.0016 * Math.sin(t * 1.6 + i * 0.9) : 0;
      prop.cluster.position.y += (bobTarget - prop.cluster.position.y) * Math.min(1, dt * 4);
      for (let g = 0; g < prop.glyphs.length; g++) {
        const gl = prop.glyphs[g];
        const got = (c.received & gl.comp) !== 0;
        const want = got ? 1 : 0.42;
        gl.mat.opacity += (want - gl.mat.opacity) * Math.min(1, dt * 6);
      }
      c.ringFade += ((c.highlight ? 1 : 0) - c.ringFade) * Math.min(1, dt * 8);
      prop.ring.visible = c.ringFade > 0.01;
      prop.ringMat.opacity = c.ringFade * (0.45 + 0.3 * Math.sin(t * 5));
      if (lit) {
        c.spawn += dt * 7;
        while (c.spawn >= 1) {
          c.spawn -= 1;
          this.spawnMote(c, false);
        }
      } else c.spawn = 0;
      const p = prop.group.position;
      halos.set(
        h++,
        p.x,
        0.0025 + prop.height * 0.6 + prop.cluster.position.y,
        p.z,
        0.045 + 0.06 * Math.min(shown, 1.6),
        c.color.r,
        c.color.g,
        c.color.b,
        0.08 + shown * 0.42,
      );
    }

    // hush stones
    for (let i = 0; i < this.hush.length; i++) {
      const s = this.hush[i];
      const target = s.awake ? 1 : 0;
      s.open += (target - s.open) * Math.min(1, dt * (s.awake ? 7 : 2.5));
      s.mat.uniforms.uOpen.value = s.open;
      const tremble = s.open * s.open;
      s.body.position.x = Math.sin(t * 61 + i) * 0.00055 * tremble;
      s.body.position.z = Math.sin(t * 53 + i * 2) * 0.0003 * tremble;
      s.body.rotation.z = Math.sin(t * 47) * 0.04 * tremble;
      const p = s.group.position;
      halos.set(
        h++,
        p.x,
        0.012,
        p.z + 0.004,
        0.02 + 0.08 * s.open,
        HUSH_COLOR.r,
        HUSH_COLOR.g,
        HUSH_COLOR.b,
        s.open * (0.75 + 0.25 * Math.sin(t * 9)),
      );
    }
    halos.commit(h);

    // rising motes
    const motes = this.motes;
    let n = 0;
    for (let k = 0; k < MAX_MOTES; k++) {
      if (this.mLife[k] <= 0) continue;
      this.mLife[k] -= dt;
      if (this.mLife[k] <= 0) continue;
      const k3 = k * 3;
      this.mVel[k3] *= 1 - dt * 1.2;
      this.mVel[k3 + 2] *= 1 - dt * 1.2;
      this.mPos[k3] += (this.mVel[k3] + Math.sin(t * 2 + k) * 0.004) * dt;
      this.mPos[k3 + 1] += this.mVel[k3 + 1] * dt;
      this.mPos[k3 + 2] += this.mVel[k3 + 2] * dt;
      const life = this.mLife[k] / this.mMax[k];
      const fade = Math.min(1, (1 - life) * 6) * life;
      const twinkle = 0.7 + 0.3 * Math.sin(t * 13 + k * 2.1);
      motes.set(
        n++,
        this.mPos[k3],
        this.mPos[k3 + 1],
        this.mPos[k3 + 2],
        0.004 + 0.002 * life,
        this.mCol[k3],
        this.mCol[k3 + 1],
        this.mCol[k3 + 2],
        fade * twinkle * 1.1,
      );
    }
    motes.commit(n);
  }

  dispose(): void {
    const geos = new Set<BufferGeometry>();
    const mats = new Set<Material>();
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      geos.add(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mat);
    });
    this.halos.dispose();
    this.motes.dispose();
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    this.chart.dispose();
    this.root.removeFromParent();
  }
}
