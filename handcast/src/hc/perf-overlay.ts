/**
 * `?perf=1`: a small world-locked panel beside the bench for testing on a real
 * headset (frame times, per-finger straightness, stillness and pour), plus the
 * session report on the 2D page after leaving XR, with a Copy button.
 */
import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Object3D } from '@iwsdk/core';
import { FEATURE } from '../core/hand-features.js';
import type { PerfStats } from './perf-stats.js';

export interface PerfHand {
  name: string;
  tracked: boolean;
  lostFor: number;
  mode: string | null;
  ratio: number[];
  open: boolean[];
  still: boolean;
  progress: number;
}

export interface PerfInfo {
  rate: number;
  calls: number;
  triangles: number;
  board: string;
  casts: number;
  paused: boolean;
}

const W = 640;
const H = 400;
/** Panel width in metres: 24 px text is about 1 cm tall, ~1 degree at 0.6 m. */
const WIDTH_M = 0.26;
const REDRAW = 0.25;

export function perfEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const v = new URLSearchParams(window.location.search).get('perf');
  return v !== null && v !== '0';
}

export class PerfOverlay {
  readonly mesh: Mesh;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  private nextDraw = 0;

  constructor(private stats: PerfStats) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.mesh = new Mesh(new PlaneGeometry(WIDTH_M, (WIDTH_M * H) / W), mat);
    this.mesh.renderOrder = 3000;
    this.mesh.name = 'perf-overlay';
  }

  /** Places the panel beside the bench's right edge, turned toward a seated player. */
  attach(parent: Object3D, benchW: number, benchD: number): void {
    parent.add(this.mesh);
    this.mesh.position.set(benchW / 2 + 0.17, 0.12, -benchD * 0.15);
    this.mesh.rotation.set(-0.35, -0.55, 0, 'YXZ');
  }

  update(time: number, info: PerfInfo, hands: PerfHand[]): void {
    if (time < this.nextDraw) return;
    this.nextDraw = time + REDRAW;
    const g = this.g;
    const live = this.stats.recentStats(info.rate);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(6, 8, 14, 0.86)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(143, 208, 255, 0.6)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, W - 2, H - 2);
    g.font = '600 24px monospace';
    g.textBaseline = 'top';
    const budgetMs = 1000 / (info.rate || 72);
    const bad = live.missed > 0.05 || live.p95 > budgetMs * 1.2;
    g.fillStyle = bad ? '#ff9a7a' : '#9df0b4';
    g.fillText(`${(info.rate || 0).toFixed(0)}Hz fps ${live.fps.toFixed(1)} p95 ${live.p95.toFixed(1)}ms miss ${(live.missed * 100).toFixed(1)}%`, 14, 12);
    g.fillStyle = '#c9d6f2';
    g.font = '500 20px monospace';
    g.fillText(`draws ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k  ${info.board}  glass ${info.casts}${info.paused ? '  PAUSED' : ''}`, 14, 44);

    // Frame-time graph: last ~3 s, with the target and the 60 fps lines.
    const gx = 14;
    const gy = 76;
    const gw = W - 28;
    const gh = 96;
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(gx, gy, gw, gh);
    const toY = (ms: number) => gy + gh - Math.min(1, ms / 34) * gh;
    g.strokeStyle = 'rgba(157,240,180,0.6)';
    g.beginPath();
    g.moveTo(gx, toY(budgetMs));
    g.lineTo(gx + gw, toY(budgetMs));
    g.stroke();
    g.strokeStyle = 'rgba(255,154,122,0.6)';
    g.beginPath();
    g.moveTo(gx, toY(16.7));
    g.lineTo(gx + gw, toY(16.7));
    g.stroke();
    const rec = this.stats.recent;
    const n = rec.length;
    const step = gw / n;
    for (let i = 0; i < n; i++) {
      const v = rec[(this.stats.recentAt + i) % n] * 1000;
      if (v <= 0) continue;
      g.fillStyle = v > budgetMs * 1.5 ? '#ff9a7a' : '#8fd0ff';
      const y = toY(v);
      g.fillRect(gx + i * step, y, Math.max(1, step), gy + gh - y);
    }

    // Hands: straightness per finger against the open/curled thresholds.
    let y = gy + gh + 14;
    g.font = '600 22px monospace';
    for (const h of hands) {
      g.fillStyle = h.tracked ? '#f3f5fa' : '#7d8597';
      const state = h.tracked ? `${h.mode ?? 'off-bench'}` : `lost ${h.lostFor.toFixed(1)}s`;
      g.fillText(`${h.name} ${state}`, 14, y);
      g.fillText(`still ${h.still ? 'Y' : '-'}  pour ${(h.progress * 100).toFixed(0)}%`, 330, y);
      y += 30;
      for (let f = 0; f < 5; f++) {
        const x = 14 + f * 122;
        const r = h.ratio[f] ?? 0;
        const enter = f === 0 ? FEATURE.thumbEnter : FEATURE.longEnter;
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(x, y, 110, 22);
        g.fillStyle = h.open[f] ? '#9df0b4' : '#ffcf7a';
        // Bar spans ratio 0.5..1.0.
        g.fillRect(x, y, Math.max(0, Math.min(1, (r - 0.5) / 0.5)) * 110, 22);
        g.fillStyle = '#ffffff';
        g.fillRect(x + ((enter - 0.5) / 0.5) * 110, y - 2, 2, 26);
        g.fillStyle = '#0b0e16';
        g.font = '600 18px monospace';
        g.fillText(`${'TIMRP'[f]} ${r.toFixed(2)}`, x + 4, y + 2);
        g.font = '600 22px monospace';
      }
      y += 40;
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.texture.dispose();
  }
}

/** Shows the last session's report on the 2D page (after leaving XR). */
export function showPerfReport(text: string): void {
  document.getElementById('hc-perf')?.remove();
  const box = document.createElement('div');
  box.id = 'hc-perf';
  box.style.cssText =
    'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:30;max-width:96vw;max-height:70vh;overflow:auto;' +
    'background:rgba(6,8,14,0.94);color:#e8ecf5;border:1px solid rgba(143,208,255,0.5);border-radius:10px;padding:12px 14px;' +
    'font:12px/1.4 monospace;white-space:pre;';
  const pre = document.createElement('div');
  pre.textContent = text;
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;margin-top:10px;font-family:system-ui,sans-serif;';
  const btn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:8px 16px;border-radius:999px;border:1px solid #8fd0ff;background:#0c1220;color:#f3f5fa;font-size:14px;';
    b.addEventListener('click', fn);
    bar.append(b);
    return b;
  };
  const copy = btn('Copy report', () => {
    void navigator.clipboard?.writeText(text).then(
      () => (copy.textContent = 'Copied'),
      () => (copy.textContent = 'Select the text to copy'),
    );
  });
  btn('Close', () => box.remove());
  box.append(pre, bar);
  document.body.append(box);
}
