/**
 * Transport: the operator's view of object tracking (P-8 Phase 4).
 *
 *   GET /perception/tracking                    aggregate statistics for the caller's tenant
 *   GET /perception/tracking/cameras            the same metrics, per camera
 *   GET /perception/tracking/tracks             live tracks (?cameraId= &state=)
 *   GET /perception/tracking/tracks/:trackId    one track plus its lifecycle timeline
 *   GET /perception/behaviour                   the behaviour stage's state (?cameraId= &streamId=)
 *   GET /perception/behaviour/primitives        every primitive of an analysis, recomputed
 *   GET /perception/behaviour/timeline          the same facts as an ordered account
 *   GET /perception/behaviour/graph             the same facts again, as nodes and edges
 *   GET /perception/track-history               stored movement paths (?cameraId= &identityId=)
 *
 * ### ⚠️ Why this lives in media, like the runtime view above it
 *
 * The AI runtime is **not routed through the gateway** and P-8 Phase 1 asserts that as a deployment
 * property. Media is the one service that talks to it (ADR-A: media pushes frames), so media is the
 * one service that can answer questions about it without opening a second door. The console reaches
 * this through the gateway's `/api/tracking/*`, which fans out to here.
 *
 * ### ⚠️ This is TENANT DATA, and that makes it different from `/perception/runtime`
 *
 * The runtime view carries counts, states and versions — the same for every tenant. A **track** is a
 * record of a person moving through a customer's premises. So:
 *
 *   - the permission is `track:read`, not `system:inspect`;
 *   - the tenant sent to the runtime comes from the **verified access token** and from nowhere else.
 *     ⚠️ Never from a header, a query parameter or a body field. A caller who can name their own
 *     tenant can read every tenant, and the runtime — which sits behind a shared internal key and
 *     trusts whatever `x-tenant-id` it is handed — would answer without complaint.
 *
 * ### ⚠️ Read-only, and there is nothing here to make it otherwise
 *
 * No route starts, stops, resets or reassigns a track. Tracking is a consequence of frames arriving,
 * not something an operator steers; a control that configured nothing would be worse than none.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PlanZone } from '@vip/contracts';
import type { Auth } from '../plugins/auth.js';
import { success } from '../http.js';

/** Wall-clock ceiling on the runtime hop. A slow runtime is a degraded page, not a hung one. */
const TRACKING_TIMEOUT_MS = 3_000;

/**
 * ⛔ **How much line geometry may ride on one behaviour read.**
 *
 * Bounded because it travels in a query string, and because an unbounded one would let a
 * misconfigured camera turn every investigation read into a request nothing can parse. A tripwire is
 * two points; a bent line is four. These ceilings are far past anything an operator draws and small
 * enough that the encoded parameter stays under 2 kB.
 *
 * ⚠️ Exceeding them is **reported, not truncated**: `lineGeometry: 'absent'` with a stated reason,
 * because a silently shortened line would produce crossings against geometry nobody drew.
 */
export const LINE_READ_LIMITS = { maxLines: 8, maxPointsPerLine: 16 } as const;

export interface TrackingRoutesDeps {
  auth: Auth;
  /** Base URL of the runtime, or `''` when this deployment has no perception wiring. */
  runtimeUrl: string;
  internalKey: string;
  fetch?: typeof fetch;
  /**
   * The assignment gate, when this deployment has one — the source of a camera's **line** geometry
   * for a behaviour read (slice 2.9).
   *
   * ⛔ **Line geometry travels with the question, and is never configured into the runtime.** A
   * crossing needs a trajectory, which only the behaviour layer has; the geometry is the one thing it
   * lacks. Sending it per read keeps the runtime free of configuration and of configuration *state*:
   * there is nothing to invalidate, nothing to go stale, and a line edited a second ago is the line
   * the next read evaluates. That is also what makes a crossing recomputable — a line drawn today
   * applies to an analysis from last week, exactly as ADR-0054 promises for every other fact here.
   *
   * ⚠️ Absent on a deployment with no gate, and the read then reports `lineGeometry: 'absent'` rather
   * than "nobody crossed a line" — different answers that render identically.
   */
  gate?: { entry(tenantId: string, cameraId: string): { zones?: readonly PlanZone[] } | undefined };
  /**
   * ⭐ **When a run finished** — the one fact that turns `absent` into `expired` (EI-4).
   *
   * ⛔ The runtime holds records, not runs. Asked about a stream it has none for, it cannot tell
   * "this analysis never existed" from "this analysis is older than retention" — both are silence,
   * and inventing the distinction from a tenant-wide purge counter would be a guess dressed as a
   * fact. This layer holds `finishedAt`, and a run that finished before the runtime's published
   * retention horizon **cannot** have surviving records. ⭐ A proof, not an inference — and the
   * decision is made once, here, in the only place both facts exist.
   *
   * ⚠️ Absent on a deployment with no analysis store, and the read then stays `absent` rather than
   * guessing.
   */
  sessions?: { finishedAt(tenantId: string, sessionId: string): Promise<string | undefined> };
}

/**
 * The camera's enabled line zones, as the runtime receives them.
 *
 * ⚠️ Returns `undefined` when geometry could not be established at all — no gate, no camera named,
 * no entry — which the caller reports as `absent`. An empty array means the camera *has* no line
 * zones, which is a different and equally real answer.
 */
export function linesForCamera(
  gate: TrackingRoutesDeps['gate'],
  tenantId: string,
  cameraId: string | undefined,
): { lineId: string; name: string; points: [number, number][]; version: number }[] | undefined {
  if (gate === undefined || cameraId === undefined || cameraId === '') return undefined;
  const entry = gate.entry(tenantId, cameraId);
  if (entry === undefined) return undefined;
  const lines = (entry.zones ?? []).filter((zone) => zone.kind === 'line');
  return lines
    .slice(0, LINE_READ_LIMITS.maxLines)
    .filter((zone) => zone.points.length >= 2 && zone.points.length <= LINE_READ_LIMITS.maxPointsPerLine)
    .map((zone) => ({
      lineId: zone.zoneId,
      name: zone.name,
      points: zone.points.map((p) => [p[0], p[1]] as [number, number]),
      version: zone.version,
    }));
}

/**
 * ⭐ Turn the runtime's `absent` into `expired` when the run provably finished before the horizon.
 *
 * ⛔ **Only `absent` is ever upgraded.** A `corrupted` or `lost` read past the horizon is still
 * corrupted or lost — calling it `expired` would excuse a defect as a policy, which is the most
 * comfortable lie available here and the exact collapse EI-4 forbids ("expired must never be
 * reported as lost", in both directions).
 *
 * ⚠️ Exported so the property is testable without a Fastify instance, and pure but for the one
 * lookup it is given.
 */
export async function resolveEvidenceExpiry(
  answer: unknown,
  ctx: {
    sessions?: { finishedAt(tenantId: string, sessionId: string): Promise<string | undefined> };
    tenantId: string;
    streamId?: string;
  },
): Promise<unknown> {
  if (answer === null || typeof answer !== 'object') return answer;
  const evidence = (answer as { evidence?: unknown }).evidence;
  if (evidence === null || typeof evidence !== 'object') return answer;
  const state = evidence as { state?: unknown; retentionHorizonAt?: unknown };
  if (state.state !== 'absent' || typeof state.retentionHorizonAt !== 'string') return answer;
  if (ctx.sessions === undefined || ctx.streamId === undefined) return answer;

  const finishedAt = await ctx.sessions.finishedAt(ctx.tenantId, ctx.streamId).catch(() => undefined);
  if (finishedAt === undefined) return answer;
  const finished = Date.parse(finishedAt);
  const horizon = Date.parse(state.retentionHorizonAt);
  /* ⚠️ An unparseable timestamp must not manufacture an explanation for missing evidence. */
  if (Number.isNaN(finished) || Number.isNaN(horizon) || finished >= horizon) return answer;

  return {
    ...answer,
    evidence: {
      ...evidence,
      state: 'expired',
      detail: `this run finished at ${finishedAt}, before the retention horizon of ${state.retentionHorizonAt}. ⚠️ Its movement paths were removed as the retention policy promises — they were not lost, and this is not a claim that nothing happened.`,
    },
  };
}

export function registerTrackingRoutes(app: FastifyInstance, deps: TrackingRoutesDeps): void {
  const doFetch = deps.fetch ?? fetch;

  const proxy = async (request: FastifyRequest, path: string, query = ''): Promise<unknown> => {
    /*
     * ⚠️ The tenant is read off the principal the auth plugin verified. `request.principal` is
     * populated by `authorize()` having already checked the token signature, issuer and audience —
     * so this cannot be influenced by anything the browser chose to send.
     */
    const tenantId = request.principal?.tenantId;
    if (tenantId === undefined || tenantId === '') {
      return { enabled: false, detail: 'no tenant on the verified principal' };
    }
    if (deps.runtimeUrl === '') {
      return {
        enabled: false,
        detail: 'INFERENCE_URL is not set in this deployment, so nothing is tracked.',
      };
    }
    const base = deps.runtimeUrl.replace(/\/+$/, '');
    const response = await doFetch(`${base}${path}${query}`, {
      signal: AbortSignal.timeout(TRACKING_TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        'x-internal-key': deps.internalKey,
        'x-tenant-id': tenantId,
      },
    });
    const body = (await response.json()) as { data?: unknown; error?: { message?: string } };
    if (!response.ok) {
      /*
       * ⚠️ 404 is forwarded as a null result rather than raised. "This track is not live any more"
       * is an ordinary answer for a page watching a moving scene — a track that ended between the
       * list request and the detail request is the normal case, not an error worth a red banner.
       */
      if (response.status === 404) return null;
      throw new Error(body.error?.message ?? `runtime answered HTTP ${response.status}`);
    }
    return body.data ?? null;
  };

  app.get(
    '/perception/tracking',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) =>
      reply.send(success(await unreachableAsAnswer(() => proxy(request, '/tracking')))),
  );

  /*
   * ⚠️ `track:read`, the same permission as the tracks themselves, and deliberately not a weaker
   * one. A per-camera row names a camera and says how many people it has seen — that is tenant
   * data about a customer's premises, and a caller who may not read tracks may not read this
   * either. It is the surface Camera Processing Assignment will build on, so the permission it
   * inherits is the one that has to be right now rather than later.
   */
  app.get(
    '/perception/tracking/cameras',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) =>
      reply.send(success(await unreachableAsAnswer(() => proxy(request, '/tracking/cameras')))),
  );

  app.get<{ Querystring: { cameraId?: string; state?: string } }>(
    '/perception/tracking/tracks',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.cameraId !== undefined) params.set('cameraId', request.query.cameraId);
      if (request.query.state !== undefined) params.set('state', request.query.state);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return reply.send(
        success(await unreachableAsAnswer(() => proxy(request, '/tracking/tracks', query))),
      );
    },
  );

  app.get<{ Params: { trackId: string } }>(
    '/perception/tracking/tracks/:trackId',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const encoded = encodeURIComponent(request.params.trackId);
      const detail = await unreachableAsAnswer(() => proxy(request, `/tracking/tracks/${encoded}`));
      if (detail === null)
        return reply.status(404).send({
          success: false,
          error: { code: 'not_found', message: 'that track is no longer live' },
        });
      return reply.send(success(detail));
    },
  );

  /*
   * ⚠️ **`track:read`, the same permission as a track, and not a weaker one.** A behaviour primitive
   * is a statement about how a person moved — dwell, proximity, who they were near — which is more
   * revealing than the track it was derived from, never less. A separate, softer permission would be
   * the kind of mistake that only shows up in an audit.
   */
  app.get<{ Querystring: { cameraId?: string; streamId?: string } }>(
    '/perception/behaviour',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const params = new URLSearchParams();
      if (request.query.cameraId !== undefined) params.set('cameraId', request.query.cameraId);
      if (request.query.streamId !== undefined) params.set('streamId', request.query.streamId);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return reply.send(
        success(await unreachableAsAnswer(() => proxy(request, '/tracking/behaviour', query))),
      );
    },
  );

  /*
   * ⭐ **Behaviour for a whole analysis, independent of the console and of any rule** (slice 2.3).
   *
   * `primitives` is what the primitives say — no threshold applied, no verdict attached. `timeline`
   * is the same facts as an ordered account, each entry carrying the frame it came from. `graph` is
   * the same account again as nodes and edges — ⭐ a *reshaping* of the timeline rather than a third
   * computation, so the three views cannot disagree about one investigation.
   *
   * ⚠️ Same `track:read` permission, for the same reason: a recomputed dwell is more revealing than
   * the track it came from, never less. ⚠️ Both are **recomputed on read** from stored movement
   * paths — nothing new is persisted, so a corrected formula fixes history rather than being unable
   * to reach it (ADR-0054).
   */
  for (const view of ['primitives', 'timeline', 'graph'] as const) {
    app.get<{
      Querystring: { cameraId?: string; streamId?: string; identityId?: string; kinds?: string };
    }>(
      `/perception/behaviour/${view}`,
      { preHandler: deps.auth.authorize('track:read') },
      async (request, reply) => {
        const params = new URLSearchParams();
        /*
         * ⭐ `kinds` narrows the timeline BEFORE the runtime's entry cap (slice 2.8). A reader that
         * filters what it received cannot recover a fact the cap already dropped — measured on a
         * live camera where 1207 of the 2000 permitted entries were `gap`.
         */
        for (const key of ['cameraId', 'streamId', 'identityId', 'kinds'] as const) {
          const value = request.query[key];
          if (value !== undefined) params.set(key, value);
        }

        /*
         * ⭐ **Slice 2.9: the camera's line geometry, sent with the question.** See `linesForCamera`
         * and the `gate` note above on why it travels per read rather than being configured into the
         * runtime — and why that is what makes a crossing recomputable.
         *
         * ⚠️ Sent even when the list is empty. "This camera has no line zones" and "line geometry
         * could not be established" are different answers, and the runtime can only tell them apart
         * if the empty case arrives as an empty list rather than as silence.
         */
        const lines = linesForCamera(
          deps.gate,
          request.principal?.tenantId ?? '',
          request.query.cameraId,
        );
        if (lines !== undefined) params.set('lines', JSON.stringify(lines));

        const query = params.size > 0 ? `?${params.toString()}` : '';
        const answer = await unreachableAsAnswer(() =>
          proxy(request, `/tracking/behaviour/${view}`, query),
        );
        return reply.send(
          success(
            await resolveEvidenceExpiry(answer, {
              ...(deps.sessions === undefined ? {} : { sessions: deps.sessions }),
              tenantId: request.principal?.tenantId ?? '',
              ...(request.query.streamId === undefined ? {} : { streamId: request.query.streamId }),
            }),
          ),
        );
      },
    );
  }

  /*
   * ⚠️ Stored movement paths (ADR-0051). Read-only here, deliberately: **erasure is not a console
   * button.** A tenant-scoped delete must remove history alongside the incidents that cite it, and a
   * control that removed one and left the other would answer "deleted" while the evidence trail
   * still named the person. The runtime's `DELETE /tracking/history` exists and is verified; joining
   * it to platform-wide tenant deletion is recorded as a remaining blocker rather than half-wired.
   */
  app.get<{ Querystring: { cameraId?: string; identityId?: string; streamId?: string } }>(
    '/perception/track-history',
    { preHandler: deps.auth.authorize('track:read') },
    async (request, reply) => {
      const params = new URLSearchParams();
      for (const key of ['cameraId', 'identityId', 'streamId'] as const) {
        const value = request.query[key];
        if (value !== undefined) params.set(key, value);
      }
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return reply.send(
        success(await unreachableAsAnswer(() => proxy(request, '/tracking/history', query))),
      );
    },
  );
}

/**
 * ⚠️ An unreachable runtime is **the answer this page exists to give**, not a 500.
 *
 * The same reasoning as `probeRuntime` in perception.ts: "the runtime is not answering" is a
 * deployment fact the operator needs to see, and "internal server error" sends them looking at the
 * wrong service. The reason is carried through so the page can name it.
 */
async function unreachableAsAnswer(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      enabled: false,
      unreachable: true,
      detail: timedOut
        ? `the runtime did not answer within ${TRACKING_TIMEOUT_MS} ms`
        : reasonFor(err),
    };
  }
}

/**
 * ⚠️ "fetch failed" is not a reason — the finding P-6.4 recorded and perception.ts repeats.
 * `undici` puts the real cause one level down, and `ECONNREFUSED` versus `ENOTFOUND` is the
 * difference between "the container is not running" and "the name does not resolve".
 */
function reasonFor(err: unknown): string {
  if (!(err instanceof Error)) return 'the runtime could not be reached';
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const reason = typeof cause?.code === 'string' ? cause.code : cause?.message;
  return (reason === undefined ? err.message : `${err.message} (${String(reason)})`).slice(0, 300);
}
