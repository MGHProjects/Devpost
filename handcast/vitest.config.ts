import { defineConfig } from 'vitest/config';

// Pure game-logic tests; the IWSDK dev plugin is not needed here.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
