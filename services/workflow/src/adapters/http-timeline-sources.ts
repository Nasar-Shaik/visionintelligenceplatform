/**
 * Adapter: the timeline's cross-context joins over HTTP (P-5.2, closing F-3's three gaps).
 *
 * P-5.1 shipped the timeline with `UnavailableTimelineSources` as the default, so every deployment
 * returned three `unavailable` gaps. These are the clients that make it answer.
 *
 * ### ⚠️ Three decisions that are security decisions, not plumbing
 *
 * **1. Every call carries the caller's `Authorization` header, never a service key.** The obvious
 * implementation uses the internal key that `HttpCameraSource` uses — and it would let the timeline
 * show an operator events, evidence and notifications that they cannot open anywhere else in the
 * product. A privilege escalation through a join is invisible: nobody thinks to check an
 * authorisation on a read-only narrative. So a caller with no token gets a refusal, not an upgrade.
 *
 * **2. A 403 is a `forbidden` gap, not an `unavailable` one.** Reporting a permission failure as an
 * outage sends an operator to an engineer for something a role grant fixes. The enum gained a value
 * for this while these clients were being written.
 *
 * **3. Every response is parsed against the contract before it is trusted.** A neighbour that
 * returns a differently-shaped body is a bug in the neighbour; letting it through unvalidated makes
 * it a crash here, in the panel, at read time.
 *
 * Bounding is the caller's job — `IncidentService.timeline` already races each call against
 * `UPSTREAM_TIMEOUT_MS` and counts them against the three-call budget. These clients add a
 * connect-level timeout of their own so a socket that never answers cannot outlive the request.
 */
import { EvidencePage, EventPage, NotificationPage } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { TimelineCaller, TimelineSources } from '../application/ports.js';
import type {
  RelatedAutomation,
  RelatedEvent,
  RelatedEvidence,
} from '../domain/incident-timeline.js';

export interface HttpTimelineSourcesOptions {
  /** Base URL of the events service. Absent ⇒ that source stays unavailable. */
  eventsUrl?: string | undefined;
  evidenceUrl?: string | undefined;
  notifyUrl?: string | undefined;
  /** Socket-level timeout. Sits inside the application's own 2s race, never outside it. */
  timeoutMs?: number;
}

/** Thrown so the application maps it to a `forbidden` gap rather than an `unavailable` one. */
export class UpstreamForbiddenError extends Error {
  readonly forbidden = true;
  constructor(context: string) {
    super(`not permitted to read ${context}`);
    this.name = 'UpstreamForbiddenError';
  }
}

export class HttpTimelineSources implements TimelineSources {
  readonly #events: string | undefined;
  readonly #evidence: string | undefined;
  readonly #notify: string | undefined;
  readonly #timeoutMs: number;

  constructor(opts: HttpTimelineSourcesOptions) {
    this.#events = trim(opts.eventsUrl);
    this.#evidence = trim(opts.evidenceUrl);
    this.#notify = trim(opts.notifyUrl);
    this.#timeoutMs = opts.timeoutMs ?? 1_500;
  }

  /** Which sources this deployment can actually answer — used by readiness and by the review. */
  get configured(): { events: boolean; evidence: boolean; notify: boolean } {
    return {
      events: this.#events !== undefined,
      evidence: this.#evidence !== undefined,
      notify: this.#notify !== undefined,
    };
  }

  async relatedEvents(
    scope: TenantScope,
    correlationId: string,
    limit: number,
    caller?: TimelineCaller,
  ): Promise<{ items: RelatedEvent[]; truncated: boolean }> {
    const base = require_(this.#events, 'the events context');
    const url = `${base}/events?correlationId=${encodeURIComponent(correlationId)}&limit=${limit}`;
    const page = EventPage.parse(await this.#get(url, scope, caller, 'events'));
    return {
      items: page.events.map((event) => {
        const related: RelatedEvent = {
          id: event.id,
          type: event.type,
          occurredAt: event.occurredAt,
        };
        if (event.cameraId !== undefined) related.cameraId = event.cameraId;
        return related;
      }),
      /*
       * `nextCursor` present means the upstream had more than the budget allows. That is exactly a
       * `truncated` gap — reported, never silently dropped, because "the last 200 events" and "the
       * events" are different claims about an investigation.
       */
      truncated: page.nextCursor !== undefined,
    };
  }

  async relatedEvidence(
    scope: TenantScope,
    incidentId: string,
    _correlationId: string,
    limit: number,
    caller?: TimelineCaller,
  ): Promise<{ items: RelatedEvidence[]; truncated: boolean }> {
    const base = require_(this.#evidence, 'the evidence context');
    /*
     * Queried by `incidentId` rather than by correlation deliberately. Both are indexed (P-5.1
     * closed TD-25), but the correlation spine can carry evidence from *sibling* incidents, and a
     * timeline that shows another incident's evidence as this one's is worse than one that shows
     * less. `_correlationId` stays in the signature because the port is shared.
     */
    const url = `${base}/evidence?incidentId=${encodeURIComponent(incidentId)}&limit=${limit}`;
    const page = EvidencePage.parse(await this.#get(url, scope, caller, 'evidence'));
    return {
      items: page.items.map((item) => {
        const related: RelatedEvidence = {
          id: item.id,
          kind: item.kind,
          capturedAt: item.capturedAt,
        };
        if (item.metadata.label !== undefined) related.label = item.metadata.label;
        return related;
      }),
      truncated: page.nextCursor !== undefined,
    };
  }

  async relatedAutomation(
    scope: TenantScope,
    incidentId: string,
    limit: number,
    caller?: TimelineCaller,
  ): Promise<{ items: RelatedAutomation[]; truncated: boolean }> {
    const base = require_(this.#notify, 'the notify context');
    const url = `${base}/notifications?incidentId=${encodeURIComponent(incidentId)}&limit=${limit}`;
    const page = NotificationPage.parse(await this.#get(url, scope, caller, 'notifications'));
    return {
      items: page.items.map((item) => ({
        id: item.id,
        channel: item.channelType,
        status: item.status,
        at: item.updatedAt,
      })),
      truncated: page.nextCursor !== undefined,
    };
  }

  async #get(
    url: string,
    scope: TenantScope,
    caller: TimelineCaller | undefined,
    context: string,
  ): Promise<unknown> {
    const authorization = caller?.authorization;
    if (authorization === undefined || authorization === '') {
      /*
       * ⚠️ Decision 1. The tempting fallback here is a service key. It would work, and it would
       * quietly widen what the timeline can show beyond what the caller can open.
       */
      throw new Error(`cannot read ${context}: the request carried no caller identity`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization,
          'x-tenant-id': scope.tenantId,
          accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) throw new UpstreamForbiddenError(context);
    if (!res.ok) throw new Error(`${context} responded HTTP ${res.status}`);

    const body = (await res.json()) as { data?: unknown };
    return body.data;
  }
}

function trim(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === '') return undefined;
  return url.trim().replace(/\/$/, '');
}

/**
 * An unconfigured source rejects with the same message `UnavailableTimelineSources` uses, so a
 * partly-wired deployment degrades identically to an unwired one — one behaviour, not two.
 */
function require_(base: string | undefined, context: string): string {
  if (base === undefined) throw new Error(`${context} is not configured for this deployment`);
  return base;
}
