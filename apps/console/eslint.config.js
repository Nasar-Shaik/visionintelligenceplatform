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
