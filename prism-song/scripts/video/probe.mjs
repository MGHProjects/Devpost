import { openApp } from './browser.mjs';
import { PINCH_OFFSET, installHelpers } from '../e2e/iwer.mjs';
const { browser, page, logs } = await openApp();
await page.evaluate(() => window.prismSong.enterXR());
await page.waitForFunction(() => window.prismSong.xrActive());
await installHelpers(page);
await page.evaluate(async () => { window.__t.headset([0, 1.2, 0], 0, 0); await window.__t.frames(8); window.prismSong.recenter(); window.prismSong.load(5); window.__t.handAt([0.3, 0.7, -0.2]); await window.__t.frames(3); });
console.log(await page.evaluate(() => window.prismSong.state().status), await page.evaluate(() => window.prismSong.ascii()));
const tip = await page.evaluate((po) => {
  const h = window.prismSong.hands()[1]; const hp = window.IWER_DEVICE.hands.right.position;
  return [h.indexTip[0] - hp.x - po[0], h.indexTip[1] - hp.y - po[1], h.indexTip[2] - hp.z - po[2]];
}, PINCH_OFFSET);
const c = await page.evaluate(() => window.prismSong.grabPoint(3));
const tgt = [c[0] - tip[0], c[1] + 0.012 - tip[1], c[2] - tip[2]];
for (const [dy, dz] of [[0.06, 0.03], [0.03, 0.015], [0, 0], [0, 0], [0.06, 0.03]]) {
  await page.evaluate(async (p) => { window.__t.handAt(p); await window.__t.frames(3); }, [tgt[0], tgt[1] + dy, tgt[2] + dz]);
  const h = await page.evaluate(() => window.prismSong.hands()[1]);
  console.log(dy, 'tip', h.indexTip.map((v) => v.toFixed(3)).join(','), 'crystal', c.map((v) => v.toFixed(3)).join(','), await page.evaluate(() => window.prismSong.state().status));
}
await page.evaluate(() => window.__t.frames(10));
console.log('final:', JSON.stringify(await page.evaluate(() => { const s = window.prismSong.state(); return { st: s.status }; })));
console.log(logs.slice(0, 5).join('\n'));
await browser.close();
