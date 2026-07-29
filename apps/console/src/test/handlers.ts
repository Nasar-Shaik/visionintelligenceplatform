import type { RequestHandler } from 'msw';

/**
 * Base MSW request handlers (gateway mocks). Feature slices append their own handlers
 * here (or override per-test) so component/hook tests run against contract-shaped
 * responses without a live gateway. Empty for the foundation slice.
 */
export const handlers: RequestHandler[] = [];
