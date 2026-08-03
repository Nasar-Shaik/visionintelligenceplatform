// Console (apps/console) flat ESLint config. Extends the root config and adds
// browser globals + React Hooks rules. Enforces the design-system rule that
// no raw hex/px arbitrary values appear in className (tokens live in theme.css).
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import root from '../../eslint.config.js';

export default [
  ...root,
  {
    ignores: ['dist/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    /*
     * The workspace panel registry is a *map of components* keyed by `WorkspacePanelId` — that
     * co-location is the point: adding a panel to the frozen contract without a body here is a
     * TypeScript error rather than a blank rectangle a customer finds. Fast-refresh granularity is
     * irrelevant for a lookup table, and splitting it would trade a real guarantee for a dev-server
     * nicety. Same exemption, same reasoning, as the design-system primitives below.
     */
    files: ['src/features/workspace/panels.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    // Design-system primitives legitimately co-export cva variant maps + helper
    // constants alongside their component (standard shadcn pattern); fast-refresh
    // granularity is irrelevant for a token library.
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
      // Design-system guardrail: no hardcoded colours/sizes in className — use tokens.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXAttribute[name.name='className'] Literal[value=/\\[#([0-9a-fA-F]{3,8})\\]|\\[[0-9.]+px\\]/]",
          message:
            'No hardcoded hex/px in className — use design tokens from app/styles/theme.css (DESIGN_SYSTEM.md §7).',
        },
      ],
    },
  },
];
