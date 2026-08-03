/**
 * P-5.1 findings F-2 (typed actors), F-3 (timeline join) and F-4 (SLA), at the domain and service
 * level.
 *
 * These three are the ones where the obvious implementation is quietly wrong: an actor type guessed
 * from a string, a timeline that omits an unavailable source in silence, and an SLA that reports
 * compliance against a target nobody set. Each is pinned here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Incident, IncidentCandidate, IncidentSlaPolicy } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { IncidentService } from '../src/application/incident-service.js';
import { UnavailableTimelineSources, type TimelineSources } from '../src/application/ports.js';
import { assertMayMutate, isHuman, resolveActor } from '../src/domain/incident-actor.js';
import { deriveSla, policyFor } from '../src/domain/incident-sla.js';
import { MAX_UPSTREAM_CALLS } from '../src/domain/incident-timeline.js';
import { personCandidate } from './helpers.js';

const scope = TenantScope.fromTenantId('tnt_a');

let store: InMemoryIncidentStore;
let clock: number;

function build(overrides: Partial<ConstructorParameters<typeof IncidentService>[0]> = {}) {
  store = new InMemoryIncidentStore();
  clock = Date.parse('2026-08-03T09:00:00.000Z');
  let seq = 0;
  return new IncidentService({
    store,
    now: () => new Date((clock += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    ...overrides,
  });
}

async function raise(
  service: IncidentService,
  overrides: Partial<IncidentCandidate> = {},
): Promise<Incident> {
  const { incident } = await service.promote(scope, personCandidate(overrides));
  return incident;
}

// ---------------------------------------------------------------------------------------------
// F-2 — typed actors.
// ---------------------------------------------------------------------------------------------

describe('F-2 · typed actors', () => {
  it('records an operator on every write, so a human action is identifiable as one', async () => {
    const service = build();
    const raised = await raise(service);
    const acked = await service.acknowledge(scope, raised.id, {}, 'priya');
    const assigned = await service.assign(scope, raised.id, { assignee: 'dev' }, 'priya');
    const noted = await service.addNote(
      scope,
      raised.id,
      { body: 'looked', attachments: [] },
      'priya',
    );

    expect(acked.history.at(-1)?.actor).toEqual({ kind: 'operator', id: 'priya' });
    expect(assigned.assignments.at(-1)?.actor).toEqual({ kind: 'operator', id: 'priya' });
    expect(noted.notes.at(-1)?.actor).toEqual({ kind: 'operator', id: 'priya' });
    // `by` is untouched — the contract is additive, and old consumers keep reading what they read.
    expect(acked.history.at(-1)?.by).toBe('priya');
  });

  it('records the promoter as the platform, not as a person named system', async () => {
    const raised = await raise(build());
    expect(raised.history[0]?.actor).toEqual({ kind: 'system', id: 'system' });
    expect(isHuman(raised.history[0]!.actor!)).toBe(false);
  });

  /**
   * ⚠️ The rule that makes the model honest. A pre-P-5.1 record carries `by: 'system'` and nothing
   * else. Typing it as `system` would be a guess that is indistinguishable from a fact — and a
   * person named system is a perfectly ordinary account name.
   */
  it('resolves a record written before typing to `unknown`, never a guess', () => {
    expect(resolveActor(undefined, 'system')).toEqual({ kind: 'unknown', id: 'system' });
    expect(resolveActor(undefined, 'priya')).toEqual({ kind: 'unknown', id: 'priya' });
    expect(resolveActor(undefined, undefined)).toEqual({ kind: 'unknown', id: 'unknown' });
  });

  it('prefers a stored type over the legacy string when both are present', () => {
    expect(resolveActor({ kind: 'automation', id: 'nightly' }, 'nightly')).toEqual({
      kind: 'automation',
      id: 'nightly',
    });
  });

  /**
   * ⚠️ The AI boundary's second lock. The permission catalog is the first — no role grants a machine
   * principal a write permission. This one stops an AI actor being written into an immutable audit
   * trail even if the first is ever misconfigured.
   */
  it('refuses an ai-advisor on any state-changing path', async () => {
    expect(() => assertMayMutate({ kind: 'ai-advisor', id: 'gpt' })).toThrow(/may not change/);
    expect(() => assertMayMutate({ kind: 'operator', id: 'priya' })).not.toThrow();

    const service = build();
    const raised = await raise(service);
    await expect(
      service.acknowledge(scope, raised.id, {}, { kind: 'ai-advisor', id: 'gpt' }),
    ).rejects.toThrow(/may not change/);
    await expect(
      service.addNote(
        scope,
        raised.id,
        { body: 'x', attachments: [] },
        { kind: 'ai-advisor', id: 'gpt' },
      ),
    ).rejects.toThrow(/may not change/);
  });

  it('accepts an automation or an integration as a first-class actor', async () => {
    const service = build();
    const raised = await raise(service);
    const acked = await service.acknowledge(
      scope,
      raised.id,
      {},
      {
        kind: 'automation',
        id: 'auto-ack-policy',
      },
    );
    expect(acked.history.at(-1)?.actor?.kind).toBe('automation');
  });
});

// ---------------------------------------------------------------------------------------------
// F-3 — the timeline join.
// ---------------------------------------------------------------------------------------------

describe('F-3 · the timeline join', () => {
  it('returns the incident’s own streams with no upstream calls when nothing is included', async () => {
    const service = build();
    const raised = await raise(service);
    await service.addNote(scope, raised.id, { body: 'a note', attachments: [] }, 'priya');

    const timeline = await service.timeline(scope, raised.id);
    expect(timeline.entries.map((e) => e.kind)).toEqual(['raised', 'note']);
    // Every un-requested source is reported as such — "nobody asked" and "there is nothing" differ.
    expect(timeline.gaps.map((g) => `${g.source}:${g.reason}`)).toEqual([
      'events:not-requested',
      'evidence:not-requested',
      'notify:not-requested',
    ]);
  });

  /**
   * ⚠️ The property the whole design exists for. An unreachable upstream must not fail the read and
   * must not vanish from it: a timeline that quietly omits the events asserts the events did not
   * happen.
   */
  it('degrades an unavailable source to a named gap, and still returns what it has', async () => {
    const service = build({ sources: UnavailableTimelineSources });
    const raised = await raise(service);

    const timeline = await service.timeline(scope, raised.id, ['events', 'evidence']);
    expect(timeline.entries).toHaveLength(1); // the `raised` entry survives
    const unavailable = timeline.gaps.filter((g) => g.reason === 'unavailable');
    expect(unavailable.map((g) => g.source).sort()).toEqual(['events', 'evidence']);
    expect(unavailable[0]?.detail).toMatch(/not configured/);
  });

  it('makes at most one call per requested source — never one per entry', async () => {
    const relatedEvents = vi.fn().mockResolvedValue({ items: [], truncated: false });
    const relatedEvidence = vi.fn().mockResolvedValue({ items: [], truncated: false });
    const relatedAutomation = vi.fn().mockResolvedValue({ items: [], truncated: false });
    const sources: TimelineSources = { relatedEvents, relatedEvidence, relatedAutomation };

    const service = build({ sources });
    const raised = await raise(service);
    for (let i = 0; i < 5; i += 1) {
      await service.addNote(scope, raised.id, { body: `note ${i}`, attachments: [] }, 'priya');
    }

    await service.timeline(scope, raised.id, ['events', 'evidence', 'notify']);
    const calls =
      relatedEvents.mock.calls.length +
      relatedEvidence.mock.calls.length +
      relatedAutomation.mock.calls.length;
    expect(calls).toBe(MAX_UPSTREAM_CALLS);
  });

  it('merges upstream entries in time order and marks their source', async () => {
    const sources: TimelineSources = {
      relatedEvents: async () => ({
        items: [
          {
            id: 'evt_1',
            type: 'perception.person.detected',
            occurredAt: '2026-08-03T08:59:00.000Z',
            cameraId: 'cam_1',
          },
        ],
        truncated: false,
      }),
      relatedEvidence: async () => ({
        items: [{ id: 'evd_1', kind: 'clip', capturedAt: '2026-08-03T08:59:30.000Z' }],
        truncated: false,
      }),
      relatedAutomation: UnavailableTimelineSources.relatedAutomation,
    };
    const service = build({ sources });
    const raised = await raise(service);

    const timeline = await service.timeline(scope, raised.id, ['events', 'evidence']);
    expect(timeline.entries.map((e) => `${e.source}:${e.kind}`)).toEqual([
      'events:event',
      'evidence:attachment',
      'incident:raised',
    ]);
    expect(timeline.entries[0]?.eventId).toBe('evt_1');
    expect(timeline.entries[1]?.evidenceId).toBe('evd_1');
  });

  it('reports truncation rather than silently showing a partial list as complete', async () => {
    const sources: TimelineSources = {
      relatedEvents: async () => ({ items: [], truncated: true }),
      relatedEvidence: UnavailableTimelineSources.relatedEvidence,
      relatedAutomation: UnavailableTimelineSources.relatedAutomation,
    };
    const service = build({ sources });
    const raised = await raise(service);
    const timeline = await service.timeline(scope, raised.id, ['events']);
    expect(timeline.gaps.find((g) => g.reason === 'truncated')?.source).toBe('events');
  });

  /** A hanging upstream must not turn a bounded read into an unbounded one. */
  it('abandons an upstream that does not answer, and reports it as a gap', async () => {
    const sources: TimelineSources = {
      relatedEvents: () => new Promise(() => {}), // never settles
      relatedEvidence: UnavailableTimelineSources.relatedEvidence,
      relatedAutomation: UnavailableTimelineSources.relatedAutomation,
    };
    const service = build({ sources });
    const raised = await raise(service);

    vi.useFakeTimers();
    const pending = service.timeline(scope, raised.id, ['events']);
    await vi.advanceTimersByTimeAsync(2_500);
    const timeline = await pending;
    vi.useRealTimers();

    expect(timeline.gaps.find((g) => g.source === 'events')).toMatchObject({
      reason: 'unavailable',
      detail: expect.stringMatching(/did not answer/),
    });
  });

  it('renders an attachment both inside its note and as its own entry', async () => {
    const service = build();
    const raised = await raise(service);
    await service.addNote(
      scope,
      raised.id,
      { body: 'clip attached', attachments: [{ kind: 'evidence', ref: 'evd_9' }] },
      'priya',
    );
    const timeline = await service.timeline(scope, raised.id);
    expect(timeline.entries.map((e) => e.kind)).toEqual(['raised', 'note', 'attachment']);
    expect(timeline.entries.at(-1)?.evidenceId).toBe('evd_9');
  });
});

// ---------------------------------------------------------------------------------------------
// F-4 — SLA.
// ---------------------------------------------------------------------------------------------

describe('F-4 · SLA attainment', () => {
  const policy: IncidentSlaPolicy = {
    tenantId: 'tnt_a',
    severity: 'critical',
    acknowledgeWithinSeconds: 300,
    resolveWithinSeconds: 3600,
  };

  /**
   * ⚠️ The failure this whole design avoids: a dashboard reporting 98% compliance for a deployment
   * that never configured an SLA. Unmeasured and compliant must never look the same.
   */
  it('reports `unknown` with no policy — never `met`', async () => {
    const service = build();
    const raised = await raise(service);
    const status = await service.sla(scope, raised.id);
    expect(status.state).toBe('unknown');
    expect(status.policy).toBeUndefined();
    expect(status.acknowledge).toBeUndefined();
    expect(status.resolve).toBeUndefined();
  });

  it('is on-track while the clock runs and inside the target', async () => {
    const service = build({ slaPolicies: [policy] });
    const raised = await raise(service);
    const status = await service.sla(scope, raised.id);
    expect(status.state).toBe('on-track');
    expect(status.acknowledge?.breached).toBe(false);
    expect(status.acknowledge?.metAt).toBeUndefined();
  });

  it('is met once both configured clocks are satisfied inside their targets', async () => {
    const service = build({ slaPolicies: [policy] });
    const raised = await raise(service);
    await service.acknowledge(scope, raised.id, {}, 'priya');
    await service.resolve(scope, raised.id, { resolution: 'ok' }, 'priya');
    const status = await service.sla(scope, raised.id);
    expect(status.state).toBe('met');
    expect(status.acknowledge?.metAt).toBeDefined();
    expect(status.resolve?.breached).toBe(false);
  });

  it('breaches the moment the due time passes, without waiting for a transition', () => {
    const raisedAt = '2026-08-03T09:00:00.000Z';
    const incident = {
      id: 'inc_1',
      tenantId: 'tnt_a',
      severity: 'critical',
      raisedAt,
      history: [{ from: null, to: 'raised', at: raisedAt }],
    } as unknown as Incident;

    const status = deriveSla(incident, policy, new Date('2026-08-03T09:10:00.000Z'));
    expect(status.state).toBe('breached');
    expect(status.acknowledge?.breached).toBe(true);
    expect(status.acknowledge?.elapsedSeconds).toBe(600);
  });

  /**
   * An incident resolved straight from `raised` was not ignored. Reporting an acknowledge breach for
   * the fastest possible response would be a metric that punishes the behaviour it should reward.
   */
  it('counts the first move out of `raised` as attention, even when it skips ack', () => {
    const raisedAt = '2026-08-03T09:00:00.000Z';
    const incident = {
      id: 'inc_1',
      tenantId: 'tnt_a',
      severity: 'critical',
      raisedAt,
      resolvedAt: '2026-08-03T09:01:00.000Z',
      history: [
        { from: null, to: 'raised', at: raisedAt },
        { from: 'raised', to: 'resolved', at: '2026-08-03T09:01:00.000Z' },
      ],
    } as unknown as Incident;

    const status = deriveSla(incident, policy, new Date('2026-08-03T09:02:00.000Z'));
    expect(status.state).toBe('met');
    expect(status.acknowledge?.metAt).toBe('2026-08-03T09:01:00.000Z');
  });

  it('matches a policy per tenant and severity, and matches nothing otherwise', () => {
    const incident = { tenantId: 'tnt_a', severity: 'high' } as unknown as Incident;
    expect(policyFor([policy], incident)).toBeUndefined();
    expect(
      policyFor([policy], { tenantId: 'tnt_a', severity: 'critical' } as unknown as Incident),
    ).toBe(policy);
    expect(
      policyFor([policy], { tenantId: 'tnt_b', severity: 'critical' } as unknown as Incident),
    ).toBeUndefined();
  });

  /** A policy that configures neither target is a policy in name only. */
  it('reports `unknown` for a policy with no targets set', () => {
    const incident = {
      id: 'inc_1',
      tenantId: 'tnt_a',
      severity: 'critical',
      raisedAt: '2026-08-03T09:00:00.000Z',
      history: [],
    } as unknown as Incident;
    const empty: IncidentSlaPolicy = { tenantId: 'tnt_a', severity: 'critical' };
    expect(deriveSla(incident, empty, new Date()).state).toBe('unknown');
  });
});
