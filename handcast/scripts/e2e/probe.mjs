export default async function run({ page, frame }) {
  const app = frame ?? page;
  const info = await app.evaluate(async () => {
    const canvases = [...document.querySelectorAll('canvas')].map((c) => ({
      w: c.width, h: c.height, id: c.id, cls: c.className, z: getComputedStyle(c).zIndex, parent: c.parentElement?.tagName,
    }));
    let frames = 0;
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { frames++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    return { canvases, fps: frames / 2, dev: typeof window.IWER_DEVICE, vw: innerWidth, vh: innerHeight, session: !!window.IWER_DEVICE?.activeSession };
  });
  return JSON.stringify(info);
}
