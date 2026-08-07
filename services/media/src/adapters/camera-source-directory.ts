/**
 * Adapter: a `CameraDirectory` built entirely from the `CameraSource` the media service already
 * has (P-8 Phase 8).
 *
 * ⭐ **No new endpoint, no new client, no new contract.** An analysis needs one thing from the
 * Camera context — *does this camera exist in this tenant?* — and `resolve()` already answers it,
 * over an internal route that is wired, authenticated and exercised on every stream start.
 *
 * ⚠️ **It answers existence and nothing else.** `StreamConnection` carries the transport and the
 * credentials, not the label, so no display name is available here — and inventing one from the id
 * would put `cam_a1b2c3` in a field that means a name, which is what ends up printed on a customer's
 * report. The console already resolves camera names client-side (`useCameraName`) for every other
 * screen, so the server does not need to.
 */
import type { CameraDirectory, CameraSource } from '../application/ports.js';

export class CameraSourceDirectory implements CameraDirectory {
  readonly #source: CameraSource;

  constructor(source: CameraSource) {
    this.#source = source;
  }

  /**
   * ⚠️ Returns `false` for *any* failure to resolve, deliberately merging "no such camera" with "the
   * camera service is unreachable". The caller's refusal — an analysis must be bound to a real
   * camera — is right in both cases, and the alternative is creating an analysis against a camera
   * nobody could confirm and discovering it when the run finds nothing.
   */
  async exists(tenantId: string, cameraId: string): Promise<boolean> {
    try {
      await this.#source.resolve(tenantId, cameraId);
      return true;
    } catch {
      return false;
    }
  }
}
