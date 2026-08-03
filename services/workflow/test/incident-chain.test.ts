/**
 * P-5.3 — the evidence chain.
 *
 * The chain's value is entirely in **which** of six reasons a link is broken for. A diagram whose
 * gaps all look the same tells a customer the platform lost something; these tests pin the
 * distinctions that stop it doing that.
 */
import { describe, expect, it } from 'vitest';
import { EvidenceChain } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { IncidentService } from '../src/application/incident-service.js';
import { UnavailableTimelineSources, type TimelineSources } from '../src/application/ports.js';
import { UpstreamForbiddenError } from '../src/adapters/http-timeline-sources.js';
import { buildChain } from '../src/domain/incident-chain.js';
import { personCandidate } from './helpers.js';

const scope = TenantScope.fromTenantId('tnt_a');
const caller = { authorization: 'Bearer t' };

function build(sources?: TimelineSources): IncidentService {
  let clock = Date.parse('2026-08-03T09:00:00.000Z');
  let seq = 0;
  return new IncidentService({
    store: new InMemoryIncidentStore(),
    now: () => new Date((clock += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    ...(sources ? { sources } : {}),
  });
}

const noEvidence: TimelineSources = {
  ...UnavailableTimelineSources,
  relatedEvidence: async () => ({ items: [], truncated: false }),
};

describe('the chain resolves what the incident already carries', () => {
  it('resolves camera, detection, rule and incident from the document — no upstream call', async () => {
    const service = build(noEvidence);
    const { incident } = await service.promote(scope, personCandidate());
    const chain = await service.chain(scope, incident.id, caller);

    expect(() => EvidenceChain.parse(chain)).not.toThrow();
    const byStage = Object.fromEntries(chain.links.map((link) => [link.stage, link]));
    expect(byStage['camera']?.resolved).toBe(true);
    expect(byStage['camera']?.ref).toBe('cam_1');
    expect(byStage['detection']?.resolved).toBe(true);
    expect(byStage['rule']?.resolved).toBe(true);
    expect(byStage['rule']?.label).toContain('v1');
    expect(byStage['incident']?.resolved).toBe(true);
  });

  it('covers all eight stages, in order, always', async () => {
    const chain = await (async () => {
      const service = build(noEvidence);
      const { incident } = await service.promote(scope, personCandidate());
      return service.chain(scope, incident.id, caller);
    })();
    expect(chain.links.map((link) => link.stage)).toEqual([
      'camera',
      'detection',
      'rule',
      'incident',
      'evidence',
      'playback',
      'export',
      'report',
    ]);
  });

  /*
   * ⚠️ Rendering seven stages and stopping would let a viewer assume the chain ends at evidence.
   * Eight, with three marked `not-built`, says a release changes it — not a support call.
   */
  it('⚠️ shows playback, export and report as not-built rather than omitting them', async () => {
    const service = build(noEvidence);
    const { incident } = await service.promote(scope, personCandidate());
    const chain = await service.chain(scope, incident.id, caller);

    for (const stage of ['playback', 'export', 'report'] as const) {
      const link = chain.links.find((entry) => entry.stage === stage);
      expect(link?.resolved).toBe(false);
      expect(link?.brokenBecause).toBe('not-built');
      expect(link?.detail).toBeTruthy();
    }
    expect(chain.complete).toBe(false);
  });
});

describe('a broken link names which of six reasons applies', () => {
  /*
   * ⚠️ The most common case in this build. The auto-capture extractor is a no-op pending the media
   * frame source (TD-15), so "no evidence" is the platform's state, not the investigation's — and
   * an operator reading "none captured" concludes something different from "capture is pending".
   */
  it('⚠️ reports absent evidence as never-produced, and says why', async () => {
    const service = build(noEvidence);
    const { incident } = await service.promote(scope, personCandidate());
    const chain = await service.chain(scope, incident.id, caller);

    const link = chain.links.find((entry) => entry.stage === 'evidence');
    expect(link?.brokenBecause).toBe('never-produced');
    expect(link?.detail).toContain('pending the media frame source');
  });

  it('⚠️ reports a permission failure as forbidden, not as an outage', async () => {
    const service = build({
      ...UnavailableTimelineSources,
      relatedEvidence: () => Promise.reject(new UpstreamForbiddenError('evidence')),
    });
    const { incident } = await service.promote(scope, personCandidate());
    const chain = await service.chain(scope, incident.id, caller);

    expect(chain.links.find((entry) => entry.stage === 'evidence')?.brokenBecause).toBe(
      'forbidden',
    );
  });

  it('reports an unreachable evidence context as unavailable', async () => {
    const service = build({
      ...UnavailableTimelineSources,
      relatedEvidence: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const { incident } = await service.promote(scope, personCandidate());
    const chain = await service.chain(scope, incident.id, caller);

    expect(chain.links.find((entry) => entry.stage === 'evidence')?.brokenBecause).toBe(
      'unavailable',
    );
  });

  /* A rule can fire on an event with no camera — a system event, an integration, a window aggregate. */
  it('treats a camera-less trigger as never-produced rather than as an error', async () => {
    const service = build(noEvidence);
    const { incident } = await service.promote(
      scope,
      personCandidate({
        triggeredBy: {
          eventId: '33333333-3333-4333-8333-333333333333',
          eventType: 'system.integration.received',
          occurredAt: '2026-07-29T22:00:00.000Z',
        },
      }),
    );
    const chain = await service.chain(scope, incident.id, caller);

    const link = chain.links.find((entry) => entry.stage === 'camera');
    expect(link?.resolved).toBe(false);
    expect(link?.brokenBecause).toBe('never-produced');
  });

  it('resolves evidence when there is some, and reports truncation in the label', async () => {
    const service = build({
      ...UnavailableTimelineSources,
      relatedEvidence: async () => ({
        items: [
          { id: 'ev_1', kind: 'snapshot', capturedAt: '2026-08-03T09:00:05.000Z' },
          { id: 'ev_2', kind: 'clip', capturedAt: '2026-08-03T09:00:06.000Z' },
        ],
        truncated: true,
      }),
    });
    const { incident } = await service.promote(scope, personCandidate());
    const chain = await service.chain(scope, incident.id, caller);

    const link = chain.links.find((entry) => entry.stage === 'evidence');
    expect(link?.resolved).toBe(true);
    expect(link?.count).toBe(2);
    expect(link?.label).toContain('truncated');
  });
});

describe('the chain never claims completeness it cannot support', () => {
  /*
   * ⚠️ `complete` is derived from the links rather than asserted, so the summary flag cannot
   * disagree with the diagram it summarises (CONSTRAINTS §46).
   */
  it('⚠️ derives `complete` from the links', () => {
    const now = new Date('2026-08-03T00:00:00.000Z');
    const incident = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tnt_a',
      correlationId: 'corr_1',
      title: 'x',
      matchedCount: 1,
      raisedAt: now.toISOString(),
      triggeredBy: {
        eventId: '22222222-2222-4222-8222-222222222222',
        eventType: 'perception.person.detected',
        cameraId: 'cam_1',
        occurredAt: now.toISOString(),
      },
      source: { ruleId: 'r1', ruleVersion: 1, ruleName: 'after hours' },
    } as never;

    const chain = buildChain({ incident, requested: ['evidence'], now });
    /* Three stages have no producer, so a chain can never be complete in this build. */
    expect(chain.complete).toBe(false);
    expect(chain.links.every((link) => link.resolved || link.detail !== undefined)).toBe(true);
  });
});
