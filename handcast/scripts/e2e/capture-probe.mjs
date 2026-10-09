import { installHelpers } from './iwer.mjs';
export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => window.prismSong !== undefined && window.IWER_DEVICE !== undefined);
  const before = page.viewportSize();
  try { await page.setViewportSize({ width: 1280, height: 720 }); } catch (e) { return 'viewport fail ' + e.message; }
  await installHelpers(app);
  const box = frame && frame !== page.mainFrame() ? await (await frame.frameElement()).boundingBox() : { x: 0, y: 0, width: 1280, height: 720 };
  await app.evaluate(() => { window.__prismClock = { time: 1000, dt: 0 }; });
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    await app.evaluate(() => { window.__prismClock.time += 1 / 30; window.__prismClock.dt = 1 / 30; return window.__t.frames(2); });
    await page.screenshot({ path: `artifacts/probe-${i}.png`, clip: box });
  }
  const ms = (Date.now() - t0) / 20;
  return JSON.stringify({ before, box, msPerFrame: ms });
}
