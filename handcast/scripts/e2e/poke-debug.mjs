import { PINCH_OFFSET, installHelpers } from './iwer.mjs';
export default async function run({ page, frame }) {
  const app = frame ?? page;
  await installHelpers(app);
  const ev = (fn, arg) => app.evaluate(fn, arg);
  await ev(() => { window.__t.pinch(0); window.__t.handAt([0.3, 1.3, -0.3]); window.prismSong.load(5); });
  await ev(() => window.__t.frames(4));
  const tipTarget = await ev((po) => {
    const h = window.prismSong.hands()[1];
    const hp = window.IWER_DEVICE.hands.right.position;
    const tip = [h.indexTip[0] - hp.x - po[0], h.indexTip[1] - hp.y - po[1], h.indexTip[2] - hp.z - po[2]];
    const c = window.prismSong.grabPoint(3);
    return { tip, c, t: [c[0] - tip[0], c[1] + 0.012 - tip[1], c[2] - tip[2]], h };
  }, PINCH_OFFSET);
  const rows = [JSON.stringify(tipTarget)];
  for (const k of [1, 0.66, 0.33, 0, 0, 1]) {
    await ev(([p, k]) => window.__t.handAt([p[0], p[1] + 0.06 * k, p[2] + 0.03 * k]), [tipTarget.t, k]);
    await ev(() => window.__t.frames(4));
    rows.push(JSON.stringify(await ev(() => ({ tip: window.prismSong.hands()[1].indexTip, st: window.prismSong.state().status }))));
  }
  return rows.join('\n');
}
