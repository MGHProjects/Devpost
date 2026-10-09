// Evaluate an expression in the app frame: EXPR env var, prints JSON.
export default async function run({ page, frame }) {
  const app = frame ?? page;
  await app.waitForFunction(() => window.prismSong !== undefined);
  const expr = process.env.EXPR ?? 'window.prismSong.state()';
  return JSON.stringify(await app.evaluate(expr));
}
