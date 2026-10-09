/**
 * Plain Vite config (no IWSDK plugin) for the bench visual harness:
 *   npx vite --config dev/bench-demo/vite.bench.config.ts --port 5176
 * '@iwsdk/core' is aliased to bare three, which it re-exports.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  resolve: { alias: { '@iwsdk/core': 'three' } },
  server: { port: 5176, strictPort: true, host: '127.0.0.1', fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
  clearScreen: false,
});
