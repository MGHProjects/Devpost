/**
 * Stand-alone visual harness for the glass-hand rendering (no IWSDK plugin).
 * npx vite --config dev/glass-demo/vite.glass.config.ts --port 5175
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  server: { host: '0.0.0.0', port: 5175, strictPort: true, open: false },
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three'] },
});
