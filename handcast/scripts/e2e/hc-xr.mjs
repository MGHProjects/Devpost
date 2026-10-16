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
  const after = (await hc(() => window.handcast.state())).status;
  check('a broken chord no longer reads as solved', !/Tap Next|sings|Campaign complete/.test(after), after);
  await hc(() => window.handcast.iwerHand('right', null));

  // 4b. The system menu pauses: a pour in progress drains, no glass is cast,
  // and closing it does not restart the table set-up.
  await hc(() => window.handcast.load(0));
  await wait(300);
  const solP = await hc(() => window.handcast.solutionFoot(0));
  await hc(([at, yaw]) => window.handcast.iwerHand('right', 'spread', at, yaw), [solP.at, solP.yaw]);
  await waitFor(() => window.handcast.state().live[1].progress > 0.2, 4000);
  const paused = await hc(() => window.handcast.systemMenu(true));
  await wait(1500);
  st = await hc(() => window.handcast.state());
  check('system menu pauses: the pour drains and nothing is cast', paused.paused && st.casts === 0 && st.live[1].progress === 0, `paused=${paused.paused} casts=${st.casts} progress=${st.live[1].progress}`);
  const resumed = await hc(() => window.handcast.systemMenu(false));
  await waitFor(() => window.handcast.state().casts === 1, 5000);
  st = await hc(() => window.handcast.state());
  check('closing the system menu resumes without a new set-up', !resumed.paused && !st.calibrating && st.placed && st.casts === 1, `calibrating=${st.calibrating} placed=${st.placed} casts=${st.casts}`);
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
  // Headless (software GL) runs game time at about a third of wall time: a cast takes 5-7 s here.
  const pointCast = await waitFor(() => window.handcast.state().solved, 15000);
  st = await hc(() => window.handcast.state());
  check('point shape solves board 2', pointCast, `crystals=${st.crystals} hush=${st.hush} casts=${st.casts}`);
  await hc(() => window.handcast.iwerHand('right', null));
  await wait(600);

  // 6. Mirror Palm: a blade hand (on its pinky edge) reflecting the lamp sets into glass.
  await hc(() => window.handcast.load(window.handcast.levels().indexOf('mirror-1')));
  await wait(300);
  await hc(() => window.handcast.iwerSolution(0));
  const blade = await waitFor(() => window.handcast.state().solved, 15000);
  st = await hc(() => window.handcast.state());
  check('blade hand casts a glass mirror that solves Mirror Palm 1', blade && st.casts === 1, `mode=${st.live[1].mode} crystals=${st.crystals} casts=${st.casts}`);
  await hc(() => window.handcast.iwerHand('right', null));

  // 6b. Wordless prologue: board 1 shows its verb with a ghost hand; Hint is
  // progressive (the light path, then the hand); a dead-end cast is knocked
  // over by a ghost fist and the glass comes back.
  await hc(() => window.handcast.load(0));
  const pre = await waitFor(() => window.handcast.state().ghosts > 0, 8000);
  check('prologue board 1 shows its gesture with a ghost hand', pre);
  await hc(() => window.handcast.load(2));
  await wait(300);
  const h1 = await hc(() => window.handcast.hint());
  const h2 = await hc(() => window.handcast.hint());
  check('Hint shows the light path first, the hand second', h1.stage === 1 && h1.beams && h1.ghosts === 0 && h2.stage === 2 && h2.ghosts > 0, `${JSON.stringify(h1)} ${JSON.stringify(h2)}`);
  await hc(() => window.handcast.load(0));
  await wait(300);
  await hc(() => window.handcast.iwerSolution(0, 0, 0, 180));
  const wrong = await waitFor(() => window.handcast.state().casts === 1, 15000);
  await hc(() => window.handcast.iwerHand('right', null));
  let sawKnock = false;
  const refunded = await waitFor(() => {
    const s = window.handcast.state();
    return s.knockDemo ? 'knock' : s.casts === 0 ? 'back' : '';
  }, 12000).then(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) {
      const s = await hc(() => window.handcast.state());
      if (s.knockDemo) sawKnock = true;
      if (s.casts === 0 && sawKnock) return true;
      await wait(150);
    }
    return false;
  });
  st = await hc(() => window.handcast.state());
  check('a dead-end prologue cast is knocked over by a ghost fist and refunded', wrong && refunded, `cast=${wrong} knock=${sawKnock} casts=${st.casts} status=${st.status}`);

  // 6c. The judge's tour: one tap from the Menu, its own count, Next follows it.
  const t0 = await hc(() => window.handcast.tour(0));
  const t1 = await hc(() => window.handcast.next());
  await hc(() => window.handcast.tour(5));
  const tEnd = await hc(() => window.handcast.next());
  check('the tour starts from the Menu and Next follows it', t0.level === 'fingers-3' && t0.eyebrow === 'TOUR - 1 / 6' && t1.level === 'mirror-1' && t1.eyebrow === 'TOUR - 2 / 6' && tEnd.level === 'finale-4' && !tEnd.hasNext, `${JSON.stringify(t0)} ${JSON.stringify(t1)} ${JSON.stringify(tEnd)}`);
  await hc(() => window.handcast.load(0));
  const left = await hc(() => window.handcast.state());
  check('picking a board leaves the tour', left.level === 'prologue-1', left.level);

  // 7. Table set-up: a ghost hand shows the gesture, the resting hand glows like a
  // cast, the bench pours out from under the palm, and that hand cannot cast until
  // it lifts off.
  await hc(() => window.handcast.load(0));
  await wait(300);
  // The parked left hand stays tracked (flat, palm down) in IWER: curl it into a
  // fist off the table so only the right hand can find the table.
  await hc(() => window.handcast.iwerHand('left', 'fist', [-0.35, 0.25]));
  await hc(() => window.handcast.calibrate());
  await wait(500);
  const ghost = (await hc(() => window.handcast.state())).calibGhost;
  await hc((yaw) => window.handcast.iwerHand('right', 'flat', [0, 0.06], yaw), FWD);
  const glow = await waitFor(() => {
    const s = window.handcast.state();
    return s.calibrating && s.live[1].progress > 0.25;
  }, 10000);
  const placedOk = await waitFor(() => window.handcast.state().placed && !window.handcast.state().calibrating, 12000);
  st = await hc(() => window.handcast.state());
  check('set-up: a ghost hand shows the gesture and the resting hand glows', ghost && glow, `ghost=${ghost} glow=${glow}`);
  check('set-up: the bench pours out from under the palm', placedOk && st.pouring, `placed=${st.placed} pouring=${st.pouring} ghostLeft=${st.calibGhost}`);
  await waitFor(() => !window.handcast.state().pouring, 20000);
  await wait(2500);
  st = await hc(() => window.handcast.state());
  check('the hand that found the table does not cast until it lifts off', st.casts === 0 && !st.pouring, `casts=${st.casts} progress=${st.live[1].progress}`);
  await hc(() => window.handcast.iwerHand('right', null));
  await hc(() => window.handcast.iwerHand('left', null));
  return out.join('\n');
}
