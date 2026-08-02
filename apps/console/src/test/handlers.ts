import { http, HttpResponse, type RequestHandler } from 'msw';

/**
 * Base MSW request handlers (gateway mocks). Feature slices append their own handlers
 * here (or override per-test) so component/hook tests run against contract-shaped
 * responses without a live gateway.
 */
export const handlers: RequestHandler[] = [
  /**
   * An empty probe archive (P-2.2).
   *
   * A default rather than a per-test fixture because the camera detail sheet reads this on every
   * open, and the honest empty answer — "this camera has never been probed" — is what a real
   * deployment returns until someone tests one. Tests that care override it.
   */
  http.get('/api/camera/cameras/:id/probes', ({ params }) =>
    HttpResponse.json({
      success: true,
      data: { cameraId: params.id, records: [], total: 0, retained: 0, evicted: 0 },
    }),
  ),
];
