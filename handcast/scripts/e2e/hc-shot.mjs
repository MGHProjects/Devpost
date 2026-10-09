// Pose a scene in the emulator for a screenshot (SCENE env selects).
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const hc = (fn, arg) => app.evaluate(fn, arg);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await hc(() => {
    window.handcast.setHead([0, 1.15, 0.05], -48, 0);
    window.handcast.load(0);
    window.handcast.iwerHand('left', null);
  });
  await wait(300);
  await hc(() => window.handcast.cast('point', 'right', [0.1, 0.04], -Math.PI / 2 + 0.5));
  await hc(() => window.handcast.iwerHand('right', 'spread', [0, 0.06], -Math.PI / 2));
  await wait(1200);
  return JSON.stringify(await hc(() => window.handcast.state()));
}
