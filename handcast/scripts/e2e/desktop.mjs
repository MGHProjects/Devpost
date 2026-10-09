// Desktop (non-XR) smoke test: real mouse clicks through the pointer system.
// Run: npx @iwsdk/cli browser run scripts/e2e/desktop.mjs
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function run({ page, frame }) {
  const out = [];
  const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  const app = frame ?? page;
  // The app may live in an iframe inside the managed workspace page.
  let ox = 0;
  let oy = 0;
  if (frame && frame !== page.mainFrame()) {
    const box = await (await frame.frameElement()).boundingBox();
    ox = box.x;
    oy = box.y;
  }
  const ps = (fn, arg) => app.evaluate(fn, arg);
  await app.waitForFunction(() => window.prismSong !== undefined);
  await ps(() => { localStorage.clear(); window.prismSong.load(0); });
  await wait(300);

  const clickPiece = async (id) => {
    const xy = await ps((id) => { const p = window.prismSong.pieceWorld(id); p[1] += 0.02; return window.prismSong.project(p); }, id);
    await page.mouse.click(xy[0] + ox, xy[1] + oy);
    await wait(120);
  };
  const clickCell = async (x, y) => {
    const xy = await ps(([x, y]) => window.prismSong.project(window.prismSong.cellWorld(x, y)), [x, y]);
    await page.mouse.click(xy[0] + ox, xy[1] + oy);
    await wait(120);
  };

  // Level 1: turn the locked mirror twice -> beam goes north into the crystal.
  let st = await ps(() => window.prismSong.state());
  check('L1 starts unsolved', !st.solved && st.pieces[1].rot === 0);
  await clickPiece(1);
  await clickPiece(1);
  st = await ps(() => window.prismSong.state());
  check('L1 mirror rot 2 after two clicks', st.pieces[1].rot === 2, `rot=${st.pieces[1].rot}`);
  check('L1 solved', st.solved);
  await page.screenshot({ path: 'artifacts/e2e-l1-solved.png' });

  // Level 2: pick the tray mirror, drop it on (3,1), turn it twice.
  await ps(() => window.prismSong.load(1));
  await wait(300);
  await clickPiece(2);
  st = await ps(() => window.prismSong.state());
  check('L2 tray piece selected', st.selected === 2, `selected=${st.selected}`);
  await clickCell(3, 1);
  st = await ps(() => window.prismSong.state());
  check('L2 placed at (3,1)', st.pieces[2].onBoard && st.pieces[2].x === 3 && st.pieces[2].y === 1,
    JSON.stringify(st.pieces[2]));
  await wait(400);
  await clickPiece(2);
  await clickPiece(2);
  st = await ps(() => window.prismSong.state());
  check('L2 solved', st.solved, `rot=${st.pieces[2].rot}`);

  // Occupied cell is rejected.
  await ps(() => window.prismSong.load(2));
  await wait(300);
  await clickPiece(4);
  await clickCell(3, 2); // a wall
  st = await ps(() => window.prismSong.state());
  check('L3 cannot place on wall', !st.pieces[4].onBoard);
  await page.screenshot({ path: 'artifacts/e2e-l3.png' });
  return out.join('\n');
}
