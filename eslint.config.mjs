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
      'services/gateway/web/src/components/ui/**',
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
    files: ['services/gateway/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // v0 screens integrated as-is (CLAUDE.md: keep v0's code so re-integration is a clean diff).
    // Changes here go through v0, so only rules that flag real bugs apply.
    files: ['services/gateway/web/src/ui/**'],
    rules: {
      // False positive on ref objects passed to custom props such as `inputRef={refs.password}`.
      'react-hooks/refs': 'off',
      // v0 puts small helpers beside components; this only affects dev hot reload.
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Legacy hand-written screens, retired as v0 screens replace them (CLAUDE.md, "Front-end setup").
    // Only the hooks rule that catches real bugs; the compiler-era rules apply to new code.
    files: [
      'services/gateway/web/src/App.tsx',
      'services/gateway/web/src/screens/**',
      'services/gateway/web/src/components/*.tsx',
    ],
    rules: {
      ...Object.fromEntries(Object.keys(reactHooks.configs.recommended.rules).map((rule) => [rule, 'off'])),
      'react-hooks/rules-of-hooks': 'error',
    },
  },
  {
    // api: a reply sent inside a withOrg/inOrg callback goes out before COMMIT. Use inOrg's
    // `respond(code, body)` or return a value instead (services/gateway/src/scope.ts).
    files: ['services/gateway/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.name=/^(withOrg|inOrg)$/] > :function Identifier[name='reply']",
        message: 'Do not use reply inside a withOrg/inOrg callback: it is sent before COMMIT. Use respond() from inOrg, or return a value.',
      }],
    },
  },
);
