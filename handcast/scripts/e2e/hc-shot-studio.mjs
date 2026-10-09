// Pose the Studio in the emulator for a screenshot: a glass hand, dropped
// crystals, the Lamp tool active and a lamp being aimed (pinch held).
export default async function run({ page, frame }) {
  const app = frame ?? page;
  const hc = (fn, arg) => app.evaluate(fn, arg);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await app.waitForFunction(() => window.handcast !== undefined && window.handcast.xrActive());
  await hc(() => {
    window.handcast.setHead([0, 1.2, 0], 0, 0);
    window.handcast.iwerHand('left', null);
    window.handcast.iwerHand('right', null);
  });
  await wait(300);
  await hc(() => window.handcast.placeInFront(0.75));
  await hc(() => {
    window.handcast.setHead([0.0, 1.07, -0.08], -40, 0);
    window.handcast.studio();
    window.handcast.cast('three', 'right', [0, 0.06], -Math.PI / 2 + 0.2);
    window.handcast.studioDrop();
    window.handcast.studioPinch([-0.17, -0.1], [-0.06, -0.06]);
    window.handcast.studioTool('lamp');
  });
  await wait(300);
  await hc(() => window.handcast.iwerPinchAt('right', [0.16, 0.012, -0.11], 0));
  await wait(300);
  await hc(() => window.handcast.iwerPinchAt('right', [0.16, 0.012, -0.11], 1));
  await wait(300);
  await hc(() => window.handcast.iwerPinchAt('right', [0.08, 0.012, -0.04], 1));
  await wait(600);
  return JSON.stringify(await hc(() => window.handcast.state()));
}
