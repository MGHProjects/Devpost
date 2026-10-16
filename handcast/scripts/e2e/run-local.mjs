// Runs an e2e scenario (scripts/e2e/hc-*.mjs) in a private headless Chromium
// instead of the CLI-managed browser: opens the dev server, enters XR in the
// IWER emulator and calls the scenario's default export with { page }.
// Usage: node scripts/e2e/run-local.mjs scripts/e2e/hc-xr.mjs [more.mjs ...]
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openApp } from '../video/browser.mjs';

const { browser, page, logs } = await openApp();
await page.evaluate(() => localStorage.clear());
await page.evaluate(() => window.handcast.enterXR());
await page.waitForFunction(() => window.handcast.xrActive(), null, { timeout: 30000 });
let failed = 0;
for (const file of process.argv.slice(2)) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  const out = await mod.default({ page });
  console.log(`# ${file}\n${out}`);
  failed += (String(out).match(/^FAIL/gm) ?? []).length;
}
if (logs.length) console.log('page errors:\n' + logs.slice(0, 10).join('\n'));
await browser.close();
process.exit(failed ? 1 : 0);
