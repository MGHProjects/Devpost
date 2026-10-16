// Records the HANDCAST demo footage frame by frame in the IWER Meta Quest 3
// emulator, through the real hand-tracking path: emulated hands are driven by
// FK pose parameters (smoothly tweened) or by IWER's own pinch pose, and the
// game runs on a virtual clock so every frame advances exactly 1/FPS.
//
// Usage (dev server running on https://localhost:8081/):
//   node scripts/video/record.mjs [outDir]          all scenes
//   SCENES=0,3 node scripts/video/record.mjs        a subset (for iteration)
// Produces <outDir>/frames/*.jpg, <outDir>/audio.wav, <outDir>/captions.json
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { openApp } from './browser.mjs';
import { installGrabber } from './grab.mjs';

const OUT = process.argv[2] ?? 'artifacts/video';
const FPS = Number(process.env.FPS ?? 24);
const ONLY = process.env.SCENES ? process.env.SCENES.split(',').map(Number) : null;
rmSync(`${OUT}/frames`, { recursive: true, force: true });
mkdirSync(`${OUT}/frames`, { recursive: true });

const { browser, page, logs } = await openApp();
const ev = (fn, arg) => page.evaluate(fn, arg);
await ev(() => {
  localStorage.clear();
  window.__hcClock = { time: 0, dt: 0 };
});
await ev(() => window.handcast.enterXR());
await page.waitForFunction(() => window.handcast.xrActive(), null, { timeout: 30000 });
// Hide the emulator's overlay UI (device panel, gizmos) so frames show only the room and the app.
await ev(() => {
  for (const e of document.querySelectorAll('body > div')) if (getComputedStyle(e).zIndex === '999') e.style.display = 'none';
  for (const c of document.querySelectorAll('canvas')) if (getComputedStyle(c).zIndex === '3') c.style.display = 'none';
});
await installGrabber(page, { brightness: 0.42 });

// Seated player: put the bench on the table in front of them, then look down at it.
const advance = async (sec) => {
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) {
    await ev(async (dt) => {
      window.__hcClock.time += dt;
      window.__hcClock.dt = dt;
      await new Promise((r) => requestAnimationFrame(() => r()));
    }, 1 / FPS);
  }
};
await ev(() => {
  window.handcast.setHead([0, 1.2, 0], 0, 0);
  window.handcast.iwerHand('left', null);
  window.handcast.iwerHand('right', null);
});
await advance(0.4);
await ev(() => window.handcast.placeInFront(0.75));
await advance(0.2);
const LEVELS = await ev(() => window.handcast.levels());
await ev(() => window.handcast.audioLogStart());
const AUDIO_T0 = await ev(() => window.__hcClock.time);

// ------------------------------------------------------------------ timeline

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};
const FK_DEFAULTS = { spread: 0, yaw: -Math.PI / 2, roll: 0, pitch: 0, lift: 0.035, thumbAbduct: 0 };
const full = (p) => ({ ...FK_DEFAULTS, ...p, curl: [...p.curl], at: [...p.at] });
const RELAXED = { curl: [0.15, 0.15, 0.15, 0.15, 0.18], spread: 0.25, pitch: -0.2, lift: 0.05, thumbAbduct: 0 };
const HEAD = { pos: [0, 1.06, -0.13], pitch: -46, yaw: 0 };

const state = {
  head: { ...HEAD, pos: [...HEAD.pos] },
  left: { mode: 'hidden' },
  right: { mode: 'hidden' },
};
let frame = 0;
let lastTrace = '';
const captions = [];
const started = Date.now();
const seconds = () => frame / FPS;

async function step() {
  const t = frame / FPS;
  // A little breathing sway so the camera feels hand-held, not robotic.
  const pitch = state.head.pitch + Math.sin(t * 0.9) * 0.5;
  const yaw = state.head.yaw + Math.sin(t * 0.63 + 1) * 0.7;
  const data = await ev(
    async ({ s, dt, pitch, yaw }) => {
      const hc = window.handcast;
      hc.setHead(s.head.pos, pitch, yaw);
      for (const hand of ['left', 'right']) {
        const h = s[hand];
        if (h.mode === 'fk') hc.iwerHandParams({ ...h.p, hand });
        else if (h.mode === 'pinch') hc.iwerPinchAt(hand, h.at, h.value, h.yaw);
        else hc.iwerHand(hand, null);
      }
      window.__hcClock.time += dt;
      window.__hcClock.dt = dt;
      await new Promise((r) => requestAnimationFrame(() => r()));
      return window.__grab();
    },
    { s: state, dt: 1 / FPS, pitch, yaw },
  );
  writeFileSync(`${OUT}/frames/${String(frame).padStart(5, '0')}.jpg`, Buffer.from(data, 'base64'));
  if (process.env.TRACE) {
    const s = await ev(() => {
      const st = window.handcast.state();
      const r = st.live[1];
      return `casts=${st.casts} solved=${st.solved} cr=${(st.crystals ?? []).join('')} hush=${(st.hush ?? []).map(Number).join('')} R:${r.tracked ? 't' : '-'}${r.mode ?? 'x'} p=${r.progress.toFixed(2)} still=${r.still}`;
    });
    if (s !== lastTrace) console.log(`[${(frame / FPS).toFixed(2)}] ${s}`);
    lastTrace = s;
  }
  frame++;
  if (frame % 48 === 0) {
    const el = (Date.now() - started) / 1000;
    process.stdout.write(`frame ${frame} (${seconds().toFixed(1)}s video, ${el.toFixed(0)}s wall)\n`);
  }
}

async function wait(sec) {
  const n = Math.round(sec * FPS);
  for (let i = 0; i < n; i++) await step();
}

/** Tweens a hand's FK parameters (or the head) to `to` over `sec`. */
async function tweenHand(hand, to, sec) {
  const h = state[hand];
  const from = h.mode === 'fk' ? full(h.p) : full({ ...RELAXED, ...to, lift: 0.2 });
  const target = full({ ...from, ...to, curl: to.curl ?? from.curl, at: to.at ?? from.at });
  state[hand] = { mode: 'fk', p: full(from) };
  const n = Math.max(1, Math.round(sec * FPS));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    const p = state[hand].p;
    p.curl = from.curl.map((c, j) => lerp(c, target.curl[j], k));
    p.at = [lerp(from.at[0], target.at[0], k), lerp(from.at[1], target.at[1], k)];
    p.yaw = lerpAngle(from.yaw, target.yaw, k);
    for (const f of ['spread', 'roll', 'pitch', 'lift', 'thumbAbduct']) p[f] = lerp(from[f], target[f], k);
    await step();
  }
}

/** Tweens two hands at once (both FK). */
async function tweenBoth(toL, toR, sec) {
  const init = (hand, to) => {
    const h = state[hand];
    const from = h.mode === 'fk' ? full(h.p) : full({ ...RELAXED, ...to, lift: 0.2 });
    return { from, target: full({ ...from, ...to, curl: to.curl ?? from.curl, at: to.at ?? from.at }) };
  };
  const L = init('left', toL);
  const R = init('right', toR);
  state.left = { mode: 'fk', p: full(L.from) };
  state.right = { mode: 'fk', p: full(R.from) };
  const n = Math.max(1, Math.round(sec * FPS));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    for (const [hand, { from, target }] of [['left', L], ['right', R]]) {
      const p = state[hand].p;
      p.curl = from.curl.map((c, j) => lerp(c, target.curl[j], k));
      p.at = [lerp(from.at[0], target.at[0], k), lerp(from.at[1], target.at[1], k)];
      p.yaw = lerpAngle(from.yaw, target.yaw, k);
      for (const f of ['spread', 'roll', 'pitch', 'lift', 'thumbAbduct']) p[f] = lerp(from[f], target[f], k);
    }
    await step();
  }
}

async function tweenHead(to, sec) {
  const from = { ...state.head, pos: [...state.head.pos] };
  const n = Math.max(1, Math.round(sec * FPS));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    if (to.pos) state.head.pos = from.pos.map((v, j) => lerp(v, to.pos[j], k));
    if (to.pitch !== undefined) state.head.pitch = lerp(from.pitch, to.pitch, k);
    if (to.yaw !== undefined) state.head.yaw = lerp(from.yaw, to.yaw, k);
    await step();
  }
}

/** Tweens a hand in IWER pinch mode: bench-space pinch point, pinch value, yaw (deg). */
async function tweenPinch(hand, to, sec) {
  const h = state[hand];
  const from = h.mode === 'pinch' ? { ...h, at: [...h.at] } : { mode: 'pinch', at: to.at, value: 0, yaw: 0 };
  const target = { at: to.at ?? from.at, value: to.value ?? from.value, yaw: to.yaw ?? from.yaw };
  const n = Math.max(1, Math.round(sec * FPS));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    state[hand] = {
      mode: 'pinch',
      at: from.at.map((v, j) => lerp(v, target.at[j], k)),
      value: lerp(from.value, target.value, k),
      yaw: lerp(from.yaw, target.yaw, k),
    };
    await step();
  }
}

function hide(hand) {
  state[hand] = { mode: 'hidden' };
}

function caption(text, sec) {
  captions.push({ text, start: seconds(), end: seconds() + sec });
}

async function lookAt(world, sec) {
  const h = state.head.pos;
  const dx = world[0] - h[0];
  const dy = world[1] - h[1];
  const dz = world[2] - h[2];
  const yaw = (Math.atan2(-dx, -dz) * 180) / Math.PI;
  const pitch = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  await tweenHead({ pitch, yaw }, sec);
}

async function load(id) {
  const i = LEVELS.indexOf(id);
  if (i < 0) throw new Error(`no level ${id}`);
  await ev((i) => window.handcast.load(i), i);
  // Every field explicit: a tween toward a solution must not inherit, say, the
  // spread of the open hand it starts from.
  return ((await ev(() => window.handcast.solutionParams())) ?? []).map(full);
}

/** Where a hand hovers before descending onto `p` (out toward the player and to its side). */
function hover(p, extra = {}) {
  const side = p.hand === 'left' ? -1 : 1;
  return { ...RELAXED, yaw: p.yaw, at: [p.at[0] + 0.07 * side, p.at[1] + 0.13], lift: 0.17, ...extra };
}

/** Lowers a hand onto its solution shape, holds still until the glass sets, withdraws. */
async function castHand(p, { approach = 1.5, settle = 2.3, out = 1.1 } = {}) {
  const hand = p.hand;
  if (state[hand].mode !== 'fk') state[hand] = { mode: 'fk', p: full(hover(p)) };
  // Shape the hand above the light (out of the casting slab), then lower it in:
  // the glass must set on the final shape, not on a half-folded one.
  await tweenHand(hand, { ...p, lift: Math.max(0.13, (p.lift ?? 0.05) + 0.07) }, approach * 0.6);
  await tweenHand(hand, p, approach * 0.4);
  await wait(settle);
  await withdraw(hand, out);
}

async function withdraw(hand, sec = 1.1) {
  const p = state[hand].p;
  const side = hand === 'left' ? -1 : 1;
  await tweenHand(hand, { ...RELAXED, yaw: p.yaw, at: [p.at[0] + 0.05 * side, p.at[1] + 0.2], lift: 0.2 }, sec);
  hide(hand);
}

/**
 * Keeps a hand in the light but moving (a slow loop of radius `amp` m, faster
 * than the stillness tolerance) so it shows its live beams without casting.
 */
async function drift(hand, base, sec, amp = 0.012) {
  const n = Math.max(2, Math.round(sec / 0.35));
  for (let i = 1; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * (sec / 1.4);
    await tweenHand(hand, { ...base, at: [base.at[0] + Math.sin(a) * amp, base.at[1] + (Math.cos(a) - 1) * amp] }, sec / n);
  }
}

const st = () => ev(() => window.handcast.state());

// ------------------------------------------------------------------ scenes

const scenes = [
  // 0. First Light: the hook.
  async () => {
    const [p] = await load('prologue-1');
    await wait(0.8);
    caption('Your hand is the only optic.', 2.8);
    state.right = { mode: 'fk', p: full(hover(p)) };
    await tweenHand('right', { ...p, lift: 0.1, curl: [0.3, 0.3, 0.3, 0.3, 0.3], spread: 0.4 }, 1.4);
    caption('Rest it in the light: light leaves through every open fingertip.', 3.6);
    await tweenHand('right', { ...p, lift: p.lift + 0.008 }, 0.8);
    await drift('right', { ...p, lift: p.lift + 0.008 }, 2.6, 0.012);
    caption('Hold still, and molten glass flows over it.', 3.0);
    await tweenHand('right', p, 0.35);
    await wait(2.4);
    caption('Slide out. The glass keeps your exact pose, and it sings.', 4.2);
    await withdraw('right', 1.4);
    await wait(2.6);
  },
  // 1. One: shape is the puzzle.
  async () => {
    const [p] = await load('prologue-2');
    await wait(0.6);
    caption('Hush stones must stay dark.', 3.4);
    const open = { curl: [0, 0, 0, 0, 0], spread: 1, thumbAbduct: 0.5, lift: 0.046, at: p.at, yaw: p.yaw };
    state.right = { mode: 'fk', p: full(hover(p)) };
    await tweenHand('right', { ...open, lift: 0.08 }, 1.0);
    await tweenHand('right', open, 0.5);
    // Keep moving while open so the open hand never sets into glass.
    await drift('right', open, 2.0, 0.014);
    caption('Fold every finger that must not shine.', 4);
    await tweenHand('right', { ...p, lift: 0.13 }, 0.8);
    await tweenHand('right', p, 0.6);
    await wait(2.3);
    await withdraw('right');
    await wait(1.4);
  },
  // 2. Catch: a lamp beam enters a fingertip and flows through the hand.
  async () => {
    const [p] = await load('catch-1');
    await wait(0.6);
    caption('Catch a beam on a fingertip. It flows through your hand.', 5);
    await castHand(p, { approach: 1.6 });
    await wait(1.6);
  },
  // 3. Mirror Palm: a hand on its edge is a mirror.
  async () => {
    const [p] = await load('mirror-1');
    await wait(0.6);
    caption('Stand your hand on its edge and it becomes a mirror.', 5);
    await castHand(p, { approach: 1.7 });
    await wait(1.5);
  },
  // 4. Physical glass: pinch the foot and twist, pluck the fingers, knock it over.
  async () => {
    await load('catch-3');
    await ev(() => window.handcast.castSolutionAt(0, 0, 0, 14));
    await wait(0.8);
    caption('Glass hands are objects. Pinch one by its foot and twist.', 5);
    const foot = await ev(() => window.handcast.castFoot(0));
    const at = [foot[0], 0.012, foot[1]];
    await tweenPinch('right', { at: [at[0] + 0.03, 0.1, at[2] + 0.1], value: 0, yaw: 0 }, 0.01);
    await tweenPinch('right', { at: [at[0], 0.04, at[2]] }, 0.9);
    await tweenPinch('right', { at }, 0.4);
    await tweenPinch('right', { value: 1 }, 0.25);
    await wait(0.3);
    await tweenPinch('right', { yaw: -14 }, 1.4);
    await wait(0.3);
    await tweenPinch('right', { value: 0 }, 0.2);
    await tweenPinch('right', { at: [at[0] + 0.05, 0.12, at[2] + 0.12] }, 0.6);
    hide('right');
    await wait(1.2);
    caption('Strum its fingers like a kalimba.', 3.6);
    const cast = await ev(() => window.handcast.castPose(0));
    const J = (j) => [cast.pos[j * 3] / 1000, cast.pos[j * 3 + 1] / 1000, cast.pos[j * 3 + 2] / 1000];
    // Middle, ring and pinky: knuckle -> tip segments; strum across their midpoints.
    const segs = [[11, 14], [16, 19], [21, 24]].map(([k, t]) => [J(k), J(t)]);
    const midZ = segs.reduce((a, [k, t]) => a + (k[2] + t[2]) / 2, 0) / segs.length;
    const tipY = segs.reduce((a, [k, t]) => a + (k[1] + t[1]) / 2, 0) / segs.length;
    const xHi = Math.max(...segs.map(([k, t]) => Math.max(k[0], t[0]))) + 0.03;
    const xLo = Math.min(...segs.map(([k, t]) => Math.min(k[0], t[0]))) - 0.012;
    // A right 'point' hand from the right side: its index tip (12.5 cm ahead of the
    // palm, 2.1 cm toward the thumb) sweeps across the glass fingers.
    const strum = { curl: [1, 0, 1, 1, 1], spread: 0, lift: tipY + 0.008, yaw: Math.PI, pitch: 0 };
    const palm = (x) => [x + 0.125, midZ - 0.021];
    state.right = { mode: 'fk', p: full({ ...strum, at: [xHi + 0.2, midZ + 0.05], lift: 0.12 }) };
    await tweenHand('right', { ...strum, at: palm(xHi) }, 0.8);
    await tweenHand('right', { ...strum, at: palm(xLo) }, 0.4);
    await tweenHand('right', { ...strum, at: palm(xHi) }, 0.45);
    await tweenHand('right', { ...strum, at: palm(xLo) }, 0.35);
    await tweenHand('right', { ...strum, at: palm(xHi + 0.02) }, 0.4);
    await withdraw('right', 0.7);
    caption('Knock it over with a fist to get the glass back.', 4);
    const f = await ev(() => window.handcast.castFoot(0));
    const fist = { curl: [1, 1, 1, 1, 1], lift: 0.065, yaw: Math.PI, pitch: 0 };
    state.right = { mode: 'fk', p: full({ ...fist, at: [f[0] + 0.2, f[1] + 0.05], lift: 0.12 }) };
    await tweenHand('right', { ...fist, at: [f[0] + 0.16, f[1]] }, 0.8);
    await wait(0.2);
    await tweenHand('right', { ...fist, at: [f[0] + 0.01, f[1]] }, 0.14);
    await tweenHand('right', { ...fist, at: [f[0] + 0.05, f[1] + 0.05], lift: 0.1 }, 0.5);
    await withdraw('right', 0.7);
    await wait(1.4);
  },
  // 5. Relay "Creation": two hands, index fingertips almost touching.
  async () => {
    const [a, b] = await load('relay-8');
    await wait(0.6);
    caption('Glass hands pass light to each other.', 4);
    await castHand(a, { approach: 1.5, settle: 2.2 });
    caption('Creation: two hands, fingertips almost touching.', 4.5);
    await castHand(b, { approach: 1.5, settle: 2.2 });
    await wait(1.8);
  },
  // 6. Colour: three pools mix into white.
  async () => {
    const [p] = await load('colour-5');
    await wait(0.6);
    caption('Light mixes inside your hand: red, green and blue make white.', 5.5);
    await castHand(p, { approach: 1.6 });
    await wait(1.6);
  },
  // 7. Finale: both hands at once, eight crystals.
  async () => {
    const [l, r] = await load('finale-4');
    await wait(0.6);
    caption('Count to Ten: both hands, one chord.', 5);
    state.left = { mode: 'fk', p: full(hover(l)) };
    state.right = { mode: 'fk', p: full(hover(r)) };
    await tweenBoth({ ...l, lift: 0.13 }, { ...r, lift: 0.13 }, 1.3);
    await tweenBoth(l, r, 0.8);
    await wait(2.6);
    const sl = state.left.p;
    const sr = state.right.p;
    await tweenBoth({ ...RELAXED, yaw: sl.yaw, at: [sl.at[0] - 0.05, sl.at[1] + 0.2], lift: 0.2 }, { ...RELAXED, yaw: sr.yaw, at: [sr.at[0] + 0.05, sr.at[1] + 0.2], lift: 0.2 }, 1.2);
    hide('left');
    hide('right');
    await wait(2.4);
  },
  // 8. Studio: make a puzzle by casting the solution.
  async () => {
    await ev(() => window.handcast.studio());
    await wait(0.6);
    caption('The Studio: make a puzzle in seconds.', 3.4);
    const peace = { hand: 'right', curl: [1, 0, 0, 1, 1], spread: 1, lift: 0.058, at: [0, 0.06], yaw: -Math.PI / 2 + 0.25 };
    caption('Cast your solution in the light...', 3.8);
    await castHand(peace, { approach: 1.4, settle: 2.2, out: 1.0 });
    caption('...and the Studio drops crystals where it shines, and hush stones where a lazy hand would spill.', 5.2);
    await ev(() => window.handcast.studioDrop());
    await wait(2.4);
    caption('Pinch the bench to add lamps, pools, walls and mirrors.', 4.4);
    await ev(() => window.handcast.studioTool('wall'));
    const a = [0.13, 0.012, -0.1];
    const b = [0.19, 0.012, -0.03];
    await tweenPinch('right', { at: [a[0] + 0.03, 0.1, a[2] + 0.1], value: 0, yaw: 0 }, 0.01);
    await tweenPinch('right', { at: a }, 0.8);
    await tweenPinch('right', { value: 1 }, 0.2);
    await tweenPinch('right', { at: b }, 0.8);
    await tweenPinch('right', { value: 0 }, 0.2);
    await tweenPinch('right', { at: [b[0], 0.12, b[2] + 0.1] }, 0.5);
    hide('right');
    await wait(0.4);
    caption('Publish it to the Hall of Hands.', 3.6);
    let msg = await ev(() => window.handcast.studioPublish());
    if (/tap Publish again/.test(msg)) msg = await ev(() => window.handcast.studioPublish());
    console.log('publish:', msg);
    await lookAt(await ev(() => window.handcast.hud()), 0.9);
    await wait(2.4);
    await tweenHead({ pitch: HEAD.pitch, yaw: HEAD.yaw }, 0.8);
    await ev(() => window.handcast.studioExit());
  },
  // 9. Hall of Hands: play a stranger's board, then see their hands.
  async () => {
    await ev(() => window.handcast.hall('featured'));
    await lookAt(await ev(() => window.handcast.hud()), 0.8);
    caption('The Hall of Hands: boards made by players, shared by link.', 4.4);
    await wait(1.8);
    await ev(() => window.handcast.hall('new'));
    await wait(1.0);
    await ev(() => window.handcast.hallPick(0));
    await tweenHead({ pitch: HEAD.pitch, yaw: HEAD.yaw }, 0.8);
    caption('Solve it, then the maker\'s glass hand appears beside yours.', 5);
    const peace = { hand: 'right', curl: [1, 0, 0, 1, 1], spread: 1, lift: 0.058, at: [0.012, 0.075], yaw: -Math.PI / 2 + 0.12 };
    await castHand(peace, { approach: 1.4, settle: 2.0, out: 1.0 });
    await wait(2.6);
    const s = await st();
    console.log('hall:', s.status);
  },
  // 10. Content.
  async () => {
    await ev(() => window.handcast.menu(true));
    await lookAt(await ev(() => window.handcast.hud()), 0.9);
    caption('49 boards in seven chapters, a Daily, and endless boards from the Kiln.', 5);
    await wait(4.2);
    await ev(() => window.handcast.menu(false));
    await tweenHead({ pitch: HEAD.pitch, yaw: HEAD.yaw }, 0.8);
  },
];

for (const [i, scene] of scenes.entries()) {
  if (ONLY && !ONLY.includes(i)) continue;
  Object.assign(state.head, { ...HEAD, pos: [...HEAD.pos] });
  hide('left');
  hide('right');
  await scene();
  const s = await st();
  const sounds = await ev(() => window.handcast.audioEvents());
  const plucks = sounds.filter((n) => n === 'voice:pluck').length;
  console.log(`scene ${i}: ${s.level} index=${s.index} solved=${s.solved} casts=${s.casts} plucks(total)=${plucks} status="${s.status}"`);
}

writeFileSync(`${OUT}/captions.json`, JSON.stringify({ fps: FPS, seconds: seconds(), captions }, null, 1));
const wav = await ev(([t0, s]) => window.handcast.audioRender(t0, s + 1), [AUDIO_T0, seconds()]);
writeFileSync(`${OUT}/audio.wav`, Buffer.from(wav, 'base64'));
console.log(`done: ${frame} frames, ${seconds().toFixed(1)}s, wall ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (logs.length) console.log('page errors:\n' + logs.slice(0, 10).join('\n'));
await browser.close();
