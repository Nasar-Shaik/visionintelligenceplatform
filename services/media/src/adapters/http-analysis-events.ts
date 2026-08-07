/**
 * Adapter: reading one analysis run's events back from `services/events` (P-8 Phase 8, slice 4).
 *
 * ⚠️ **Media asks; it does not keep a copy.** The events service owns the record, and a second copy
 * in media would be a second thing to keep true — the exact shape of defect a derived timeline
 * exists to avoid. This is one internal HTTP hop, bounded and timed out, exactly as
 * `services/workflow` already reads events for an incident timeline.
 */
import { EventPage, TIMELINE_MAX_EVENTS, type EventEnvelope } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { AnalysisEventCaller, AnalysisEventSource } from '../application/ports.js';

export interface HttpAnalysisEventsOptions {
  /** Base URL of the events service, e.g. `http://events:8084`. */
  baseUrl: string;
  /** Per-request ceiling. ⚠️ A timeline is a screen, not a batch job. */
  timeoutMs?: number;
  /** Events per upstream page. Bounded by the events service's own `limit` cap. */
  pageSize?: number;
}

export class HttpAnalysisEvents implements AnalysisEventSource {
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #pageSize: number;

  constructor(opts: HttpAnalysisEventsOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
    this.#pageSize = opts.pageSize ?? 500;
  }

  async forSession(
    scope: TenantScope,
    sessionId: string,
    limit: number = TIMELINE_MAX_EVENTS,
    caller: AnalysisEventCaller,
  ): Promise<{ events: EventEnvelope[]; truncated: boolean }> {
    const collected: EventEnvelope[] = [];
    let cursor: string | undefined;

    /*
     * ⚠️ **Paged, with a hard stop.** The events API caps a page at 500 and an analysis can produce
     * far more, so a single request would silently return the newest 500 and the timeline would show
     * the *end* of a recording as though it were the whole of it. The loop is bounded by `limit` so
     * the cost of this endpoint can never be set by how much footage a customer uploaded.
     */
    for (;;) {
      const remaining = limit - collected.length;
      if (remaining <= 0) break;
      const size = Math.min(this.#pageSize, remaining);
      const url =
        `${this.#base}/events?analysisSessionId=${encodeURIComponent(sessionId)}` +
        `&limit=${String(size)}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;

      const page = EventPage.parse(await this.#get(url, scope, caller));
      collected.push(...page.events);
      if (page.nextCursor === undefined) return { events: collected, truncated: false };
      cursor = page.nextCursor;
    }

    /*
     * ⛔ Reaching the ceiling with more upstream is a **truncation**, reported as one. The caller
     * turns it into a visible statement on the timeline rather than a quietly shorter list.
     */
    return { events: collected, truncated: true };
  }

  async #get(url: string, scope: TenantScope, caller: AnalysisEventCaller): Promise<unknown> {
    /*
     * ⛔ **The caller's own authorization, never a service key.** A service key would work here and
     * would quietly widen what a timeline can show beyond what the person asking for it is entitled
     * to open — `services/workflow` records the same decision for the incident timeline. A request
     * that arrived without an identity gets an error, not a privileged read on its behalf.
     */
    if (caller.authorization === '') {
      throw new Error('cannot read this run’s events: the request carried no caller identity');
    }
    const res = await fetch(url, {
      headers: {
        authorization: caller.authorization,
        /* ⚠️ The tenant travels with the request — the events service is fail-closed without it. */
        'x-tenant-id': scope.tenantId,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`the events service answered ${String(res.status)}: ${body.slice(0, 200)}`);
    }
    const envelope = (await res.json()) as { data?: unknown };
    return envelope.data;
  }
}
