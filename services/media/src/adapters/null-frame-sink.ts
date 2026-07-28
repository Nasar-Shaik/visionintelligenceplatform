/**
 * The Phase-1 perception seam. Frame extraction exists (the supervisor counts frames and the
 * decoder produces them), but the perception pipeline that consumes pixels is P1-6. This null sink
 * is where that handoff plugs in — swap it for the real frame bus without touching the supervisor.
 * A drop-to-latest policy (INGESTION §Back-pressure) belongs in the real sink, not here.
 */
import type { Frame, FrameSink } from '../application/ports.js';

export class NullFrameSink implements FrameSink {
  push(_tenantId: string, _cameraId: string, _frame: Frame): void {
    /* intentionally discards frames until the perception pipeline lands (P1-6) */
  }
}
