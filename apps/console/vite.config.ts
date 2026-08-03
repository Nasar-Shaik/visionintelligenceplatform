/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The console is a pure client of the API gateway. In dev we proxy `/api` to the
// gateway so the browser talks to a single origin (CORS is handled server-side by
// enabler G-5 in deployed environments). Gateway dev URL is overridable via env.
const GATEWAY_URL = process.env.VITE_GATEWAY_URL ?? 'http://localhost:8080';

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
        manualChunks: (id: string): string | undefined => {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('@radix-ui')) return 'vendor-radix';
          if (id.includes('@reduxjs') || id.includes('react-redux') || id.includes('@tanstack')) {
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
