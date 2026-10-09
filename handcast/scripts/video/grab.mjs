// In-page frame grab: composite the emulator's passthrough canvas and the app
// canvas into one JPEG right after they render (bypasses the slow compositor).
export function installGrabber(page, { brightness = 1 } = {}) {
  return page.evaluate((brightness) => {
    const canvases = [...document.querySelectorAll('canvas')];
    const z = (c) => Number(getComputedStyle(c).zIndex) || 0;
    const layers = canvases.filter((c) => z(c) === 1 || z(c) === 2).sort((a, b) => z(a) - z(b));
    const out = document.createElement('canvas');
    out.width = layers[0].width;
    out.height = layers[0].height;
    const g = out.getContext('2d');
    const probe = document.createElement('canvas');
    probe.width = 32;
    probe.height = 18;
    const pg = probe.getContext('2d', { willReadFrequently: true });
    const luma = () => {
      pg.drawImage(out, 0, 0, 32, 18);
      const d = pg.getImageData(0, 0, 32, 18).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      return sum / (d.length / 4);
    };
    const draw = () => {
      g.fillStyle = '#000';
      g.fillRect(0, 0, out.width, out.height);
      layers.forEach((c, i) => {
        g.filter = i === 0 && brightness !== 1 ? `brightness(${brightness})` : 'none';
        g.drawImage(c, 0, 0, out.width, out.height);
      });
      g.filter = 'none';
    };
    // The emulator occasionally presents a stray, washed-out frame while a
    // pinch is held; re-grab on the next frame when that happens.
    window.__grab = () =>
      new Promise((res) => {
        let tries = 0;
        const attempt = () => {
          draw();
          if (luma() > 170 && tries++ < 6) return requestAnimationFrame(attempt);
          res(out.toDataURL('image/jpeg', 0.92).slice(23));
        };
        requestAnimationFrame(attempt);
      });
    return layers.map((c) => [c.width, c.height, z(c)]);
  }, brightness);
}
