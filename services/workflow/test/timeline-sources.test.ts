/**
 * P-5.2 — the timeline's cross-context join clients.
 *
 * P-5.1 shipped the timeline with every source unavailable by design, so `GET
 * /incidents/:id/timeline` returned three gaps in every deployment. These tests cover the clients
 * that close them, and — more importantly — the two rules that make the join safe:
 *
 *   1. it runs under the **caller's** permissions, never a service key;
 *   2. a 403 is reported as `forbidden`, not as an outage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import {
  HttpTimelineSources,
  UpstreamForbiddenError,
} from '../src/adapters/http-timeline-sources.js';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { IncidentService } from '../src/application/incident-service.js';
import { UnavailableTimelineSources, type TimelineSources } from '../src/application/ports.js';
import { personCandidate } from './helpers.js';

const scope = TenantScope.fromTenantId('tnt_a');
const caller = { authorization: 'Bearer operator-token' };

const originalFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function respond(status: number, data: unknown): void {
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const sources = new HttpTimelineSources({
  eventsUrl: 'http://events:8085/',
  evidenceUrl: 'http://evidence:8086',
  notifyUrl: 'http://notify:8088',
});

describe('the joins run as the caller', () => {
  /*
   * ⚠️ The decision this file exists for. A service key would work perfectly and would let the
   * timeline show an operator events they cannot open in the Events panel — a privilege escalation
   * through a read-only narrative, which is where nobody looks for one.
   */
  it('⚠️ forwards the caller’s token verbatim and sends no service key', async () => {
    respond(200, { events: [] });
    await sources.relatedEvents(scope, 'corr_1', 50, caller);

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer operator-token');
    expect(headers).not.toHaveProperty('x-internal-key');
  });

  it('⚠️ refuses to call upstream at all when the request carried no identity', async () => {
    respond(200, { events: [] });
    await expect(sources.relatedEvents(scope, 'corr_1', 50, undefined)).rejects.toThrow(
      /no caller identity/,
    );
    /* Not "called and failed" — never called. An unauthenticated join must not be upgraded. */
    expect(calls).toHaveLength(0);
  });

  it('scopes every call to the tenant', async () => {
    respond(200, { items: [] });
    await sources.relatedEvidence(scope, 'inc_1', 'corr_1', 50, caller);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-tenant-id']).toBe('tnt_a');
  });
});

describe('a 403 is a permission answer, not an outage', () => {
  /*
   * ⚠️ Reporting "you may not read events" as "the events service is unavailable" sends an operator
   * to an engineer for something a role grant fixes. Found while writing these clients; the frozen
   * gap enum gained `forbidden` for it.
   */
  it('⚠️ raises a forbidden error the service maps to a forbidden gap', async () => {
    respond(403, null);
    await expect(sources.relatedEvents(scope, 'corr_1', 50, caller)).rejects.toBeInstanceOf(
      UpstreamForbiddenError,
    );
  });

  it('treats 401 the same way — an expired token is not an outage either', async () => {
    respond(401, null);
    await expect(sources.relatedEvidence(scope, 'inc_1', 'c', 50, caller)).rejects.toBeInstanceOf(
      UpstreamForbiddenError,
    );
  });

  it('reports a genuine 500 as an ordinary failure', async () => {
    respond(500, null);
    const error = await sources
      .relatedAutomation(scope, 'inc_1', 50, caller)
      .catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(UpstreamForbiddenError);
    expect(String(error)).toContain('500');
  });
});

describe('shapes are parsed, never trusted', () => {
  it('maps an event page into the timeline’s reduced shape', async () => {
    respond(200, {
      events: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          type: 'perception.person.detected',
          envelopeVersion: '1.0.0',
          category: 'perception',
          schemaVersion: '1.0.0',
          tenantId: 'tnt_a',
          cameraId: 'cam_1',
          occurredAt: '2026-08-03T14:00:00.000Z',
          ingestedAt: '2026-08-03T14:00:01.000Z',
          producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
          priority: 'high',
        },
      ],
    });
    const result = await sources.relatedEvents(scope, 'corr_1', 50, caller);
    expect(result.items).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'perception.person.detected',
        occurredAt: '2026-08-03T14:00:00.000Z',
        cameraId: 'cam_1',
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('rejects a body that does not match the contract rather than passing it on', async () => {
    respond(200, { events: [{ id: 'not-a-uuid' }] });
    await expect(sources.relatedEvents(scope, 'corr_1', 50, caller)).rejects.toThrow();
  });

  /* "The last 200 events" and "the events" are different claims about an investigation. */
  it('reports truncation when the upstream had another page', async () => {
    respond(200, { events: [], nextCursor: 'more' });
    const result = await sources.relatedEvents(scope, 'corr_1', 50, caller);
    expect(result.truncated).toBe(true);
  });
});

describe('an unconfigured source degrades exactly as an unwired one did', () => {
  const partial = new HttpTimelineSources({ eventsUrl: 'http://events:8085' });

  it('rejects with the same message the default port uses, so behaviour does not fork', async () => {
    await expect(partial.relatedEvidence(scope, 'inc_1', 'c', 50, caller)).rejects.toThrow(
      /not configured for this deployment/,
    );
    await expect(partial.relatedAutomation(scope, 'inc_1', 50, caller)).rejects.toThrow(
      /not configured for this deployment/,
    );
  });

  it('reports which sources this deployment can answer', () => {
    expect(partial.configured).toEqual({ events: true, evidence: false, notify: false });
  });
});

describe('the evidence join asks by incident, not by correlation', () => {
  /*
   * Both are indexed (P-5.1 closed TD-25). The correlation spine can carry evidence from *sibling*
   * incidents, and a timeline showing another incident's evidence as this one's is worse than one
   * showing less.
   */
  it('⚠️ queries incidentId so a sibling incident’s evidence cannot leak in', async () => {
    respond(200, { items: [] });
    await sources.relatedEvidence(scope, 'inc_1', 'corr_shared', 50, caller);
    expect(calls[0]!.url).toContain('incidentId=inc_1');
    expect(calls[0]!.url).not.toContain('correlationId');
  });
});

// ---------------------------------------------------------------------------------------------
// The service level: a failure's *reason* survives all the way into the response.
// ---------------------------------------------------------------------------------------------

describe('IncidentService.timeline distinguishes forbidden from unavailable', () => {
  const tenantScope = TenantScope.fromTenantId('tnt_a');

  async function timelineWith(sourcesOverride: TimelineSources) {
    const store = new InMemoryIncidentStore();
    let clock = Date.parse('2026-08-03T09:00:00.000Z');
    let seq = 0;
    const service = new IncidentService({
      store,
      now: () => new Date((clock += 1000)),
      newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      sources: sourcesOverride,
    });
    const { incident } = await service.promote(tenantScope, personCandidate());
    return service.timeline(tenantScope, incident.id, ['events', 'evidence'], {
      authorization: 'Bearer t',
    });
  }

  /*
   * ⚠️ The end-to-end shape of the finding. Before P-5.2 every failure became `unavailable`; an
   * operator excluded by their role was told the events service was down.
   */
  it('⚠️ reports a 403 as forbidden and a genuine failure as unavailable, in one response', async () => {
    const timeline = await timelineWith({
      relatedEvents: () => Promise.reject(new UpstreamForbiddenError('events')),
      relatedEvidence: () => Promise.reject(new Error('ECONNREFUSED')),
      relatedAutomation: UnavailableTimelineSources.relatedAutomation,
    });

    const byReason = Object.fromEntries(timeline.gaps.map((gap) => [gap.source, gap.reason]));
    expect(byReason['events']).toBe('forbidden');
    expect(byReason['evidence']).toBe('unavailable');
    /* Unchanged from P-5.1: a source nobody asked for is still `not-requested`, not a failure. */
    expect(byReason['notify']).toBe('not-requested');
  });

  it('still returns the incident’s own entries when every join fails', async () => {
    const timeline = await timelineWith({
      relatedEvents: () => Promise.reject(new UpstreamForbiddenError('events')),
      relatedEvidence: () => Promise.reject(new Error('down')),
      relatedAutomation: UnavailableTimelineSources.relatedAutomation,
    });
    expect(timeline.entries.length).toBeGreaterThan(0);
    expect(timeline.entries.every((entry) => entry.source === 'incident')).toBe(true);
  });
});
