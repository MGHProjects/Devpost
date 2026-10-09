// Launch a private Chromium on the dev server with the IWER emulator active.
import { chromium } from 'playwright';

export async function openApp({ width = 1280, height = 720, url = 'https://localhost:8081/' } = {}) {
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width, height }, ignoreHTTPSErrors: true });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.prismSong !== undefined && window.IWER_DEVICE !== undefined, null, { timeout: 60000 });
  return { browser, page, logs };
}
