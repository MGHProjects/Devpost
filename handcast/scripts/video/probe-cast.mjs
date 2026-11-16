// Diagnostic: hold a board's FK solution pose still in the emulator and compare
// the glass that sets with the reference solution. Usage: node probe-cast.mjs <levelId>
import { openApp } from './browser.mjs';

const id = process.argv[2] ?? 'prologue-2';
const { browser, page, logs } = await openApp();
const ev = (fn, arg) => page.evaluate(fn, arg);
await ev(() => { window.__hcClock = { time: 0, dt: 0 }; });
await ev(() => window.handcast.enterXR());
await page.waitForFunction(() => window.handcast.xrActive());
const adv = async (sec, fn) => {
  for (let i = 0; i < Math.round(sec * 24); i++) {
    await ev(async (dt) => {
      window.__hcClock.time += dt;
      window.__hcClock.dt = dt;
      await new Promise((r) => requestAnimationFrame(() => r()));
    }, 1 / 24);
    if (fn) await fn(i);
  }
};
await ev(() => { window.handcast.setHead([0, 1.2, 0], 0, 0); window.handcast.iwerHand('left', null); window.handcast.iwerHand('right', null); });
await adv(0.3);
await ev(() => window.handcast.placeInFront(0.75));
await ev(() => window.handcast.setHead([0, 1.06, -0.13], -46, 0));
const levels = await ev(() => window.handcast.levels());
await ev((i) => window.handcast.load(i), levels.indexOf(id));
const params = await ev(() => window.handcast.solutionParams());
const sol = await ev(() => window.handcast.solution());
for (const p of params) await ev((p) => window.handcast.iwerHandParams(p), p);
await adv(3, async () => { for (const p of params) await ev((p) => window.handcast.iwerHandParams(p), p); });
const st = await ev(() => window.handcast.state());
console.log(JSON.stringify({ solved: st.solved, casts: st.casts, crystals: st.crystals, hush: st.hush, status: st.status }));
for (let i = 0; i < st.casts; i++) {
  const c = await ev((i) => window.handcast.castPose(i), i);
  const s = sol[i];
  let max = 0, sum = 0;
  for (let j = 0; j < 25; j++) {
    const d = Math.hypot(c.pos[j * 3] - s.pos[j * 3], c.pos[j * 3 + 1] - s.pos[j * 3 + 1], c.pos[j * 3 + 2] - s.pos[j * 3 + 2]);
    max = Math.max(max, d); sum += d;
  }
  console.log(`cast ${i}: mean joint error ${(sum / 25).toFixed(1)} mm, max ${max.toFixed(1)} mm; wrist ${c.pos.slice(0, 3)} vs ${s.pos.slice(0, 3)}; index tip ${c.pos.slice(27, 30)} vs ${s.pos.slice(27, 30)}`);
}
if (logs.length) console.log(logs.slice(0, 5).join('\n'));
await browser.close();
