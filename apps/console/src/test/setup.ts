import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { cleanup } from '@testing-library/react';
import { server } from './server';

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
