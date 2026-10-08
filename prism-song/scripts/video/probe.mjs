import { openApp } from './browser.mjs';
const { browser, page, logs } = await openApp();
await page.evaluate(() => window.prismSong.menu(true));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'artifacts/menu-desktop.png' });
console.log(logs.slice(0, 5).join('\n'));
await browser.close();
