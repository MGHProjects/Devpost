/**
 * Session measurements behind the `?perf=1` overlay: frame times per board
 * (1 ms histogram, so percentiles cost no sorting and no per-frame allocation)
 * and a short event log (casts, solves, tracking losses, pauses, frame-rate
 * changes). `summary()` turns both into the plain-text report shown on the 2D
 * page after a headset session, for the owner to copy back.
 */

const BINS = 101; // 0..99 ms, last bin = 100 ms or more
const RECENT = 270; // ~3 s at 90 Hz
const MAX_EVENTS = 600;

export type PerfEventKind =
  | 'enter'
  | 'exit'
  | 'placed'
  | 'board'
  | 'cast'
  | 'shatter'
  | 'solved'
  | 'hint'
  | 'reset'
  | 'loss'
  | 'pause'
  | 'resume'
  | 'rate';

export interface PerfEvent {
  t: number;
  kind: PerfEventKind;
  detail: string;
}

interface BoardStats {
  id: string;
  time: number;
  frames: number;
  missed: number;
  under60: number;
  hist: Uint32Array;
  casts: number;
  shatters: number;
  hints: number;
  /** Seconds on the board when it was first solved, -1 if never. */
  solvedAt: number;
}

function newBoard(id: string): BoardStats {
  return { id, time: 0, frames: 0, missed: 0, under60: 0, hist: new Uint32Array(BINS), casts: 0, shatters: 0, hints: 0, solvedAt: -1 };
}

function percentile(hist: Uint32Array, total: number, q: number): number {
  if (!total) return 0;
  const want = Math.ceil(total * q);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= want) return i + 0.5;
  }
  return hist.length - 0.5;
}

const mmss = (s: number): string => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export class PerfStats {
  /** Last frame times (s), ring buffer, for the live graph. */
  readonly recent = new Float32Array(RECENT);
  recentAt = 0;
  readonly events: PerfEvent[] = [];
  private boards = new Map<string, BoardStats>();
  private board: BoardStats | null = null;
  private all = newBoard('all');
  /** Session clock (s), advanced by frame(). */
  time = 0;

  /** One rendered XR frame. `rate` is the display's target Hz (0 = unknown). */
  frame(dt: number, rate: number): void {
    this.time += dt;
    this.recent[this.recentAt] = dt;
    this.recentAt = (this.recentAt + 1) % RECENT;
    this.add(this.all, dt, rate);
    if (this.board) this.add(this.board, dt, rate);
  }

  private add(b: BoardStats, dt: number, rate: number): void {
    b.time += dt;
    b.frames++;
    b.hist[Math.min(BINS - 1, Math.floor(dt * 1000))]++;
    // A frame that took longer than 1.5 vsyncs missed at least one.
    if (dt > 1.5 / (rate || 72)) b.missed++;
    if (dt > 1 / 60 + 0.0005) b.under60++;
  }

  event(kind: PerfEventKind, detail = ''): void {
    if (this.events.length >= MAX_EVENTS) this.events.splice(0, 100);
    this.events.push({ t: this.time, kind, detail });
    if (kind === 'board') {
      let b = this.boards.get(detail);
      if (!b) this.boards.set(detail, (b = newBoard(detail)));
      this.board = b;
      return;
    }
    const b = this.board;
    if (!b) return;
    if (kind === 'cast') b.casts++;
    else if (kind === 'shatter') b.shatters++;
    else if (kind === 'hint') b.hints++;
    else if (kind === 'solved' && b.solvedAt < 0) b.solvedAt = b.time;
  }

  /** Live numbers for the overlay over the recent window. */
  recentStats(rate: number): { fps: number; p95: number; missed: number } {
    let sum = 0;
    let n = 0;
    let missed = 0;
    const budget = 1 / (rate || 72);
    const sorted = this.scratch;
    for (let i = 0; i < RECENT; i++) {
      const v = this.recent[i];
      if (v <= 0) continue;
      sorted[n++] = v;
      sum += v;
      if (v > budget * 1.5) missed++;
    }
    if (!n) return { fps: 0, p95: 0, missed: 0 };
    const view = sorted.subarray(0, n).sort();
    this.live.fps = n / sum;
    this.live.p95 = view[Math.min(n - 1, Math.floor(n * 0.95))] * 1000;
    this.live.missed = missed / n;
    return this.live;
  }
  private scratch = new Float32Array(RECENT);
  private live = { fps: 0, p95: 0, missed: 0 };

  summary(header: string): string {
    const lines: string[] = [header];
    const a = this.all;
    const pct = (x: number, n: number) => (n ? ((100 * x) / n).toFixed(1) : '0.0') + '%';
    lines.push(
      `session ${mmss(a.time)}  frames ${a.frames}  p50 ${percentile(a.hist, a.frames, 0.5).toFixed(1)}ms  p95 ${percentile(a.hist, a.frames, 0.95).toFixed(1)}ms  p99 ${percentile(a.hist, a.frames, 0.99).toFixed(1)}ms  missed ${pct(a.missed, a.frames)}  <60fps ${pct(a.under60, a.frames)}`,
    );
    lines.push('board            time   p95   p99  missed  casts shat hint  solved');
    for (const b of this.boards.values()) {
      if (!b.frames) continue;
      lines.push(
        [
          b.id.padEnd(15).slice(0, 15),
          mmss(b.time).padStart(6),
          percentile(b.hist, b.frames, 0.95).toFixed(1).padStart(5),
          percentile(b.hist, b.frames, 0.99).toFixed(1).padStart(5),
          pct(b.missed, b.frames).padStart(7),
          String(b.casts).padStart(6),
          String(b.shatters).padStart(4),
          String(b.hints).padStart(4),
          (b.solvedAt < 0 ? '-' : mmss(b.solvedAt)).padStart(7),
        ].join(' '),
      );
    }
    const count = (k: PerfEventKind, d?: string) => this.events.filter((e) => e.kind === k && (d === undefined || e.detail === d)).length;
    lines.push(
      `tracking lost: right ${count('loss', 'right')}, left ${count('loss', 'left')}   pauses ${count('pause')}   ` +
        `rate: ${this.events.filter((e) => e.kind === 'rate').map((e) => `${e.detail} Hz @${mmss(e.t)}`).join(', ') || 'unchanged'}`,
    );
    const placed = this.events.find((e) => e.kind === 'placed');
    const firstCast = this.events.find((e) => e.kind === 'cast');
    const firstSolve = this.events.find((e) => e.kind === 'solved');
    const at = (e?: PerfEvent) => (e ? mmss(e.t) : 'never');
    lines.push(`first minutes: bench ${at(placed)}${placed ? ` (${placed.detail})` : ''}, first glass ${at(firstCast)}, first solve ${at(firstSolve)}`);
    return lines.join('\n');
  }
}
