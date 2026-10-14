import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node', // Node 20+ has fetch, Response, Blob, File, crypto.subtle
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/design/**'], // CLAUDE.md: Vitest ignores design/
    setupFiles: ['src/test/setup.ts'],
    unstubGlobals: true,
    restoreMocks: true,
  },
});
