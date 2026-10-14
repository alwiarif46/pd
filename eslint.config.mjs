// One flat config for the whole repo. Each package's `lint` script runs `eslint .`,
// which finds this file by walking up from the package folder.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      // v0's drop folder: never built, type-checked, or linted (CLAUDE.md).
      'design/**',
      // shadcn/ui output from the CLI; not edited by hand (CLAUDE.md).
      'apps/web/src/components/ui/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Legacy hand-written screens, retired as v0 screens replace them (CLAUDE.md, "Front-end setup").
    // Only the hooks rule that catches real bugs; the compiler-era rules apply to new code.
    files: [
      'apps/web/src/App.tsx',
      'apps/web/src/screens/**',
      'apps/web/src/components/*.tsx',
    ],
    rules: {
      ...Object.fromEntries(Object.keys(reactHooks.configs.recommended.rules).map((rule) => [rule, 'off'])),
      'react-hooks/rules-of-hooks': 'error',
    },
  },
);
