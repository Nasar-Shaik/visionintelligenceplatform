/**
 * Adapter: reading one analysis run's incidents back from `services/workflow` (slice 5).
 *
 * ⚠️ **Media asks; workflow owns.** The incident lifecycle, its assignment and its notes all live in
 * workflow — a copy here would be a second thing to keep true, and the timeline only needs to place
 * them in the footage.
 */
import { IncidentPage, type Incident } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { AnalysisEventCaller, AnalysisIncidentSource } from '../application/ports.js';

export interface HttpAnalysisIncidentsOptions {
  /** Base URL of the workflow service, e.g. `http://workflow:8087`. */
  baseUrl: string;
  timeoutMs?: number;
}

export class HttpAnalysisIncidents implements AnalysisIncidentSource {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(opts: HttpAnalysisIncidentsOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = opts.timeoutMs ?? 5_000;
  }

  async forSession(
    scope: TenantScope,
    sessionId: string,
    limit: number,
    caller: AnalysisEventCaller,
  ): Promise<{ incidents: Incident[]; truncated: boolean }> {
    /*
     * ⛔ The caller's own authorization, never a service key — see `AnalysisEventCaller`. An incident
     * list is exactly the kind of read where a service key would quietly show more than the person
     * asking is entitled to open.
     */
    if (caller.authorization === '') {
      throw new Error('cannot read this run’s incidents: the request carried no caller identity');
    }
    /*
     * ⚠️ Naming the run is what makes these visible at all: the incident list defaults to the LIVE
     * queue, which deliberately excludes offline findings (ADR-0047).
     */
    const url =
      `${this.#base}/incidents?analysisSessionId=${encodeURIComponent(sessionId)}` +
      `&limit=${String(limit)}`;
    const res = await fetch(url, {
      headers: {
        authorization: caller.authorization,
        'x-tenant-id': scope.tenantId,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`the workflow service answered ${String(res.status)}: ${body.slice(0, 200)}`);
    }
    const envelope = (await res.json()) as { data?: unknown };
    const page = IncidentPage.parse(envelope.data);
    return { incidents: page.items, truncated: page.nextCursor !== undefined };
  }
}
