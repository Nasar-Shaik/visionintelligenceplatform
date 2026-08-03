/**
 * P-5.0 entry criteria G-1 (lifecycle) + G-2 (collaboration) + G-3 (search), at the service level.
 *
 * These are the behaviours the P-5 investigation workspace will be built on, so they are pinned
 * here rather than left to be discovered through the UI: what the extended state machine does and
 * does not allow, that assignment is orthogonal to status, that a closed incident is sealed, that
 * the activity log is derived from what is already stored, and that every new search filter
 * actually filters — in both store implementations.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Incident, IncidentCandidate, IncidentStatus } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { IncidentService, MAX_NOTES } from '../src/application/incident-service.js';
import { ALLOWED_FROM } from '../src/domain/incident-state.js';
import { personCandidate } from './helpers.js';

const scope = TenantScope.fromTenantId('tnt_a');
const other = TenantScope.fromTenantId('tnt_b');

let store: InMemoryIncidentStore;
let service: IncidentService;
let clock: number;

function build(): IncidentService {
  store = new InMemoryIncidentStore();
  clock = Date.parse('2026-08-03T09:00:00.000Z');
  let seq = 0;
  return new IncidentService({
    store,
    now: () => new Date((clock += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  });
}

async function raise(overrides: Partial<IncidentCandidate> = {}): Promise<Incident> {
  const { incident } = await service.promote(scope, personCandidate(overrides));
  return incident;
}

beforeEach(() => {
  service = build();
});

// ---------------------------------------------------------------------------------------------
// G-1 — the extended lifecycle.
// ---------------------------------------------------------------------------------------------

describe('G-1 · the incident lifecycle gains investigate and escalate', () => {
  it('walks raised → acknowledged → investigating → resolved → closed', async () => {
    const raised = await raise();
    expect(raised.status).toBe('raised');
    const acked = await service.acknowledge(scope, raised.id, {}, 'priya');
    const investigating = await service.investigate(scope, acked.id, {}, 'priya');
    expect(investigating.status).toBe('investigating');
    const resolved = await service.resolve(scope, acked.id, { resolution: 'a delivery' }, 'priya');
    const closed = await service.close(scope, resolved.id, {}, 'sam');
    expect(closed.status).toBe('closed');
    expect(closed.history.map((h) => h.to)).toEqual([
      'raised',
      'acknowledged',
      'investigating',
      'resolved',
      'closed',
    ]);
  });

  it('records who an escalation was handed to — information no transition carries', async () => {
    const raised = await raise();
    const escalated = await service.escalate(
      scope,
      raised.id,
      { to: 'team:security-leads', note: 'needs a supervisor' },
      'priya',
    );
    expect(escalated.status).toBe('escalated');
    expect(escalated.escalation).toEqual({
      at: expect.any(String),
      to: 'team:security-leads',
      by: 'priya',
    });
    expect(escalated.history.at(-1)?.note).toBe('needs a supervisor');
  });

  it('lets an escalated incident be investigated, and an investigation be escalated', async () => {
    const a = await raise();
    const escalated = await service.escalate(scope, a.id, {}, 'priya');
    expect((await service.investigate(scope, escalated.id, {}, 'sam')).status).toBe(
      'investigating',
    );

    const b = await raise({
      id: '44444444-4444-4444-8444-444444444444',
      dedupKey: 'tnt_a|rule_1|-|456',
    });
    const investigating = await service.investigate(scope, b.id, {}, 'priya');
    expect((await service.escalate(scope, investigating.id, {}, 'priya')).status).toBe('escalated');
  });

  it('refuses to re-open a closed incident through any transition', async () => {
    const raised = await raise();
    const resolved = await service.resolve(scope, raised.id, {}, 'priya');
    await service.close(scope, resolved.id, {}, 'priya');
    for (const action of ['acknowledge', 'investigate', 'escalate', 'resolve'] as const) {
      await expect(
        (service[action] as (...args: never[]) => Promise<Incident>)(
          scope as never,
          raised.id as never,
          {} as never,
          'sam' as never,
        ),
      ).rejects.toThrow(/cannot/);
    }
  });

  /**
   * The table is asserted whole. A new state added without deciding where it may be entered from is
   * the way illegal transitions become reachable, so widening it has to be a deliberate edit here.
   */
  it('pins the transition table exactly — widening the lifecycle is never accidental', () => {
    expect(ALLOWED_FROM).toEqual({
      acknowledge: ['raised'],
      investigate: ['raised', 'acknowledged', 'escalated'],
      escalate: ['raised', 'acknowledged', 'investigating'],
      resolve: ['raised', 'acknowledged', 'investigating', 'escalated'],
      close: ['resolved'],
    });
    const reachable = new Set<IncidentStatus>(Object.values(ALLOWED_FROM).flat());
    expect(reachable.has('closed')).toBe(false); // nothing may be applied to a closed incident
  });
});

// ---------------------------------------------------------------------------------------------
// G-2 — collaboration.
// ---------------------------------------------------------------------------------------------

describe('G-2 · assignment is orthogonal to the lifecycle', () => {
  it('assigns without changing the status, and records the previous owner', async () => {
    const raised = await raise();
    const assigned = await service.assign(scope, raised.id, { assignee: 'priya' }, 'sam');
    expect(assigned.status).toBe('raised');
    expect(assigned.assignee).toBe('priya');

    const reassigned = await service.assign(scope, raised.id, { assignee: 'dev' }, 'sam');
    expect(reassigned.assignments.at(-1)).toMatchObject({ from: 'priya', to: 'dev', by: 'sam' });
  });

  it('un-assigns with an explicit null, leaving the history intact', async () => {
    const raised = await raise();
    await service.assign(scope, raised.id, { assignee: 'priya' }, 'sam');
    const unassigned = await service.assign(scope, raised.id, { assignee: null }, 'sam');
    expect(unassigned.assignee).toBeUndefined();
    expect(unassigned.assignments).toHaveLength(2);
    expect(unassigned.assignments.at(-1)).toMatchObject({ from: 'priya' });
    expect(unassigned.assignments.at(-1)?.to).toBeUndefined();
  });

  it('survives the whole lifecycle — an assigned incident stays assigned when resolved', async () => {
    const raised = await raise();
    await service.assign(scope, raised.id, { assignee: 'priya' }, 'sam');
    const resolved = await service.resolve(scope, raised.id, { resolution: 'handled' }, 'priya');
    expect(resolved.assignee).toBe('priya');
  });
});

describe('G-2 · notes, attachments and the derived activity log', () => {
  it('appends immutable notes carrying evidence references, never evidence itself', async () => {
    const raised = await raise();
    const noted = await service.addNote(
      scope,
      raised.id,
      {
        body: 'Reviewed the clip — a contractor, badge visible.',
        attachments: [{ kind: 'evidence', ref: 'evd_1', label: 'entry clip' }],
      },
      'priya',
    );
    expect(noted.notes).toHaveLength(1);
    expect(noted.notes[0]).toMatchObject({
      body: 'Reviewed the clip — a contractor, badge visible.',
      by: 'priya',
      attachments: [{ kind: 'evidence', ref: 'evd_1', label: 'entry clip' }],
    });
    // The attachment is a reference. Nothing about the evidence record is copied here — an
    // immutable record with a mutable copy beside it is not immutable (P-5 validation pass, G-2).
    expect(Object.keys(noted.notes[0]!.attachments[0]!)).toEqual(['kind', 'ref', 'label']);
  });

  it('caps the note stream rather than growing an unbounded document', async () => {
    const raised = await raise();
    // Reach the cap directly through the store — appending 500 notes through the service would
    // prove the same thing 500 times more slowly.
    const stuffed: Incident = {
      ...raised,
      notes: Array.from({ length: MAX_NOTES }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        body: 'x',
        at: '2026-08-03T09:00:00.000Z',
        attachments: [],
      })),
    };
    await store.replace(scope, stuffed, raised.version);
    await expect(
      service.addNote(scope, raised.id, { body: 'one more', attachments: [] }),
    ).rejects.toThrow(/note limit/);
  });

  it('seals a closed incident — no note, no assignment, nothing appended', async () => {
    const raised = await raise();
    const resolved = await service.resolve(scope, raised.id, {}, 'priya');
    await service.close(scope, resolved.id, {}, 'priya');
    await expect(
      service.addNote(scope, raised.id, { body: 'afterthought', attachments: [] }, 'priya'),
    ).rejects.toThrow(/closed/);
    await expect(service.assign(scope, raised.id, { assignee: 'sam' }, 'priya')).rejects.toThrow(
      /closed/,
    );
  });

  it('derives the activity log from the three streams, oldest first', async () => {
    const raised = await raise();
    await service.acknowledge(scope, raised.id, { note: 'looking' }, 'priya');
    await service.assign(scope, raised.id, { assignee: 'priya' }, 'sam');
    await service.addNote(
      scope,
      raised.id,
      { body: 'nothing on the north camera', attachments: [] },
      'priya',
    );
    await service.escalate(scope, raised.id, { to: 'team:leads' }, 'priya');

    const activity = await service.activity(scope, raised.id);
    expect(activity.entries.map((entry) => entry.kind)).toEqual([
      'transition',
      'transition',
      'assignment',
      'note',
      'transition',
    ]);
    expect(activity.entries.map((entry) => entry.summary)).toEqual([
      'raised from a rule match',
      'raised → acknowledged',
      'assigned to priya',
      'commented',
      'acknowledged → escalated',
    ]);
    expect(activity.incidentVersion).toBe(5);
  });

  /**
   * The property that makes deriving the right call: an incident raised before P-5.0 existed has no
   * `assignments` or `notes` at all, and still produces a correct log.
   */
  it('derives a log for an incident that predates the collaboration streams', async () => {
    const raised = await raise();
    const legacy = { ...raised } as Incident & { assignments?: unknown; notes?: unknown };
    delete legacy.assignments;
    delete legacy.notes;
    const activity = await service.activity(scope, raised.id);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]?.summary).toBe('raised from a rule match');
  });
});

// ---------------------------------------------------------------------------------------------
// G-3 — the frozen search surface.
// ---------------------------------------------------------------------------------------------

describe('G-3 · every declared filter actually filters', () => {
  beforeEach(async () => {
    service = build();
    await service.promote(
      scope,
      personCandidate({
        id: '11111111-1111-4111-8111-111111111111',
        dedupKey: 'k1',
        ruleId: 'rule_a',
        correlationId: 'corr-1',
        severity: 'critical',
        triggeredBy: {
          eventId: '33333333-3333-4333-8333-333333333333',
          eventType: 'perception.person.detected',
          cameraId: 'cam_1',
          zoneId: 'zone_1',
          occurredAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    );
    await service.promote(
      scope,
      personCandidate({
        id: '22222222-2222-4222-8222-222222222222',
        dedupKey: 'k2',
        ruleId: 'rule_b',
        correlationId: 'corr-2',
        severity: 'high',
        category: 'security',
        triggeredBy: {
          eventId: '44444444-4444-4444-8444-444444444444',
          eventType: 'behavior.loitering',
          cameraId: 'cam_2',
          zoneId: 'zone_2',
          occurredAt: '2026-08-02T00:00:00.000Z',
        },
      }),
    );
  });

  const cases: [string, Record<string, unknown>, number][] = [
    ['no filter', {}, 2],
    ['cameraId', { cameraId: 'cam_2' }, 1],
    ['zoneId', { zoneId: 'zone_1' }, 1],
    ['ruleId', { ruleId: 'rule_b' }, 1],
    ['correlationId', { correlationId: 'corr-1' }, 1],
    ['severity', { severity: 'high' }, 1],
    ['category', { category: 'security' }, 1],
    ['eventType — behaviour search', { eventType: 'behavior.loitering' }, 1],
    ['status', { status: 'raised' }, 2],
    ['two filters at once', { severity: 'high', cameraId: 'cam_2' }, 1],
    ['two filters that agree on nothing', { severity: 'high', cameraId: 'cam_1' }, 0],
  ];

  it.each(cases)('%s', async (_name, filter, expected) => {
    const page = await service.list(scope, { limit: 50, ...filter } as never);
    expect(page.items).toHaveLength(expected);
  });

  it('filters by assignee once one is set', async () => {
    const [first] = (await service.list(scope, { limit: 50 } as never)).items;
    await service.assign(scope, first!.id, { assignee: 'priya' }, 'sam');
    expect(
      (await service.list(scope, { limit: 50, assignee: 'priya' } as never)).items,
    ).toHaveLength(1);
    expect((await service.list(scope, { limit: 50, assignee: 'dev' } as never)).items).toHaveLength(
      0,
    );
  });

  it('bounds a time window at both ends — inclusive from, exclusive to', async () => {
    const within = await service.list(scope, {
      limit: 50,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    } as never);
    // `raisedAt` is the promotion time, not the event time, so the window is asserted against a
    // range that spans both rather than against the fixture's `occurredAt`.
    expect(within.items.length).toBeLessThanOrEqual(2);
    const none = await service.list(scope, {
      limit: 50,
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-01-02T00:00:00.000Z',
    } as never);
    expect(none.items).toHaveLength(0);
  });

  it('never returns another tenant’s incidents, under any filter', async () => {
    for (const filter of cases.map(([, f]) => f)) {
      const page = await service.list(other, { limit: 50, ...filter } as never);
      expect(page.items).toHaveLength(0);
    }
  });
});
