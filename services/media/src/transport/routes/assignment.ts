/**
 * Transport: the enforcement point's view of **Camera Processing Assignment** (P-8 Phase 6).
 *
 *   GET /perception/assignment           what the gate is doing right now — engineering view
 *   GET /perception/assignment/cameras   per-camera processing metrics — TENANT DATA
 *
 * ### ⚠️ Two routes, two permissions, and the split is not cosmetic
 *
 * The first carries counts, a plan version and runtime health: identical for every tenant, no camera
 * named. It is `system:inspect`, exactly like `/perception/runtime` and `/perception/event-bridge`.
 *
 * The second names a customer's cameras and how much compute each is consuming. It is
 * `assignment:read`, and the tenant comes from the **verified access token** and from nowhere else —
 * never a header, never a query parameter. This is the same rule the tracking routes carry, for the
 * same reason: a caller who can name their own tenant can read every tenant.
 *
 * ### ⚠️ Per-camera figures are served HERE, not as Prometheus labels
 *
 * Prometheus has no tenant isolation. A `camera_id` label on `/metrics` publishes one customer's
 * camera inventory to anything that can reach the scrape endpoint, and the cardinality grows with the
 * estate. Aggregates go to Prometheus; per-camera numbers go through this route, behind a permission
 * and a verified tenant.
 *
 * ### ⚠️ Read-only
 *
 * Nothing here enables, disables, pauses or moves a camera. The control plane owns that decision and
 * the enforcement point obeys the plan — a second place to change an assignment would be a second
 * source of truth, and the audit trail would only know about one of them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CameraProcessingMetrics } from '@vip/contracts';
import { assignmentAiEnabled } from '@vip/contracts';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';
import type { AssignmentClient } from '../../adapters/assignment-client.js';
import type { AssignmentGate } from '../../application/assignment-gate.js';
import type { CameraFrameStats } from '../../adapters/http-frame-sink.js';

export interface AssignmentRoutesDeps {
  auth: Auth;
  /** Absent when the gate is not enabled in this deployment. */
  gate?: AssignmentGate;
  client?: AssignmentClient;
  perception?: {
    cameraStats(tenantId: string, cameraId: string): CameraFrameStats | undefined;
    cameras(tenantId: string): string[];
  };
  publisher?: { publishedFor(tenantId: string, cameraId: string): number | null };
  /** Base URL of the runtime, for live track counts. `''` when this deployment has no perception. */
  runtimeUrl?: string;
  internalKey?: string;
  fetch?: typeof fetch;
}

/** Wall-clock ceiling on the optional runtime hop. A slow runtime is a degraded page, not a hung one. */
const TRACK_TIMEOUT_MS = 2_000;

const DISABLED = {
  enabled: false,
  detail: 'camera processing assignment is not enabled in this deployment',
} as const;

export function registerAssignmentRoutes(app: FastifyInstance, deps: AssignmentRoutesDeps): void {
  const doFetch = deps.fetch ?? fetch;

  app.get(
    '/perception/assignment',
    { preHandler: deps.auth.authorize('system:inspect') },
    async (_request, reply) => {
      if (deps.client === undefined) {
        /*
         * ⚠️ A first-class answer, not an omission. A deployment with the gate off is valid, and the
         * page must say so rather than render zeroes that look identical to "the control plane is
         * unreachable and nothing is assigned".
         */
        return reply.send(success(DISABLED));
      }
      return reply.send(success(deps.client.stats()));
    },
  );

  app.get(
    '/perception/assignment/cameras',
    { preHandler: deps.auth.authorize('assignment:read') },
    async (request: FastifyRequest, reply) => {
      /*
       * ⚠️ The tenant is read off the principal the auth plugin verified — it cannot be influenced by
       * anything the browser chose to send.
       */
      const tenantId = request.principal?.tenantId;
      if (tenantId === undefined || tenantId === '') {
        return reply.send(
          success({ enabled: false, detail: 'no tenant on the verified principal' }),
        );
      }
      if (deps.perception === undefined) return reply.send(success(DISABLED));

      const tracks = await liveTracks(tenantId, deps, doFetch);
      const cameras = deps.perception.cameras(tenantId);
      const rows: CameraProcessingMetrics[] = [];
      for (const cameraId of cameras) {
        const stats = deps.perception.cameraStats(tenantId, cameraId);
        if (stats === undefined) continue;
        const entry = deps.gate?.entry(tenantId, cameraId);
        /*
         * ⚠️ The enforcement point reports what it is DOING, not what the control plane decided.
         * `running` here means frames are being delivered; the authoritative assignment state lives
         * in the control plane and may legitimately differ for a poll interval. Two views of one
         * fact, each honest about which it is.
         */
        const state =
          entry === undefined ? 'unassigned' : entry.intent === 'hold' ? 'paused' : 'running';
        rows.push({
          tenantId,
          cameraId,
          aiEnabled: assignmentAiEnabled(state),
          state,
          profileId: entry?.profileId ?? null,
          runtimeId: entry?.runtimeId ?? null,
          processingFps: stats.fps,
          framesOffered: stats.offered,
          framesDelivered: stats.delivered,
          framesSkippedUnassigned: stats.skippedUnassigned,
          framesDroppedQueueFull: stats.droppedQueueFull,
          queueDepth: stats.queueDepth,
          processingLatencyMs: stats.deliverMsAvg,
          /* ⚠️ `null` when the bridge is off — not 0, which would read as "published nothing". */
          eventsPublished: deps.publisher?.publishedFor(tenantId, cameraId) ?? null,
          /* ⚠️ `null` when tracking could not be read, for the same reason. */
          activeTracks: tracks?.get(cameraId) ?? null,
          lastFrameAt: stats.lastFrameAt,
          lastErrorAt: stats.lastErrorAt,
          lastError: stats.lastError,
        });
      }
      return reply.send(success(rows));
    },
  );
}

/**
 * Live track counts per camera, or `null` when the runtime could not be asked.
 *
 * ⚠️ One call for the whole page rather than one per camera: sixteen sequential hops behind a single
 * request is how a page that works on a demo estate times out on a real one.
 */
async function liveTracks(
  tenantId: string,
  deps: AssignmentRoutesDeps,
  doFetch: typeof fetch,
): Promise<Map<string, number> | null> {
  if (deps.runtimeUrl === undefined || deps.runtimeUrl === '') return null;
  try {
    const res = await doFetch(`${deps.runtimeUrl.replace(/\/+$/, '')}/tracking/cameras`, {
      headers: { 'x-internal-key': deps.internalKey ?? '', 'x-tenant-id': tenantId },
      signal: AbortSignal.timeout(TRACK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    /*
     * ⚠️ The runtime answers `{ cameras: [...], stats: {...} }`, not a bare array. The first version
     * read `data` as an array, found none, and reported every camera's track count as `null` — which
     * is *honest* (ADR-0039 says an unavailable metric is absent, not zero) and is exactly why it
     * survived: a wrong shape and a runtime that has not tracked anything are indistinguishable
     * from the caller's side. The deployment run surfaced it as a finding rather than a failure.
     */
    const body = (await res.json()) as { data?: { cameras?: unknown } };
    const rows = Array.isArray(body.data?.cameras) ? body.data.cameras : [];
    const out = new Map<string, number>();
    for (const row of rows) {
      const r = row as { cameraId?: unknown; activeTracks?: unknown; active?: unknown };
      const count = typeof r.activeTracks === 'number' ? r.activeTracks : r.active;
      if (typeof r.cameraId === 'string' && typeof count === 'number') out.set(r.cameraId, count);
    }
    return out;
  } catch {
    return null;
  }
}
