// Every campaign board, cast through the real tracking path: the emulated
// hand takes the shape of each reference solution cast in turn, holds still
// until the glass sets, withdraws, and the board must end up solved.
// Long-running: use scripts/e2e/run-local.mjs (no managed-browser time cap).
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const out = [];
  const hc = (fn, arg) => app.evaluate(fn, arg);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms, arg) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await hc(fn, arg)) return true;
      await wait(120);
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
  await hc(() => window.handcast.setHead([0, 1.06, -0.13], -46, 0));
  const levels = await hc(() => window.handcast.levels());
  let passed = 0;
  const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (let i = 0; i < levels.length; i++) {
    if (only && !only.includes(levels[i])) continue;
    await hc((i) => window.handcast.load(i), i);
    await wait(250);
    const n = (await hc(() => window.handcast.solution()))?.length ?? 0;
    let ok = n > 0;
    let note = '';
    for (let c = 0; c < n && ok; c++) {
      await hc((c) => window.handcast.iwerSolution(c), c);
      const set = await waitFor((k) => window.handcast.state().casts >= k, 15000, c + 1); // slow software rendering: game dt is clamped per frame
      if (!set) {
        const st = await hc(() => window.handcast.state());
        const l = st.live.find((h) => h.mode) ?? st.live[1];
        note = `cast ${c + 1}/${n} never set (mode=${l.mode} progress=${l.progress.toFixed(2)} still=${l.still} crystals=${st.crystals})`;
        ok = false;
      }
      await hc(() => {
        window.handcast.iwerHand('left', null);
        window.handcast.iwerHand('right', null);
      });
      await wait(450);
    }
    if (ok) {
      ok = await waitFor(() => window.handcast.state().solved, 2500);
      if (!ok) {
        const st = await hc(() => window.handcast.state());
        note = `not solved: crystals=${st.crystals} hush=${st.hush} casts=${st.casts}/${st.budget}`;
      }
    }
    if (ok) passed++;
    out.push(`${ok ? 'PASS' : 'FAIL'} ${levels[i]} ${note}`);
  }
  out.push(`${passed}/${only ? only.length : levels.length} boards solved by casting their reference hands`);
  return out.join('\n');
}
