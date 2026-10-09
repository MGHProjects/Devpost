/**
 * Procedural visuals for every piece. All geometry is generated in code from
 * the board's cell size, so the same pieces scale from 5x5 to 7x7 boards.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { TargetState } from '../game/trace.js';
import { Color, ColorMask, Piece } from '../game/types.js';
import { getGlowTexture, lightColor } from './palette.js';

const BASE_COLOR = {
  free: 0xf1ede4,
  rotate: 0xd4b56a,
  fixed: 0x3a4152,
};

const invisible = new MeshBasicMaterial({
  transparent: true,
  opacity: 0,
  depthWrite: false,
  colorWrite: false,
});

const damp = (current: number, target: number, rate: number, dt: number) =>
  target + (current - target) * Math.exp(-rate * dt);

function standard(
  color: number,
  opts: Partial<{
    roughness: number;
    metalness: number;
    opacity: number;
    emissive: number;
    emissiveIntensity: number;
  }> = {},
): MeshStandardMaterial {
  const transparent = opts.opacity !== undefined && opts.opacity < 1;
  return new MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.5,
    metalness: opts.metalness ?? 0,
    transparent,
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    depthWrite: !transparent,
  });
}

function glowSprite(mask: ColorMask, size: number): Sprite {
  const s = new Sprite(
    new SpriteMaterial({
      map: getGlowTexture(),
      color: lightColor(mask),
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    }),
  );
  s.scale.setScalar(size);
  s.raycast = () => {}; // decorative; never a pointer target
  return s;
}

/** Small colour-blind-safe glyph per primary: triangle R, disc G, square B. */
function pip(bit: number, s: number): Mesh {
  const r = 0.07 * s;
  const geo =
    bit === Color.R
      ? new CylinderGeometry(r * 1.25, r * 1.25, 0.03 * s, 3)
      : bit === Color.G
        ? new CylinderGeometry(r, r, 0.03 * s, 18)
        : new BoxGeometry(r * 1.6, 0.03 * s, r * 1.6);
  return new Mesh(
    geo,
    new MeshStandardMaterial({
      color: 0x111111,
      emissive: lightColor(bit),
      emissiveIntensity: 0.25,
      roughness: 0.4,
    }),
  );
}

export class PieceView {
  readonly root = new Group();
  /** Rotates with the piece's orientation. */
  readonly body = new Group();
  readonly hit: Mesh;
  readonly s: number;

  /** Board-local resting position the root eases toward. */
  readonly home = new Vector3();
  /** When true the root follows `home` instantly (held by a hand). */
  snap = false;
  lift = 0;
  highlight = 0;
  private liftTarget = 0;
  private highlightTarget = 0;
  private yaw = 0;
  private yawTarget = 0;

  private ring: Mesh;
  private ringMat: MeshStandardMaterial;
  private crystal?: Mesh;
  private crystalMat?: MeshStandardMaterial;
  private crystalGlow?: Sprite;
  private pillar?: Mesh;
  private pips: { mesh: Mesh; bit: number }[] = [];
  private lens?: Sprite;
  private targetState: TargetState = 'off';
  private received: ColorMask = 0;
  private pulse = 0;
  private prismMat?: MeshStandardMaterial;
  private materials: Material[] = [];

  constructor(
    readonly piece: Piece,
    cell: number,
  ) {
    const s = (this.s = cell);
    this.root.add(this.body);
    this.root.name = `piece-${piece.id}-${piece.kind}`;

    const baseMat = standard(BASE_COLOR[piece.lock], {
      roughness: 0.55,
      metalness: piece.lock === 'rotate' ? 0.6 : 0.05,
    });
    this.materials.push(baseMat);
    if (piece.kind !== 'wall') {
      const base = new Mesh(
        new CylinderGeometry(0.36 * s, 0.4 * s, 0.07 * s, 28),
        baseMat,
      );
      base.position.y = 0.035 * s;
      this.root.add(base);
    }

    this.ringMat = standard(0x000000, {
      emissive: 0xbcd3ff,
      emissiveIntensity: 0,
    });
    this.ring = new Mesh(new TorusGeometry(0.42 * s, 0.022 * s, 8, 40), this.ringMat);
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.075 * s;
    this.root.add(this.ring);

    this.hit = new Mesh(new CylinderGeometry(0.46 * s, 0.46 * s, 0.75 * s, 12), invisible);
    this.hit.position.y = 0.37 * s;
    this.hit.name = `${this.root.name}-hit`;
    this.root.add(this.hit);

    switch (piece.kind) {
      case 'emitter':
        this.buildEmitter();
        break;
      case 'target':
        this.buildTarget();
        break;
      case 'wall':
        this.buildWall();
        break;
      case 'mirror':
      case 'splitter':
        this.buildMirror(piece.kind === 'splitter');
        break;
      case 'prism':
        this.buildPrism();
        break;
      case 'filter':
        this.buildFilter();
        break;
    }
    this.syncRotation(true);
  }

  private add(mesh: Mesh | LineSegments | Sprite, parent: Group = this.body) {
    parent.add(mesh);
    const m = (mesh as Mesh).material;
    if (m && !Array.isArray(m)) this.materials.push(m);
    return mesh;
  }

  private buildEmitter(): void {
    const s = this.s;
    const color = lightColor(this.piece.color);
    const housing = standard(0x232836, { roughness: 0.3, metalness: 0.7 });
    const body = new Mesh(new CylinderGeometry(0.2 * s, 0.24 * s, 0.32 * s, 24), housing);
    body.position.y = 0.23 * s;
    this.add(body);
    const barrel = new Mesh(new CylinderGeometry(0.1 * s, 0.13 * s, 0.34 * s, 18), housing);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.set(0.2 * s, 0.24 * s, 0);
    this.add(barrel);
    const lensMat = new MeshBasicMaterial({ color });
    const lens = new Mesh(new CylinderGeometry(0.085 * s, 0.085 * s, 0.02 * s, 18), lensMat);
    lens.rotation.z = -Math.PI / 2;
    lens.position.set(0.375 * s, 0.24 * s, 0);
    this.add(lens);
    const orb = new Mesh(new OctahedronGeometry(0.09 * s, 2), lensMat);
    orb.position.y = 0.44 * s;
    this.add(orb);
    this.lens = glowSprite(this.piece.color, 0.6 * s);
    this.lens.position.set(0.39 * s, 0.24 * s, 0);
    this.add(this.lens);
  }

  private buildTarget(): void {
    const s = this.s;
    const need = this.piece.color;
    this.crystalMat = new MeshStandardMaterial({
      color: lightColor(need),
      emissive: lightColor(need),
      emissiveIntensity: 0.06,
      roughness: 0.15,
      metalness: 0.1,
      flatShading: true,
      transparent: true,
      opacity: 0.88,
    });
    this.materials.push(this.crystalMat);
    this.crystal = new Mesh(new OctahedronGeometry(0.2 * s, 0), this.crystalMat);
    this.crystal.scale.set(1, 1.45, 1);
    this.crystal.position.y = 0.42 * s;
    this.root.add(this.crystal);

    const cradle = standard(0x2b3040, { roughness: 0.35, metalness: 0.8 });
    this.materials.push(cradle);
    const stem = new Mesh(new CylinderGeometry(0.03 * s, 0.06 * s, 0.14 * s, 10), cradle);
    stem.position.y = 0.12 * s;
    this.root.add(stem);

    const bits = [Color.R, Color.G, Color.B].filter((b) => need & b);
    bits.forEach((bit, i) => {
      const p = pip(bit, s);
      const a = (i / bits.length) * Math.PI * 2 + Math.PI / 2;
      p.position.set(Math.cos(a) * 0.26 * s, 0.085 * s, Math.sin(a) * 0.26 * s);
      this.root.add(p);
      this.materials.push(p.material as Material);
      this.pips.push({ mesh: p, bit });
    });

    this.crystalGlow = glowSprite(need, 1.2 * s);
    this.crystalGlow.position.y = 0.42 * s;
    (this.crystalGlow.material as SpriteMaterial).opacity = 0;
    this.root.add(this.crystalGlow);
    this.materials.push(this.crystalGlow.material as Material);

    const pillarMat = new MeshBasicMaterial({
      color: lightColor(need),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.materials.push(pillarMat);
    this.pillar = new Mesh(new CylinderGeometry(0.05 * s, 0.12 * s, 3 * s, 16, 1, true), pillarMat);
    this.pillar.position.y = 0.42 * s + 1.5 * s;
    this.pillar.raycast = () => {};
    this.root.add(this.pillar);
  }

  private buildWall(): void {
    const s = this.s;
    const stone = standard(0x262a33, { roughness: 0.92 });
    const block = new Mesh(new BoxGeometry(0.82 * s, 0.42 * s, 0.82 * s), stone);
    block.position.y = 0.21 * s;
    this.add(block, this.root as Group);
    const cap = new Mesh(new BoxGeometry(0.7 * s, 0.04 * s, 0.7 * s), standard(0x323743, { roughness: 0.8 }));
    cap.position.y = 0.44 * s;
    this.add(cap, this.root as Group);
  }

  private buildMirror(half: boolean): void {
    const s = this.s;
    const face = half
      ? standard(0xa8d8ff, {
          roughness: 0.05,
          metalness: 0.3,
          opacity: 0.45,
          emissive: 0x2b5c88,
          emissiveIntensity: 0.4,
        })
      : standard(0xe6eeff, { roughness: 0.06, metalness: 1 });
    const panel = new Mesh(new BoxGeometry(0.78 * s, 0.4 * s, 0.05 * s), face);
    panel.position.y = 0.3 * s;
    this.add(panel);
    const frameMat = standard(0x1d2230, { roughness: 0.4, metalness: 0.8 });
    const top = new Mesh(new BoxGeometry(0.8 * s, 0.03 * s, 0.07 * s), frameMat);
    top.position.y = 0.51 * s;
    this.add(top);
    const edge = new Mesh(
      new BoxGeometry(0.8 * s, 0.012 * s, 0.075 * s),
      new MeshBasicMaterial({ color: half ? 0x8fd0ff : 0xffffff }),
    );
    edge.position.y = 0.53 * s;
    this.add(edge);
    const foot = new Mesh(new BoxGeometry(0.5 * s, 0.05 * s, 0.14 * s), frameMat);
    foot.position.y = 0.09 * s;
    this.add(foot);
  }

  private buildPrism(): void {
    const s = this.s;
    this.prismMat = standard(0xd9f0ff, {
      roughness: 0.04,
      metalness: 0.1,
      opacity: 0.55,
      emissive: 0x8899ff,
      emissiveIntensity: 0.25,
    });
    const geo = new CylinderGeometry(0.32 * s, 0.32 * s, 0.46 * s, 3);
    const prism = new Mesh(geo, this.prismMat);
    prism.position.y = 0.31 * s;
    this.add(prism);
    const edges = new LineSegments(
      new EdgesGeometry(geo),
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
    );
    edges.position.copy(prism.position);
    this.add(edges);
  }

  private buildFilter(): void {
    const s = this.s;
    const color = lightColor(this.piece.color);
    const frame = new Mesh(
      new TorusGeometry(0.24 * s, 0.035 * s, 10, 32),
      standard(0x1d2230, { roughness: 0.35, metalness: 0.8 }),
    );
    frame.position.y = 0.33 * s;
    frame.rotation.y = Math.PI / 2;
    this.add(frame);
    const glass = new Mesh(
      new CylinderGeometry(0.235 * s, 0.235 * s, 0.02 * s, 28),
      new MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.5,
        transparent: true,
        opacity: 0.55,
        roughness: 0.1,
        depthWrite: false,
      }),
    );
    glass.rotation.z = Math.PI / 2;
    glass.position.y = 0.33 * s;
    this.add(glass);
    const bits = [Color.R, Color.G, Color.B].filter((b) => this.piece.color & b);
    bits.forEach((bit, i) => {
      const p = pip(bit, s);
      (p.material as MeshStandardMaterial).emissiveIntensity = 1;
      p.position.set(0, 0.085 * s, (i - (bits.length - 1) / 2) * 0.16 * s);
      this.root.add(p);
    });
    // Filters are orientation-free, but face the beam axis for readability.
    this.body.rotation.y = 0;
  }

  /** Orientation in radians for the piece's current `rot`. */
  private rotationAngle(): number {
    const { kind, rot } = this.piece;
    if (kind === 'mirror' || kind === 'splitter') return (rot * Math.PI) / 8;
    if (kind === 'emitter') return (rot * Math.PI) / 4;
    return 0;
  }

  syncRotation(immediate = false): void {
    const target = this.rotationAngle();
    // Unwrap so the piece always turns the short way round.
    let delta = target - this.yawTarget;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.yawTarget += delta;
    if (immediate) this.yaw = this.yawTarget;
  }

  setLift(v: number): void {
    this.liftTarget = v;
  }

  setHighlight(v: number): void {
    this.highlightTarget = v;
  }

  setTargetState(state: TargetState, received: ColorMask): void {
    if (state === 'lit' && this.targetState !== 'lit') this.pulse = 1;
    this.targetState = state;
    this.received = received;
  }

  get isLit(): boolean {
    return this.targetState === 'lit';
  }

  update(dt: number, time: number): void {
    const s = this.s;
    this.lift = damp(this.lift, this.liftTarget, 14, dt);
    this.highlight = damp(this.highlight, this.highlightTarget, 12, dt);
    this.yaw = damp(this.yaw, this.yawTarget, 18, dt);
    this.body.rotation.y = this.yaw;

    if (this.snap) {
      this.root.position.copy(this.home);
    } else {
      const k = 1 - Math.exp(-16 * dt);
      this.root.position.lerp(this.home, k);
    }
    this.root.position.y = this.home.y + this.lift * 0.35 * s;
    const scale = 1 + this.highlight * 0.07 + this.lift * 0.05;
    this.root.scale.setScalar(scale);
    this.ringMat.emissiveIntensity = this.highlight * 1.6;

    if (this.lens) {
      this.lens.scale.setScalar((0.55 + Math.sin(time * 3) * 0.05) * s);
    }
    if (this.prismMat) {
      this.prismMat.emissive.setHSL((time * 0.05) % 1, 0.6, 0.55);
    }
    if (this.crystal && this.crystalMat && this.crystalGlow && this.pillar) {
      this.pulse = Math.max(0, this.pulse - dt * 1.2);
      const st = this.targetState;
      const flicker =
        st === 'wrong'
          ? 0.5 + 0.5 * Math.sin(time * 37) * Math.sin(time * 11)
          : st === 'partial'
            ? 0.75 + 0.25 * Math.sin(time * 4)
            : 1;
      const intensity =
        st === 'lit' ? 1.5 + this.pulse * 2 : st === 'off' ? 0.06 : 0.5 * flicker;
      this.crystalMat.emissiveIntensity = damp(
        this.crystalMat.emissiveIntensity,
        intensity,
        10,
        dt,
      );
      if (st === 'wrong') {
        this.crystalMat.emissive.copy(lightColor(this.received));
      } else {
        this.crystalMat.emissive.copy(lightColor(this.piece.color));
      }
      const spin = st === 'lit' ? 1.6 : 0.35;
      this.crystal.rotation.y += dt * spin;
      this.crystal.position.y =
        0.42 * s + (st === 'lit' ? Math.sin(time * 2.2) * 0.04 * s + 0.05 * s : 0);
      const glowMat = this.crystalGlow.material as SpriteMaterial;
      glowMat.opacity = damp(
        glowMat.opacity,
        st === 'lit' ? 0.85 : st === 'off' ? 0 : 0.35 * flicker,
        8,
        dt,
      );
      this.crystalGlow.position.y = this.crystal.position.y;
      this.crystalGlow.scale.setScalar((1.2 + this.pulse * 1.5) * s);
      const pillarMat = this.pillar.material as MeshBasicMaterial;
      pillarMat.opacity = damp(pillarMat.opacity, st === 'lit' ? 0.22 : 0, 4, dt);
      for (const { mesh, bit } of this.pips) {
        const m = mesh.material as MeshStandardMaterial;
        m.emissiveIntensity = this.received & bit ? 1.8 : 0.22;
      }
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}
