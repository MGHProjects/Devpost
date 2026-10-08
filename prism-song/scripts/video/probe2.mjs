import { openApp } from './browser.mjs';
import { installHelpers } from '../e2e/iwer.mjs';
const { browser, page } = await openApp();
await page.evaluate(() => window.prismSong.enterXR());
await page.waitForFunction(() => window.prismSong.xrActive());
await installHelpers(page);
const r = await page.evaluate(async () => {
  const d = window.IWER_DEVICE;
  window.__t.headset([0, 1.2, 0], -36, 0);
  await window.__t.frames(3);
  const pos = d.position; const q = d.quaternion;
  return { pos: [pos.x, pos.y, pos.z], q: [q.x, q.y, q.z, q.w], ctor: pos.constructor.name, mcp: Object.keys(window.IWER_MCP ?? {}).slice(0, 30), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(d)).slice(0, 60) };
});
console.log(JSON.stringify(r));
await browser.close();
