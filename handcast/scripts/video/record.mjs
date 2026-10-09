// Records the demo video footage frame-by-frame from the IWER emulator.
// Usage: (dev server running) node scripts/video/record.mjs [outDir]
// Produces <outDir>/frames/*.jpg, <outDir>/audio.wav, <outDir>/captions.json
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { PINCH_OFFSET, installHelpers } from '../e2e/iwer.mjs';
import { openApp } from './browser.mjs';
import { installGrabber } from './grab.mjs';
import { Timeline } from './timeline.mjs';

const OUT = process.argv[2] ?? 'artifacts/video';
const FPS = Number(process.env.FPS ?? 24);
const ONLY = process.env.SCENES ? process.env.SCENES.split(',').map(Number) : null;
rmSync(`${OUT}/frames`, { recursive: true, force: true });
mkdirSync(`${OUT}/frames`, { recursive: true });

const { browser, page, logs } = await openApp();
await page.evaluate(() => {
  localStorage.clear();
  window.__prismClock = { time: 0, dt: 0 };
});
await page.evaluate(() => window.prismSong.enterXR());
await page.waitForFunction(() => window.prismSong.xrActive());
await installHelpers(page);
await page.evaluate(() => {
  for (const e of document.querySelectorAll('body > div')) if (getComputedStyle(e).zIndex === '999') e.style.display = 'none';
  for (const c of document.querySelectorAll('canvas')) if (getComputedStyle(c).zIndex === '3') c.style.display = 'none';
});
await installGrabber(page, { brightness: 0.55 });

// Seated player; put the table in front of them, then look down at it.
await page.evaluate(async () => {
  window.__t.headset([0, 1.2, 0], 0, 0);
  await window.__t.frames(8);
  window.prismSong.recenter();
  await window.__t.frames(2);
  window.prismSong.audioLogStart();
});

const started = Date.now();
const tl = new Timeline(page, {
  fps: FPS,
  outDir: `${OUT}/frames`,
  onFrame: (n) => {
    if (n % 48 === 0) {
      const el = (Date.now() - started) / 1000;
      process.stdout.write(`frame ${n} (${(n / FPS).toFixed(1)}s video, ${el.toFixed(0)}s wall)\n`);
    }
  },
});

// Override step() so frames come from the in-page compositor grab.
tl.step = async function step() {
  const s = this.state;
  const t = this.frame / this.fps;
  // A little breathing sway so the camera feels hand-held, not robotic.
  const pitch = s.head.pitch + Math.sin(t * 0.9) * 0.6;
  const yaw = s.head.yaw + Math.sin(t * 0.63 + 1) * 0.8;
  const data = await this.page.evaluate(
    async ({ s, dt, pitch, yaw }) => {
      const tt = window.__t;
      tt.headset(s.head.pos, pitch, yaw);
      tt.handAt(s.right.pos, s.right.yaw, 'right');
      tt.handAt(s.left.pos, s.left.yaw, 'left');
      tt.pinch(s.right.pinch, 'right');
      tt.pinch(s.left.pinch, 'left');
      window.__prismClock.time += dt;
      window.__prismClock.dt = dt;
      await tt.frames(1);
      return window.__grab();
    },
    { s, dt: 1 / this.fps, pitch, yaw },
  );
  writeFileSync(`${this.outDir}/${String(this.frame).padStart(5, '0')}.jpg`, Buffer.from(data, 'base64'));
  this.frame++;
  this.onFrame?.(this.frame);
};

const ev = (fn, arg) => page.evaluate(fn, arg);
const grab = (id) => () => ev((id) => window.prismSong.grabPoint(id), id);
const cell = (x, y, dy = 0.012) => () =>
  ev(([x, y, dy]) => {
    const c = window.prismSong.cellWorld(x, y);
    const s = window.prismSong.grabPoint(0)[1] - window.prismSong.pieceWorld(0)[1];
    c[1] += s + dy;
    return c;
  }, [x, y, dy]);
const above = (f, dy) => async () => {
  const p = await f();
  return [p[0], p[1] + dy, p[2]];
};
const REST_R = [0.17, 0.7, -0.17];
const REST_L = [-0.17, 0.7, -0.17];
const HEAD = { pitch: -46, yaw: 0, pos: [0, 1.1, -0.08] };

async function pinchMove(hand, from, to, { lift = 0.05, twist = 0, travel = 1.3 } = {}) {
  await tl.tween(1.0, { [`${hand}.pos`]: above(from, lift) });
  await tl.tween(0.45, { [`${hand}.pos`]: from });
  await tl.tween(0.14, { [`${hand}.pinch`]: 1 });
  await tl.wait(0.15);
  await tl.tween(0.4, { [`${hand}.pos`]: above(from, lift) });
  await tl.tween(travel, { [`${hand}.pos`]: above(to, 0.03) });
  await tl.tween(0.35, { [`${hand}.pos`]: to });
  if (twist) {
    await tl.tween(1.0, { [`${hand}.yaw`]: twist });
    await tl.wait(0.25);
  }
  await tl.tween(0.14, { [`${hand}.pinch`]: 0 });
}

async function rest(sec = 0.9) {
  await tl.tween(sec, { 'right.pos': REST_R, 'left.pos': REST_L, 'right.yaw': 0, 'left.yaw': 0 });
}

async function lookAt(worldFn, sec) {
  const p = await worldFn();
  const h = tl.state.head.pos;
  const dx = p[0] - h[0];
  const dy = p[1] - h[1];
  const dz = p[2] - h[2];
  const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
  const pitch = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  await tl.tween(sec, { 'head.pitch': pitch, 'head.yaw': yaw });
}

const scenes = [
  // 0. First Light: twist a locked mirror.
  async () => {
    await ev(() => window.prismSong.load(0));
    Object.assign(tl.state.head, { ...HEAD, pos: [...HEAD.pos] });
    tl.state.right.pos = REST_R;
    tl.state.left.pos = REST_L;
    await tl.wait(1.2);
    tl.caption('Pinch the brass mirror. Twist your wrist to turn it.', 5.2);
    await tl.tween(1.1, { 'right.pos': above(grab(1), 0.05) });
    await tl.tween(0.45, { 'right.pos': grab(1) });
    await tl.tween(0.14, { 'right.pinch': 1 });
    await tl.wait(0.2);
    await tl.tween(1.3, { 'right.yaw': 30 });
    await tl.wait(0.3);
    await tl.tween(0.14, { 'right.pinch': 0 });
    tl.caption('Light a crystal and it sings.', 3);
    await tl.wait(1.0);
    await rest();
    await tl.wait(1.2);
  },
  // 1. Placing: carry a mirror from the tray, live beams while held.
  async () => {
    await ev(() => window.prismSong.load(1));
    await tl.wait(0.8);
    tl.caption('Carry pieces from the tray. The light follows your hand.', 6.5);
    await pinchMove('right', grab(2), cell(3, 1), { twist: 30, travel: 1.6 });
    await tl.wait(0.6);
    await rest();
    await tl.wait(1.4);
  },
  // 2. Prism: white light unweaves into a chord.
  async () => {
    await ev(() => window.prismSong.load(3));
    await tl.wait(0.8);
    tl.caption('A prism unweaves white light into red, green and blue.', 5);
    await pinchMove('right', grab(4), cell(2, 2), { travel: 1.2 });
    tl.caption('Every crystal is a note. Every puzzle is a chord.', 4.2);
    await tl.wait(0.8);
    await rest();
    await tl.wait(2.4);
  },
  // 3. Harmony: mixing beams.
  async () => {
    await ev(() => window.prismSong.load(4));
    await tl.wait(0.8);
    tl.caption('Mix beams: red and green make yellow.', 5.5);
    await pinchMove('right', grab(3), cell(2, 2), { twist: -30, travel: 1.0 });
    await tl.wait(0.6);
    await rest();
    await tl.wait(1.6);
  },
  // 4. Gaze, poke, two hands.
  async () => {
    await ev(() => window.prismSong.load(5));
    tl.caption('Each lesson teaches one idea.', 3.4);
    await tl.wait(4.0);
    tl.caption('Look at a crystal to hear it and see what it needs.', 4.4);
    await lookAt(above(grab(2), 0.02), 1.0);
    await tl.wait(1.8);
    await tl.tween(0.9, { 'head.pitch': HEAD.pitch, 'head.yaw': HEAD.yaw });
    tl.caption('Or touch it with a fingertip. No controllers needed.', 4.2);
    // Poke the blue crystal with the right index finger (open hand).
    // Offset from handAt()'s anchor (hand position + pinched offset) to the open index tip.
    const tip = await ev((po) => {
      const h = window.prismSong.hands()[1];
      const hp = window.IWER_DEVICE.hands.right.position;
      return [h.indexTip[0] - hp.x - po[0], h.indexTip[1] - hp.y - po[1], h.indexTip[2] - hp.z - po[2]];
    }, PINCH_OFFSET);
    const crystal = await grab(3)();
    const target = [crystal[0] - tip[0], crystal[1] + 0.012 - tip[1], crystal[2] - tip[2]];
    await tl.tween(1.1, { 'right.pos': [target[0], target[1] + 0.06, target[2] + 0.03] });
    await tl.tween(0.35, { 'right.pos': target });
    await tl.wait(0.15);
    await tl.tween(0.35, { 'right.pos': [target[0], target[1] + 0.06, target[2] + 0.03] });
    await tl.wait(0.9);
    tl.caption('Split the light, then sieve it. Both hands work together.', 9.5);
    // Twist the locked splitter, then place both filters.
    await tl.tween(1.0, { 'right.pos': above(grab(1), 0.04) });
    await tl.tween(0.4, { 'right.pos': grab(1) });
    await tl.tween(0.14, { 'right.pinch': 1 });
    await tl.tween(1.0, { 'right.yaw': -30 });
    await tl.tween(0.14, { 'right.pinch': 0 });
    await tl.tween(0.6, { 'right.pos': REST_R, 'right.yaw': 0 });
    await pinchMove('left', grab(4), cell(2, 1), { travel: 1.0 });
    await pinchMove('right', grab(5), cell(3, 2), { travel: 1.0 });
    await tl.wait(0.4);
    await rest();
    await tl.wait(1.8);
  },
  // 5. Move the table by its handle.
  async () => {
    tl.caption('Pinch the handle to move your table. It stays anchored in your room.', 5.6);
    const handle = () => ev(() => {
      const o = window.prismSong.boardRoot().getObjectByName('board-handle');
      return o.getWorldPosition(o.position.clone()).toArray();
    });
    const h = await handle();
    await tl.tween(1.1, { 'right.pos': [h[0] + 0.02, h[1] + 0.05, h[2]] });
    await tl.tween(0.4, { 'right.pos': [h[0] + 0.02, h[1], h[2]] });
    await tl.tween(0.14, { 'right.pinch': 1 });
    await tl.tween(1.4, { 'right.pos': [h[0] + 0.08, h[1] + 0.02, h[2] + 0.06] });
    await tl.tween(0.14, { 'right.pinch': 0 });
    await rest(1.0);
    await tl.wait(0.8);
  },
  // 6. More content: menu, then a late puzzle solved in fast-forward.
  async () => {
    tl.caption('24 puzzles in three movements, plus a new Daily Chord every day.', 5.2);
    await ev(() => window.prismSong.menu(true));
    await lookAt(() => ev(() => window.prismSong.hud()), 0.9);
    await tl.wait(2.2);
    await ev(() => window.prismSong.load(20));
    await tl.tween(0.9, { 'head.pitch': HEAD.pitch, 'head.yaw': HEAD.yaw });
    await tl.wait(1.4);
    tl.caption('Dusk, puzzle 5 (fast-forward)', 4.5);
    await ev(() => window.prismSong.solve());
    await tl.wait(4.6);
  },
];

for (const [i, scene] of scenes.entries()) {
  if (ONLY && !ONLY.includes(i)) continue;
  if (ONLY) Object.assign(tl.state.head, { ...HEAD, pos: [...HEAD.pos] });
  await scene();
  const st = await ev(() => window.prismSong.state());
  console.log(`scene ${i}: ${st.level} solved=${st.solved}`);
}

const seconds = tl.seconds;
writeFileSync(`${OUT}/captions.json`, JSON.stringify({ fps: FPS, seconds, captions: tl.captions }, null, 1));
const wav = await ev(([s]) => window.prismSong.audioRender(0, s + 1), [seconds]);
writeFileSync(`${OUT}/audio.wav`, Buffer.from(wav, 'base64'));
console.log(`done: ${tl.frame} frames, ${seconds.toFixed(1)}s, wall ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (logs.length) console.log('page errors:\n' + logs.slice(0, 10).join('\n'));
await browser.close();
