// Shared helpers for driving the IWER emulated device from inside the page.
export const PINCH_OFFSET = [0.0005, -0.025, -0.012]; // pinched pinch-point vs right-hand transform

export function installHelpers(app) {
  return app.evaluate((off) => {
    const dev = window.IWER_DEVICE;
    const rot = (v, yaw) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
    };
    window.__t = {
      frames: (n = 1) => new Promise((res) => {
        let k = 0;
        const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
      // Place the right hand so its (pinched) pinch point lands on `p`.
      handAt(p, yawDeg = 0, hand = 'right') {
        const yaw = (yawDeg * Math.PI) / 180;
        const o = rot(hand === 'right' ? off : [-off[0], off[1], off[2]], yaw);
        const h = dev.hands[hand];
        h.position.set(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
        h.quaternion.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      },
      pinch(v, hand = 'right') {
        dev.hands[hand].setPinchValueImmediate(v);
      },
      headset(pos, pitchDeg = 0, yawDeg = 0) {
        dev.position.set(pos[0], pos[1], pos[2]);
        const p = (pitchDeg * Math.PI) / 180 / 2, y = (yawDeg * Math.PI) / 180 / 2;
        // yaw (Y) then pitch (X): q = qy * qx
        const qx = [Math.sin(p), 0, 0, Math.cos(p)], qy = [0, Math.sin(y), 0, Math.cos(y)];
        const q = [
          qy[3] * qx[0] + qy[0] * qx[3] + qy[1] * qx[2] - qy[2] * qx[1],
          qy[3] * qx[1] - qy[0] * qx[2] + qy[1] * qx[3] + qy[2] * qx[0],
          qy[3] * qx[2] + qy[0] * qx[1] - qy[1] * qx[0] + qy[2] * qx[3],
          qy[3] * qx[3] - qy[0] * qx[0] - qy[1] * qx[1] - qy[2] * qx[2],
        ];
        dev.quaternion.set(q[0], q[1], q[2], q[3]);
      },
    };
    dev.primaryInputMode = 'hand';
    return true;
  }, PINCH_OFFSET);
}
