import { defineConfig, configDefaults } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // Node 20+ has fetch, Response, Blob, File, crypto.subtle. Component tests (*.test.tsx) opt into a DOM
    // with a `// @vitest-environment jsdom` comment at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: [...configDefaults.exclude, '**/design/**'], // CLAUDE.md: Vitest ignores design/
    setupFiles: ['src/test/setup.ts'],
    unstubGlobals: true,
    restoreMocks: true,
  },
});
