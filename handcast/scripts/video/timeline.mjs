// Frame-accurate choreography for the demo video. Every action advances a
// virtual clock in fixed 1/fps steps; each step renders and captures a frame.
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export class Timeline {
  constructor(page, { fps = 30, outDir, onFrame } = {}) {
    this.page = page;
    this.fps = fps;
    this.outDir = outDir;
    this.frame = 0;
    this.captions = [];
    this.onFrame = onFrame;
    this.state = {
      right: { pos: [0.2, 0.92, -0.2], yaw: 0, pinch: 0 },
      left: { pos: [-0.2, 0.92, -0.2], yaw: 0, pinch: 0 },
      head: { pos: [0, 1.2, 0], pitch: -36, yaw: 0 },
    };
  }

  get seconds() {
    return this.frame / this.fps;
  }

  async step() {
    const s = this.state;
    await this.page.evaluate(
      async ({ s, dt }) => {
        const t = window.__t;
        t.headset(s.head.pos, s.head.pitch, s.head.yaw);
        t.handAt(s.right.pos, s.right.yaw, 'right');
        t.handAt(s.left.pos, s.left.yaw, 'left');
        t.pinch(s.right.pinch, 'right');
        t.pinch(s.left.pinch, 'left');
        window.__prismClock.time += dt;
        window.__prismClock.dt = dt;
        await t.frames(2);
      },
      { s, dt: 1 / this.fps },
    );
    const name = `${this.outDir}/${String(this.frame).padStart(5, '0')}.jpg`;
    await this.page.screenshot({ path: name, type: 'jpeg', quality: 92 });
    this.frame++;
    if (this.onFrame) this.onFrame(this.frame);
  }

  async wait(sec) {
    const n = Math.round(sec * this.fps);
    for (let i = 0; i < n; i++) await this.step();
  }

  /** Run a page action at the current instant (no time passes). */
  async call(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /** Tween any of the choreographed values. `to` may be a function resolved now. */
  async tween(sec, targets) {
    const from = JSON.parse(JSON.stringify(this.state));
    const resolved = {};
    for (const [k, v] of Object.entries(targets)) resolved[k] = typeof v === 'function' ? await v() : v;
    const n = Math.max(1, Math.round(sec * this.fps));
    for (let i = 1; i <= n; i++) {
      const t = ease(i / n);
      for (const [key, to] of Object.entries(resolved)) {
        const [part, field] = key.split('.');
        const a = from[part][field];
        this.state[part][field] = Array.isArray(a) ? lerp3(a, to, t) : lerp(a, to, t);
      }
      await this.step();
    }
  }

  caption(text, sec) {
    this.captions.push({ text, start: this.seconds, end: this.seconds + sec });
  }
}
