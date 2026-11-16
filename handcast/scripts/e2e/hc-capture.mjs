// Capture mode for filming on a headset. Needs the URL parameters:
//   HC_URL='https://localhost:8081/?capture&tour=6' node scripts/e2e/run-local.mjs scripts/e2e/hc-capture.mjs
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const out = [];
  const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  const hc = (fn, arg) => app.evaluate(fn, arg);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await hc(() => {
    window.handcast.setHead([0, 1.2, 0], 0, 0);
    window.handcast.iwerHand('left', null);
    window.handcast.iwerHand('right', null);
  });
  await wait(400);
  await hc(() => window.handcast.placeInFront(0.75));
  await wait(400);
  const st = await hc(() => window.handcast.state());
  check('capture: tour=6 opens Count to Ten', st.level === 'finale-4', st.level);
  // Looking at the bench hides the panel (software GL runs game time slowly: wait).
  await hc(() => window.handcast.setHead([0, 1.06, -0.13], -46, 0));
  await wait(5000);
  const atBench = (await hc(() => window.handcast.hudVisible())).vis;
  const hp = await hc(() => window.handcast.hud());
  const pitch = (Math.atan2(hp[1] - 1.06, Math.hypot(hp[0], hp[2] + 0.13)) * 180) / Math.PI;
  await hc((p) => window.handcast.setHead([0, 1.06, -0.13], p, 0), pitch);
  await wait(1500);
  const atPanel = (await hc(() => window.handcast.hudVisible())).vis;
  check('capture: the panel hides while you look at the bench and shows when you look at it', !atBench && atPanel, `bench=${atBench} panel=${atPanel}`);
  await hc(() => window.handcast.setHead([0, 1.06, -0.13], -46, 0));
  await hc(() => window.handcast.iwerSolution(0));
  await wait(5000);
  await hc(() => window.handcast.exitXR());
  const offered = await app
    .waitForFunction(() => !!document.getElementById('hc-capture-audio'), null, { timeout: 60000 })
    .then(() => true, () => false);
  check('capture: leaving XR offers the game audio as a WAV', offered);
  return out.join('\n');
}
