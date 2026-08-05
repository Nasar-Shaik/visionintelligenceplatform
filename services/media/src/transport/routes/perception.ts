/**
 * Transport: the perception seam's operational view (P-8 Phase 3).
 *
 *   GET /perception/runtime  — what media has measured about the frame path, plus what the AI
 *                              runtime reports about itself.
 *
 * ### ⚠️ Why this lives in media rather than on the gateway
 *
 * The AI runtime is **not routed through the gateway** and P-8 Phase 1 asserts that as a deployment
 * property. Media is the one service that talks to it (ADR-A: media pushes frames), so media is the
 * one service that can answer questions about it without opening a second door. The console reaches
 * this through the gateway's `/api/system/ai-runtime`, which fans out to here.
 *
 * ### ⚠️ Two sources, reported separately, never merged
 *
 * `pipeline` is what **media measured** — offered, delivered, dropped, failed, queue depth. `runtime`
 * is what the **runtime says about itself** — provider, loaded models, its own counters. They are
 * kept apart because their disagreement is diagnostic: media delivering 600 frames while the runtime
 * reports 200 processed is a real finding, and averaging them away would hide it.
 *
 * ### ⚠️ `system:inspect`, and no tenant data
 *
 * This is deployment state, identical for every tenant — the same permission and the same reasoning
 * as System Health (TD-26: `inspect`, not `read`). The payload carries counts, states, versions and
 * label totals; no camera ids, no frames, no boxes.
 */
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../plugins/auth.js';
import type { FrameSinkStats } from '../../adapters/http-frame-sink.js';
import { success } from '../http.js';

/** Wall-clock ceiling on the runtime probe. A slow runtime is a degraded page, not a hung one. */
const PROBE_TIMEOUT_MS = 2_000;

export interface PerceptionRoutesDeps {
  auth: Auth;
  /** The configured sink, or `undefined` when this deployment has no perception wiring. */
  perception?: { stats(): FrameSinkStats };
  /** Base URL of the runtime, or `''` when not configured. */
  runtimeUrl: string;
  internalKey: string;
  capabilityId: string;
  fetch?: typeof fetch;
}

export function registerPerceptionRoutes(app: FastifyInstance, deps: PerceptionRoutesDeps): void {
  const doFetch = deps.fetch ?? fetch;

  app.get(
    '/perception/runtime',
    { preHandler: deps.auth.authorize('system:inspect') },
    async (_request, reply) => {
      /*
       * ⚠️ `configured: false` is a first-class answer, not an error. A deployment with no
       * INFERENCE_URL is a valid deployment, and the page must say "not configured here" rather
       * than render an empty dashboard that looks like an outage.
       */
      if (deps.perception === undefined || deps.runtimeUrl === '') {
        return reply.send(
          success({
            configured: false,
            detail: 'INFERENCE_URL is not set in this deployment, so no frames are analysed.',
            pipeline: null,
            runtime: null,
            observedAt: new Date().toISOString(),
          }),
        );
      }

      return reply.send(
        success({
          configured: true,
          capabilityId: deps.capabilityId,
          pipeline: deps.perception.stats(),
          runtime: await probeRuntime(doFetch, deps.runtimeUrl, deps.internalKey),
          observedAt: new Date().toISOString(),
        }),
      );
    },
  );
}

/**
 * Ask the runtime about itself.
 *
 * ⚠️ Never throws and never propagates: an unreachable runtime is **the answer this page exists to
 * give**, so it is returned as `{ reachable: false, detail }` rather than as a 500 that tells the
 * operator only that something, somewhere, went wrong.
 */
async function probeRuntime(
  doFetch: typeof fetch,
  base: string,
  internalKey: string,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  try {
    const response = await doFetch(`${base.replace(/\/+$/, '')}/runtime`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json', 'x-internal-key': internalKey },
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { reachable: true, latencyMs, detail: `runtime answered HTTP ${response.status}` };
    }
    const body = (await response.json()) as { data?: unknown };
    if (typeof body.data !== 'object' || body.data === null) {
      return { reachable: true, latencyMs, detail: 'runtime answered without a status payload' };
    }
    return { reachable: true, latencyMs, ...(body.data as Record<string, unknown>) };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      detail: connectionReason(err),
    };
  }
}

/**
 * ⚠️ "fetch failed" is not a reason — the same finding the gateway's health page recorded in P-6.4.
 * `undici` puts the real cause one level down, and `ECONNREFUSED` versus `ENOTFOUND` is the
 * difference between "the container is not running" and "the name does not resolve".
 */
function connectionReason(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `runtime did not answer within ${PROBE_TIMEOUT_MS} ms`;
  }
  if (!(err instanceof Error)) return 'connection failed';
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const reason = typeof cause?.code === 'string' ? cause.code : cause?.message;
  return (reason === undefined ? err.message : `${err.message} (${String(reason)})`).slice(0, 300);
}
