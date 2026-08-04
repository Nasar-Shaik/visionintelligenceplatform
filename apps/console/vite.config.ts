/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The console is a pure client of the API gateway. In dev we proxy `/api` to the
// gateway so the browser talks to a single origin (CORS is handled server-side by
// enabler G-5 in deployed environments). Gateway dev URL is overridable via env.
const GATEWAY_URL = process.env.VITE_GATEWAY_URL ?? 'http://localhost:8080';

/**
 * The npm package a resolved module belongs to, or `undefined` for first-party source.
 *
 * The package name is whatever follows the **last** `node_modules/` — which is what makes this
 * correct under pnpm, where everything before that is a virtual-store directory whose name embeds
 * versions and peer hashes and must never be pattern-matched.
 */
function packageNameOf(id: string): string | undefined {
  const marker = 'node_modules/';
  const at = id.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = id.slice(at + marker.length).split('/');
  const [first, second] = parts;
  if (first === undefined) return undefined;
  return first.startsWith('@') && second !== undefined ? `${first}/${second}` : first;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        /*
         * ⚠️ Vendor is split from application code so a release that changes only our code does not
         * invalidate ~200 kB of React, Redux and Radix in every operator's browser cache. Measured
         * in P-5.3: before route splitting the console was **one 1.41 MB chunk**, so every page —
         * the rule editor, Recharts, the whole workspace — downloaded before the login form
         * rendered. Nothing was wrong; nothing had been measured.
         *
         * Recharts is its own chunk because it is the single largest dependency and only the
         * dashboard needs it.
         */
        /*
         * ⚠️ Split by **package name**, never by substring of the module path.
         *
         * The previous rule tested `id.includes('react-dom')`, which under pnpm matches the
         * peer-dependency hash in the virtual store — a Radix module resolves to
         * `.pnpm/@radix-ui+react-dialog@1.1.15_@types+react-dom@19.2.3_react@19.2.7/node_modules/…`.
         * So Radix, react-router, sonner, react-smooth and @floating-ui all landed in
         * `vendor-react`. They import utilities that live in `vendor`, while `vendor` imports React
         * back out of `vendor-react`: a **circular chunk dependency**. In an ES module cycle one
         * side evaluates against the other's uninitialised bindings, and the console died at load
         * with `Cannot read properties of undefined (reading 'forwardRef')` — a blank page.
         *
         * ⚠️ It was invisible for three milestones because `vite build` succeeded, the bundle
         * budget passed, and every test ran against the dev server or jsdom. Nothing had ever
         * *loaded the built bundle in a browser*. `scripts/check-bundle-budget.mjs` now fails the
         * build on any chunk cycle, so this cannot come back quietly.
         */
        manualChunks: (id: string): string | undefined => {
          const pkg = packageNameOf(id);
          if (pkg === undefined) return undefined;
          if (pkg === 'recharts' || pkg.startsWith('d3-') || pkg === 'victory-vendor') {
            return 'vendor-charts';
          }
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'vendor-react';
          if (pkg.startsWith('@radix-ui/')) return 'vendor-radix';
          if (
            pkg.startsWith('@reduxjs/') ||
            pkg === 'react-redux' ||
            pkg.startsWith('@tanstack/')
          ) {
            return 'vendor-state';
          }
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: GATEWAY_URL,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
