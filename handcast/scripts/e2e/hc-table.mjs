// HANDCAST table set-up against the headset's own view of the room (IWER's
// synthetic living room has a 1.3 x 0.75 m table at y = 0.79 m, centred on
// x = -1.54, z = 0.2). Run: node scripts/e2e/run-local.mjs scripts/e2e/hc-table.mjs
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const out = [];
  const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  await app.waitForFunction(() => window.handcast !== undefined && window.handcast.xrActive());
  const hc = (fn, arg) => app.evaluate(fn, arg);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await hc(fn, arg)) return true;
      await wait(200);
    }
    return false;
  };
  const TABLE_Y = 0.79;

  // Seated at the table, looking down at it. Both IWER hands curled away (a
  // parked IWER hand stays tracked flat and would "find" a table where it hangs).
  await hc(() => window.handcast.setHead([-1.54, 1.25, 0.78], -45, 0));
  await wait(400);
  await hc((y) => window.handcast.placeInFront(y), TABLE_Y);
  await wait(400);
  await hc(() => {
    window.handcast.iwerHand('left', 'fist', [-0.6, 0.4]);
    window.handcast.iwerHand('right', 'fist', [0.6, 0.4]);
  });

  // 1. The headset sees the table before the hand confirms it; the ghost hand sits on it.
  await hc(() => window.handcast.calibrate());
  const seen = await waitFor(() => !!window.handcast.state().tableSeen, 9000);
  let st = await hc(() => window.handcast.state());
  const t = st.tableSeen;
  check('set-up sees the real table (planes / hit-test)', seen && Math.abs(t.y - TABLE_Y) < 0.02, JSON.stringify(t) + ' ' + JSON.stringify(st.tableDiag));
  check('the ghost hand rests on that table', !!st.ghostAt && t && Math.abs(st.ghostAt[1] - t.y) < 0.035, JSON.stringify(st.ghostAt));

  // 2. A flat hand on the table: the bench height comes from the detected plane.
  await hc((yaw) => window.handcast.iwerHand('right', 'flat', [0, 0.06], yaw), -Math.PI / 2);
  await waitFor(() => window.handcast.state().placed && !window.handcast.state().calibrating, 15000);
  await hc(() => window.handcast.iwerHand('right', 'fist', [0.6, 0.4]));
  const benchY = (await hc(() => window.handcast.benchToWorld([0, 0, 0])))[1];
  check('a resting hand places the bench flush with the detected table', Math.abs(benchY - TABLE_Y) < 0.006, `bench y=${benchY.toFixed(4)}`);

  // 3. No hand at all: after a few seconds the bench pours onto the table the headset sees.
  await wait(1500);
  await hc(() => window.handcast.calibrate());
  const auto = await waitFor(() => window.handcast.state().placed && !window.handcast.state().calibrating, 60000);
  const b = await hc(() => window.handcast.benchToWorld([0, 0, 0]));
  st = await hc(() => window.handcast.state());
  check('no hand: the bench pours onto the detected table', auto && Math.abs(b[1] - TABLE_Y) < 0.006 && st.pouring !== undefined, `bench=${b.map((v) => v.toFixed(3))}`);
  await hc(() => {
    window.handcast.iwerHand('left', null);
    window.handcast.iwerHand('right', null);
  });
  return out.join('\n');
}
