// CDP screencast: receive composited frames without forcing extra renders.
export async function startScreencast(page, { width = 1280, height = 720, quality = 90 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const sc = { count: 0, latest: null };
  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    sc.latest = data;
    sc.count++;
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId });
    } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  sc.waitNew = async (since, timeout = 10000) => {
    const t0 = Date.now();
    while (sc.count <= since) {
      if (Date.now() - t0 > timeout) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return sc.latest;
  };
  sc.stop = () => cdp.send('Page.stopScreencast');
  return sc;
}
