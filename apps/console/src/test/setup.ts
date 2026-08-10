import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { server } from './server';

/*
 * ⛔ **`findBy*` waits 5 s, not the 1 s default — a harness change, never an assertion change.**
 *
 * Every `findBy*` here waits for a React Query round trip through MSW. Under `pnpm turbo lint
 * typecheck test` eleven packages compile and run at once, and on a loaded machine a query that
 * resolves in 40 ms in isolation can take past a second to render. That produced two failures in
 * `rules.test.tsx` during the slice-2.8 gate and zero when the same file ran alone — a **machine
 * load** measurement reported as a product defect, which is the most expensive kind of false
 * negative: it trains everyone to re-run the gate rather than read it.
 *
 * ⚠️ This weakens nothing. A timeout is the longest a test will wait before failing, not how long it
 * takes to pass; a genuinely broken query still fails, five seconds later. What it removes is the
 * suite's ability to report "this machine was busy" as "this feature is broken".
 */
configure({ asyncUtilTimeout: 5_000 });

// jsdom lacks ResizeObserver (Recharts' ResponsiveContainer needs it) and
// matchMedia — provide no-op polyfills so component tests render.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof globalThis.matchMedia;
}

/*
 * ⚠️ `window.localStorage` is absent in this environment (Node's shim needs `--localstorage-file`,
 * and jsdom's is not exposed here). The workspace persists per-operator UI state through it, and
 * the production code already treats an unavailable store as a non-error — the workspace simply is
 * not remembered. But "the store threw" and "the store worked and was empty" are different
 * behaviours, and only one of them is what an operator's browser does. This in-memory stand-in
 * exercises the real path.
 */
if (!('localStorage' in globalThis) || globalThis.localStorage === undefined) {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
}

/*
 * jsdom implements neither the Pointer Capture API nor `scrollIntoView`, both of which Radix's
 * Select uses when it opens. Without these, a listbox cannot be opened in a test at all — and the
 * P-3 location picker is a Select, so "we cannot test it" would have meant "we do not test where a
 * camera gets placed". These are the standard shims, not a workaround for our own code.
 */
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
Element.prototype.scrollIntoView ??= () => {};

// Contract-shaped gateway mocks (MSW). Unhandled requests fail loudly so a missing
// mock is a test error, not a silent hang.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
});
afterAll(() => server.close());
