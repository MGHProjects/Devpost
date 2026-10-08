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
    window.__grab = () =>
      new Promise((res) => {
        requestAnimationFrame(() => {
          g.fillStyle = '#000';
          g.fillRect(0, 0, out.width, out.height);
          layers.forEach((c, i) => {
            g.filter = i === 0 && brightness !== 1 ? `brightness(${brightness})` : 'none';
            g.drawImage(c, 0, 0, out.width, out.height);
          });
          g.filter = 'none';
          res(out.toDataURL('image/jpeg', 0.92).slice(23));
        });
      });
    return layers.map((c) => [c.width, c.height, z(c)]);
  }, brightness);
}
