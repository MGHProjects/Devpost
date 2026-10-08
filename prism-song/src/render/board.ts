/**
 * The tabletop: a smoked-glass slab with a luminous grid, a tray rail on the
 * player's side and a grab handle for moving the whole board.
 */

import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from '@iwsdk/core';

const invisible = () =>
  new MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });

export class BoardView {
  readonly group = new Group();
  /** Invisible plane over the grid; pointer target for "tap a cell". */
  readonly surface: Mesh;
  /** Invisible plane over the tray; pointer target for "put it back". */
  readonly traySurface: Mesh;
  /** Grip bar the player pinches to move the whole board. */
  readonly handle: Group;
  readonly cell: number;
  readonly width: number;
  readonly trayZ: number;
  private rimMat: MeshStandardMaterial;
  private cursor: Mesh;
  private cursorMat: MeshBasicMaterial;
  private handleMat: MeshStandardMaterial;
  private materials: Material[] = [];
  private glow = 0;
  private trayCount: number;

  constructor(
    readonly size: number,
    trayCount: number,
  ) {
    this.trayCount = trayCount;
    const cell = (this.cell = Math.min(0.075, 0.4 / size));
    const w = (this.width = cell * size);
    const margin = cell * 0.35;
    this.group.name = 'board';

    const slabMat = new MeshStandardMaterial({
      color: 0x10141d,
      roughness: 0.28,
      metalness: 0.35,
      transparent: true,
      opacity: 0.93,
    });
    const slab = new Mesh(new BoxGeometry(w + margin * 2, 0.014, w + margin * 2), slabMat);
    slab.position.y = -0.007;
    this.group.add(slab);
    this.materials.push(slabMat);

    // Grid lines.
    const pts: number[] = [];
    const h = w / 2;
    for (let i = 0; i <= size; i++) {
      const t = -h + i * cell;
      pts.push(t, 0.0006, -h, t, 0.0006, h, -h, 0.0006, t, h, 0.0006, t);
    }
    const gridGeo = new BufferGeometry();
    gridGeo.setAttribute('position', new Float32BufferAttribute(pts, 3));
    const gridMat = new LineBasicMaterial({
      color: 0x5d6f9e,
      transparent: true,
      opacity: 0.55,
    });
    this.group.add(new LineSegments(gridGeo, gridMat));
    this.materials.push(gridMat);

    // Emissive rim.
    this.rimMat = new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0x8fa6ff,
      emissiveIntensity: 0.35,
    });
    this.materials.push(this.rimMat);
    const rimW = w + margin * 2;
    for (const [sx, sz, px, pz] of [
      [rimW, 0.004, 0, rimW / 2],
      [rimW, 0.004, 0, -rimW / 2],
      [0.004, rimW, rimW / 2, 0],
      [0.004, rimW, -rimW / 2, 0],
    ]) {
      const rim = new Mesh(new BoxGeometry(sx, 0.004, sz), this.rimMat);
      rim.position.set(px, 0.001, pz);
      this.group.add(rim);
    }

    // Hover cursor for the cell under the pointer / held piece.
    this.cursorMat = new MeshBasicMaterial({
      color: 0xbcd3ff,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.materials.push(this.cursorMat);
    this.cursor = new Mesh(new PlaneGeometry(cell * 0.9, cell * 0.9), this.cursorMat);
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.position.y = 0.0012;
    this.group.add(this.cursor);

    const inv = invisible();
    this.materials.push(inv);
    this.surface = new Mesh(new PlaneGeometry(w, w), inv);
    this.surface.rotation.x = -Math.PI / 2;
    this.surface.position.y = 0.002;
    this.surface.name = 'board-surface';
    this.group.add(this.surface);

    // Tray rail on the near side.
    this.trayZ = h + margin + cell * 0.75;
    const trayLen = Math.max(trayCount, 1) * cell * 1.1 + cell * 0.4;
    const trayMat = new MeshStandardMaterial({
      color: 0x1a1f2b,
      roughness: 0.4,
      metalness: 0.5,
      transparent: true,
      opacity: 0.9,
    });
    this.materials.push(trayMat);
    const tray = new Mesh(new BoxGeometry(trayLen, 0.01, cell * 1.15), trayMat);
    tray.position.set(0, -0.005, this.trayZ);
    tray.visible = trayCount > 0;
    this.group.add(tray);
    this.traySurface = new Mesh(new PlaneGeometry(trayLen, cell * 1.15), inv);
    this.traySurface.rotation.x = -Math.PI / 2;
    this.traySurface.position.set(0, 0.002, this.trayZ);
    this.traySurface.name = 'tray-surface';
    this.traySurface.visible = trayCount > 0;
    this.group.add(this.traySurface);

    // Move handle: a pill on the far edge, out of the way of play.
    this.handle = new Group();
    this.handle.name = 'board-handle';
    this.handleMat = new MeshStandardMaterial({
      color: 0x2b3245,
      emissive: 0x8fa6ff,
      emissiveIntensity: 0.2,
      roughness: 0.3,
      metalness: 0.6,
    });
    this.materials.push(this.handleMat);
    const bar = new Mesh(new CylinderGeometry(0.009, 0.009, 0.1, 16), this.handleMat);
    bar.rotation.z = Math.PI / 2;
    this.handle.add(bar);
    this.handle.position.set(0, 0.02, -(h + margin + 0.03));
    this.group.add(this.handle);
  }

  cellToLocal(x: number, y: number, out: Vector3): Vector3 {
    const half = (this.size - 1) / 2;
    return out.set((x - half) * this.cell, 0, -(y - half) * this.cell);
  }

  /** Nearest cell to a board-local point, or null if off the grid. */
  localToCell(p: Vector3, slack = 0.5): { x: number; y: number } | null {
    const half = (this.size - 1) / 2;
    const fx = p.x / this.cell + half;
    const fy = -p.z / this.cell + half;
    const x = Math.round(fx);
    const y = Math.round(fy);
    if (fx < -slack || fy < -slack || fx > this.size - 1 + slack || fy > this.size - 1 + slack) {
      return null;
    }
    return { x: Math.min(this.size - 1, Math.max(0, x)), y: Math.min(this.size - 1, Math.max(0, y)) };
  }

  traySlot(i: number, out: Vector3): Vector3 {
    const spacing = this.cell * 1.1;
    return out.set((i - (this.trayCount - 1) / 2) * spacing, 0, this.trayZ);
  }

  isOverTray(p: Vector3): boolean {
    return Math.abs(p.z - this.trayZ) < this.cell * 1.2 && Math.abs(p.x) < this.width / 2 + this.cell;
  }

  setCursor(cell: { x: number; y: number } | null, ok = true): void {
    if (!cell) {
      this.cursorMat.opacity = 0;
      return;
    }
    this.cellToLocal(cell.x, cell.y, this.cursor.position);
    this.cursor.position.y = 0.0012;
    this.cursorMat.color.setHex(ok ? 0xbcd3ff : 0xff6070);
    this.cursorMat.opacity = 0.32;
  }

  setHandleHighlight(v: number): void {
    this.handleMat.emissiveIntensity = 0.2 + v * 1.4;
  }

  flash(): void {
    this.glow = 1;
  }

  update(dt: number, time: number): void {
    this.glow = Math.max(0, this.glow - dt * 0.6);
    this.rimMat.emissiveIntensity = 0.3 + Math.sin(time * 1.3) * 0.05 + this.glow * 2.2;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}
