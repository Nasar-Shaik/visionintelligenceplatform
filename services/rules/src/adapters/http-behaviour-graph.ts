/**
 * Adapter: the **behaviour graph**, over HTTP (Phase 2.4 slice 2.7).
 *
 * ⛔ **The caller's own `Authorization` header, never an internal key.** The graph shows where named
 * people went, who they were near and what they carried — more revealing than the tracks it is
 * derived from, never less. Reading it through a service credential would let anyone able to post a
 * rule see movement they cannot see anywhere else in the product, and a privilege escalation through
 * a join is invisible because nobody thinks to check an authorisation on a read-only explanation.
 * `http-timeline-sources.ts` in workflow made the same call for the same reason.
 *
 * ⚠️ **Unavailable is an answer, not an empty graph.** A refusal, a timeout or a differently-shaped
 * body all return `{ unavailable, detail }`, and the route turns that into a 503. Returning
 * `{ nodes: [], edges: [] }` would make "the runtime is down" and "nobody did anything" identical to
 * every rule and every reader — the failure this project has now met nine times.
 */
import type { BehaviourGraphView } from '../domain/behaviour-reasoning.js';

export interface HttpBehaviourGraphOptions {
  /** Base URL of the media service, e.g. `http://media:8083`. ⚠️ Media is the only service that
   * talks to the runtime (ADR-A), so the graph is read through it rather than from the runtime. */
  baseUrl: string;
  /** ⚠️ Short. Somebody is waiting on this, and a slow answer is worse than a stated failure. */
  timeoutMs?: number;
  onLog?: (level: 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export type GraphQuery = { streamId?: string; cameraId?: string; identityId?: string };

export function createHttpBehaviourGraph(options: HttpBehaviourGraphOptions) {
  const timeoutMs = options.timeoutMs ?? 5_000;

  return async function fetchGraph(
    query: GraphQuery,
    authorization: string,
  ): Promise<BehaviourGraphView | { unavailable: true; detail: string }> {
    if (options.baseUrl === '') {
      return { unavailable: true, detail: 'this deployment has no media service configured' };
    }
    if (authorization === '') {
      /* ⛔ Refused, not upgraded. See the module note on why this never falls back to a service key. */
      return { unavailable: true, detail: 'the caller presented no token, and the graph is not read without one' };
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, value);
    const url = `${options.baseUrl.replace(/\/$/, '')}/perception/behaviour/graph?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { authorization }, signal: controller.signal });
      if (res.status === 401 || res.status === 403) {
        /* ⚠️ A permission failure reported as one. Calling it an outage sends an operator to an
         * engineer for something a role grant fixes. */
        return { unavailable: true, detail: `the caller may not read the behaviour graph (HTTP ${res.status})` };
      }
      if (!res.ok) return { unavailable: true, detail: `the behaviour graph read failed: HTTP ${res.status}` };

      const body = (await res.json()) as { data?: { graph?: unknown } };
      const graph = body.data?.graph as BehaviourGraphView | undefined;
      if (graph === undefined || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        /* ⚠️ A neighbour returning a differently-shaped body is a bug in the neighbour; letting it
         * through unvalidated makes it a crash here, at read time, in front of an operator. */
        return { unavailable: true, detail: 'the behaviour graph read returned a body of the wrong shape' };
      }
      return graph;
    } catch (err) {
      const detail =
        err instanceof Error && err.name === 'AbortError'
          ? `the behaviour graph did not answer within ${String(timeoutMs)} ms`
          : `the behaviour graph could not be reached: ${err instanceof Error ? err.message : String(err)}`;
      options.onLog?.('warn', detail, { url });
      return { unavailable: true, detail };
    } finally {
      clearTimeout(timer);
    }
  };
}
