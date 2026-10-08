// XR hand-tracking test (requires an active emulated session: `iwsdk xr enter`).
import { installHelpers } from './iwer.mjs';

export default async function run({ page, frame }) {
  const app = frame ?? page;
  const out = [];
  const check = (name, ok, extra = '') => out.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  await app.waitForFunction(() => window.prismSong !== undefined && window.IWER_DEVICE !== undefined);
  await installHelpers(app);
  const ev = (fn, arg) => app.evaluate(fn, arg);
  const settle = () => ev(() => window.__t.frames(4));

  // Level 2: pinch the tray mirror, carry it to (3,1), twist, release.
  await ev(() => { window.__t.pinch(0); window.__t.handAt([0.3, 1.3, -0.3]); window.prismSong.load(1); });
  await settle();
  await ev(() => window.__t.handAt(window.prismSong.grabPoint(2)));
  await settle();
  await ev(() => window.__t.pinch(1));
  await settle();
  let h = await ev(() => window.prismSong.hands()[1]);
  check('pinch grabs tray mirror', h.grab === 2, JSON.stringify(h));
  await ev(() => { const c = window.prismSong.cellWorld(3, 1); c[1] += 0.03; window.__t.handAt(c); });
  await settle();
  let p = await ev(() => window.prismSong.state().pieces[2]);
  check('live preview on (3,1)', p.onBoard && p.x === 3 && p.y === 1, JSON.stringify(p));
  await ev(() => { const c = window.prismSong.cellWorld(3, 1); c[1] += 0.03; window.__t.handAt(c, 30); });
  await settle();
  p = await ev(() => window.prismSong.state().pieces[2]);
  check('wrist twist turns mirror to rot 2', p.rot === 2, `rot=${p.rot}`);
  await ev(() => window.__t.pinch(0));
  await settle();
  let st = await ev(() => window.prismSong.state());
  check('release places and solves', st.solved && st.pieces[2].onBoard);

  // Level 1: twist the brass (rotate-locked) mirror in place.
  await ev(() => { window.__t.handAt([0.3, 1.3, -0.3]); window.prismSong.load(0); });
  await settle();
  await ev(() => window.__t.handAt(window.prismSong.grabPoint(1)));
  await settle();
  await ev(() => window.__t.pinch(1));
  await settle();
  await ev(() => window.__t.handAt(window.prismSong.grabPoint(1), 30));
  await settle();
  await ev(() => window.__t.pinch(0));
  await settle();
  st = await ev(() => window.prismSong.state());
  check('locked mirror twisted, stays on cell', st.pieces[1].rot === 2 && st.pieces[1].x === 2 && st.solved,
    JSON.stringify(st.pieces[1]));

  // Drop outside the board returns the piece to the tray.
  await ev(() => { window.__t.handAt([0.3, 1.3, -0.3]); window.prismSong.load(1); });
  await settle();
  await ev(() => window.__t.handAt(window.prismSong.grabPoint(2)));
  await settle();
  await ev(() => window.__t.pinch(1));
  await settle();
  await ev(() => window.__t.handAt([0.5, 1.4, -0.2]));
  await settle();
  await ev(() => window.__t.pinch(0));
  await settle();
  st = await ev(() => window.prismSong.state());
  check('drop off-board returns to tray', !st.pieces[2].onBoard);

  // Board handle: pinch and carry the table 12 cm to the right.
  const before = await ev(() => window.prismSong.boardRoot().position.toArray());
  const handle = await ev(() => {
    const o = window.prismSong.boardRoot().getObjectByName('board-handle');
    const v = o.getWorldPosition(o.position.clone());
    return v.toArray();
  });
  await ev((p) => window.__t.handAt(p), handle);
  await settle();
  await ev(() => window.__t.pinch(1));
  await settle();
  await ev((p) => window.__t.handAt([p[0] + 0.12, p[1], p[2]]), handle);
  await settle();
  await ev(() => window.__t.pinch(0));
  await settle();
  const after = await ev(() => window.prismSong.boardRoot().position.toArray());
  check('handle moves the board', Math.abs(after[0] - before[0] - 0.12) < 0.03, `${before[0].toFixed(3)} -> ${after[0].toFixed(3)}`);
  await ev(() => window.__t.handAt([0.3, 1.3, -0.3]));
  return out.join('\n');
}
