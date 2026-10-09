/**
 * Captures harness screenshots with Playwright (swiftshader GL).
 * Usage: node dev/glass-demo/shoot.mjs <outDir> <view>@<t> ...
 */
import { chromium } from 'playwright';
const [,, outDir, ...views] = process.argv;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text().slice(0, 400)); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
for (const v of views) {
  const [name, t] = v.split('@');
  await page.goto(`http://localhost:5175/?view=${name}&t=${t ?? 2}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/glass-${name}${t ? '-' + t.replace('.', '_') : ''}.png` });
  console.log('shot', name, t);
}
await browser.close();
