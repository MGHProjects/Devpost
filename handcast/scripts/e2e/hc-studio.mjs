// HANDCAST Studio + Hall end-to-end (managed browser, emulated Quest 3 hands).
// Prereq: npx @iwsdk/cli xr enter --input-json '{}'
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
  const pinch = async (a, b = a) => {
    await hc(([p]) => window.handcast.iwerPinchAt('right', [p[0], 0.012, p[1]], 0), [a]);
    await wait(300);
    await hc(([p]) => window.handcast.iwerPinchAt('right', [p[0], 0.012, p[1]], 1), [a]);
    await wait(350);
    for (let k = 1; k <= 4; k++) {
      const p = [a[0] + ((b[0] - a[0]) * k) / 4, a[1] + ((b[1] - a[1]) * k) / 4];
      await hc(([p]) => window.handcast.iwerPinchAt('right', [p[0], 0.012, p[1]], 1), [p]);
      await wait(120);
    }
    await hc(([p]) => window.handcast.iwerPinchAt('right', [p[0], 0.012, p[1]], 0), [b]);
    await wait(400);
  };

  await hc(() => {
    window.handcast.setHead([0, 1.2, 0], 0, 0);
    window.handcast.iwerHand('left', null);
    window.handcast.iwerHand('right', null);
  });
  await wait(400);
  await hc(() => window.handcast.placeInFront(0.75));
  await hc(() => window.handcast.setHead([0, 1.2, 0], -40, 0));
  await hc(() => window.handcast.studio());
  await wait(300);
  let st = await hc(() => window.handcast.state());
  check('studio opens', st.mode === 'studio' && st.section === 'studio', `mode=${st.mode} section=${st.section}`);

  // 1. Cast a peace hand in the starter pool.
  await hc(() => window.handcast.iwerHand('right', 'peace', [0, 0.06], -Math.PI / 2));
  const cast = await waitFor(() => window.handcast.state().casts === 1, 9000);
  check('studio: holding still in the pool casts a glass hand', cast, `casts=${(await hc(() => window.handcast.state())).casts}`);
  await hc(() => window.handcast.iwerHand('right', null));
  await wait(500);

  // 2. Drop crystals: targets on both beams, and the glass solves it.
  const dropMsg = await hc(() => window.handcast.studioDrop());
  await wait(400);
  let lvl = await hc(() => window.handcast.studioLevel());
  st = await hc(() => window.handcast.state());
  check('studio: drop crystals places targets the glass lights', lvl.crystals.length === 2 && st.solved, `${dropMsg} crystals=${lvl.crystals.length} solved=${st.solved}`);

  // 3. Real pinch gestures: hush stone with the Hush tool, wall drawn with the Wall tool.
  await hc(() => window.handcast.studioTool('hush'));
  const hush0 = lvl.hush.length;
  await pinch([0.17, -0.1]);
  lvl = await hc(() => window.handcast.studioLevel());
  check('studio: pinch places a hush stone', lvl.hush.length === hush0 + 1, `hush ${hush0} -> ${lvl.hush.length}`);
  await hc(() => window.handcast.studioTool('wall'));
  await pinch([-0.18, -0.12], [-0.1, -0.12]);
  lvl = await hc(() => window.handcast.studioLevel());
  check('studio: pinch-drag draws a wall', lvl.walls.length === 1, `walls=${lvl.walls.length}`);
  await hc(() => window.handcast.studioUndo());
  lvl = await hc(() => window.handcast.studioLevel());
  check('studio: undo removes the wall', lvl.walls.length === 0, `walls=${lvl.walls.length}`);
  await hc(() => window.handcast.studioTool('wall'));

  // 4. Publish (offline -> stored on this device + share link).
  let msg = await hc(() => window.handcast.studioPublish());
  if (/tap Publish again/.test(msg)) msg = await hc(() => window.handcast.studioPublish());
  const hash = await hc(() => window.location.hash);
  check('studio: publish succeeds with a share link', /Published/.test(msg) && hash.startsWith('#l='), `${msg} hash=${hash.slice(0, 20)}`);

  // 5. The Hall lists it; open it and solve it with the maker's hand.
  await hc(() => window.handcast.studioExit());
  await hc(() => window.handcast.hall('new'));
  await wait(300);
  const rows = await hc(() => window.handcast.hallRows());
  check('hall: new shelf lists the published board', rows.length >= 1, JSON.stringify(rows[0] ?? null));
  await hc(() => window.handcast.hallPick(0));
  await wait(500);
  st = await hc(() => window.handcast.state());
  check('hall: board opens in play', st.mode === 'play' && st.index === -3 && st.section === 'play', `mode=${st.mode} index=${st.index} section=${st.section}`);
  await hc(() => window.handcast.iwerSolution(0));
  const solved = await waitFor(() => window.handcast.state().solved, 9000);
  await wait(400);
  st = await hc(() => window.handcast.state());
  check('hall: solving reports your rank', solved && /First to solve|Solver #/.test(st.status), st.status);
  await hc(() => window.handcast.iwerHand('right', null));

  // 6. Featured shelf loads.
  await hc(() => window.handcast.hall('featured'));
  await wait(300);
  const feat = await hc(() => window.handcast.hallRows());
  check('hall: featured shelf', feat.length >= 3, `rows=${feat.length}`);
  await hc(() => window.handcast.menu(false));
  await hc(() => window.history.replaceState(null, '', window.location.pathname));
  return out.join('\n');
}
