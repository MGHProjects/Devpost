// HANDCAST XR end-to-end (managed browser, emulated Quest 3 hands).
// Prereq: npx @iwsdk/cli xr enter --input-json '{}'
const FWD = -Math.PI / 2;

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
      await wait(150);
    }
    return false;
  };

  await hc(() => {
    window.handcast.setHead([0, 1.2, 0], 0, 0);
    window.handcast.iwerHand('left', null);
    window.handcast.iwerHand('right', null);
  });
  await wait(400);
  await hc(() => window.handcast.placeInFront(0.75));
  await hc(() => window.handcast.setHead([0, 1.2, 0], -40, 0));
  await hc(() => window.handcast.load(0));
  await wait(300);
  let st = await hc(() => window.handcast.state());
  check('board loaded in play mode', st.mode === 'play' && st.level === 'prologue-1' && st.placed, JSON.stringify({ mode: st.mode, level: st.level, placed: st.placed }));

  // 1. Open hand resting in the light -> live optic, then glass.
  const sol0 = await hc(() => window.handcast.solutionFoot(0));
  await hc(() => window.handcast.iwerSolution(0));
  const lit = await waitFor(() => {
    const s = window.handcast.state();
    return s.live[1].mode === 'fan' && s.crystals.filter((c) => c === 'lit').length >= 3;
  });
  st = await hc(() => window.handcast.state());
  check('live hand is a fan optic lighting crystals', lit, JSON.stringify(st.live[1]) + ' ' + st.crystals);
  const cast = await waitFor(() => window.handcast.state().casts === 1, 9000);
  st = await hc(() => window.handcast.state());
  check('holding still casts a glass hand', cast, `casts=${st.casts} progress=${st.live[1].progress.toFixed(2)} still=${st.live[1].still}`);
  const solved = await waitFor(() => window.handcast.state().solved, 3000);
  check('glass hand solves the board', solved, st.crystals.join(','));

  // 2. Withdraw: board stays solved with only glass.
  await hc(() => window.handcast.iwerHand('right', null));
  await wait(800);
  st = await hc(() => window.handcast.state());
  check('withdrawn hand: still solved by glass alone', st.solved && st.casts === 1, st.crystals.join(','));

  // 3. Pinch the foot and slide the glass hand 4 cm right.
  const foot0 = await hc(() => window.handcast.castPose(0).pos.slice(0, 3));
  const [fx, fz] = sol0.at;
  await hc(([x, z]) => window.handcast.iwerPinchAt('right', [x, 0.012, z], 0), [fx, fz]);
  await wait(400);
  await hc(([x, z]) => window.handcast.iwerPinchAt('right', [x, 0.012, z], 1), [fx, fz]);
  await wait(500);
  st = await hc(() => window.handcast.state());
  const grabbed = st.live[1].grab;
  for (let k = 1; k <= 4; k++) {
    await hc(([x, z]) => window.handcast.iwerPinchAt('right', [x, 0.012, z], 1), [fx + k * 0.01, fz]);
    await wait(200);
  }
  await hc(([x, z]) => window.handcast.iwerPinchAt('right', [x, 0.012, z], 0), [fx + 0.04, fz]);
  await wait(500);
  const foot1 = await hc(() => window.handcast.castPose(0).pos.slice(0, 3));
  check('pinch-grab slides the glass hand', grabbed && foot1[0] - foot0[0] > 25, `grabbed=${grabbed} wrist x ${foot0[0]} -> ${foot1[0]} mm`);
  await hc(() => window.handcast.iwerHand('right', null));
  await wait(300);

  // 4. Fist knock shatters it (refund).
  await hc(([x, z]) => window.handcast.iwerHand('right', 'fist', [x, z], -Math.PI / 2), [fx + 0.16, fz]);
  await wait(500);
  for (const dx of [0.12, 0.08, 0.04]) {
    await hc(([x, z]) => window.handcast.iwerHand('right', 'fist', [x, z], -Math.PI / 2), [fx + dx, fz]);
    await wait(60);
  }
  await wait(500);
  st = await hc(() => window.handcast.state());
  check('fist knock shatters the glass hand', st.casts === 0, `casts=${st.casts}`);
  await hc(() => window.handcast.iwerHand('right', null));

  // 5. Board 2 ("One"): an open hand wakes a hush stone and does not cast; the point solves it.
  await hc(() => window.handcast.load(1));
  await wait(300);
  const sol1 = await hc(() => window.handcast.solutionFoot(0));
  const lvl = (await hc(() => window.handcast.state())).level;
  await hc(([at, yaw]) => window.handcast.iwerHand('right', 'spread', at, yaw), [sol1.at, sol1.yaw]);
  await waitFor(() => window.handcast.state().live[1].mode === 'fan', 3000);
  await wait(400);
  st = await hc(() => window.handcast.state());
  check('wrong shape wakes a hush stone and does not cast', st.hush.some((h) => h) && st.casts === 0, `hush=${st.hush} casts=${st.casts} lvl=${lvl}`);
  await hc(() => window.handcast.iwerSolution(0));
  const pointCast = await waitFor(() => window.handcast.state().solved, 9000);
  st = await hc(() => window.handcast.state());
  check('point shape solves board 2', pointCast, `crystals=${st.crystals} hush=${st.hush} casts=${st.casts}`);
  await hc(() => window.handcast.iwerHand('right', null));
  return out.join('\n');
}
