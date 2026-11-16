// Renders an HTML file to PNG at an exact viewport (2x device scale).
// Usage: node render.mjs <in.html> <out.png> <width> <height> [transparent]
import { chromium } from 'playwright';

const [input, out, w, h, transparent] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
await page.goto(`file://${input}`, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, omitBackground: transparent === '1' });
await browser.close();
