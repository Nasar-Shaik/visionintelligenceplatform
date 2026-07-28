/**
 * Adapter: resolves a camera's connection descriptor (with decrypted credentials) by calling the
 * Camera context's INTERNAL endpoint (`GET /internal/cameras/:id/stream`), authenticated with the
 * shared internal key (`.env`, ADR-0018). This is a control-plane, service-to-service call — not a
 * user request — so it carries no user JWT. Credentials are used transiently to connect and never
 * stored or logged. See camera service `routes/internal.ts`.
 */
import { StreamConnection } from '@vip/contracts';
import type { CameraSource } from '../application/ports.js';

export interface HttpCameraSourceOptions {
  /** Base URL of the camera service, e.g. `http://localhost:8082`. */
  baseUrl: string;
  internalKey: string;
  /** Request timeout (ms). */
  timeoutMs?: number;
}

export class HttpCameraSource implements CameraSource {
  readonly #base: string;
  readonly #key: string;
  readonly #timeoutMs: number;

  constructor(opts: HttpCameraSourceOptions) {
    this.#base = opts.baseUrl.replace(/\/$/, '');
    this.#key = opts.internalKey;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
  }

  async resolve(tenantId: string, cameraId: string): Promise<StreamConnection> {
    const url = `${this.#base}/internal/cameras/${encodeURIComponent(cameraId)}/stream`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'x-internal-key': this.#key, 'x-tenant-id': tenantId },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`camera resolve failed for ${cameraId}: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: unknown };
    // Validate against the contract — never trust the wire shape blindly.
    return StreamConnection.parse(json.data);
  }
}
