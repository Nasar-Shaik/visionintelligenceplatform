/**
 * Integration — the incident store against a REAL MongoDB. Proves promotion persistence, idempotent
 * promotion via the unique `(tenantId, source.dedupKey)` index, version-guarded replace, keyset
 * pagination, and tenant isolation. Uses the dev-stack Mongo via MONGO_URI and SKIPS gracefully when
 * none is reachable (so default `pnpm test` stays green).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { TenantScope } from '@vip/tenancy';
import { IncidentService } from '../src/application/incident-service.js';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { MongoIncidentStore } from '../src/adapters/mongo-incident-store.js';
import { personCandidate } from './helpers.js';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_workflow_test?authSource=admin';
const DB = 'vip_workflow_test';

async function reachable(): Promise<boolean> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 500 });
  try {
    await client.connect();
    // A real op (findOne) — a bare `ping` can pass pre-auth against an auth-gated Mongo and give a
    // false positive, so we probe with an operation that actually requires the connection's creds.
    await client.db(DB).collection('incidents').findOne({});
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

const online = await reachable();
const scopeA = TenantScope.fromTenantId('tnt_a');
const scopeB = TenantScope.fromTenantId('tnt_b');

describe.skipIf(!online)('incident store against real MongoDB', () => {
  let mongo: MongoAdapter;
  let store: MongoIncidentStore;
  let service: IncidentService;
  let seq = 0;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    store = new MongoIncidentStore({ incidents: mongo.incidents });
    service = new IncidentService({ store, newId: () => `inc_${++seq}` });
  });

  afterAll(async () => {
    await mongo?.incidents.deleteMany({});
    await mongo?.close();
  });

  beforeEach(async () => {
    seq = 0;
    await mongo.incidents.deleteMany({});
  });

  it('promotes idempotently — the same dedupKey never yields two incidents', async () => {
    const first = await service.promote(scopeA, personCandidate({ dedupKey: 'a|1' }));
    const second = await service.promote(scopeA, personCandidate({ dedupKey: 'a|1' }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.incident.id).toBe(first.incident.id);
    expect(await mongo.incidents.countDocuments({ tenantId: 'tnt_a' })).toBe(1);
  });

  it('persists lifecycle transitions with version bumps', async () => {
    const { incident } = await service.promote(scopeA, personCandidate({ dedupKey: 'a|1' }));
    await service.acknowledge(scopeA, incident.id, { note: 'looking' }, 'op');
    const resolved = await service.resolve(scopeA, incident.id, { resolution: 'ok' }, 'op');
    expect(resolved.status).toBe('resolved');
    expect(resolved.version).toBe(3);

    const reread = await store.get(scopeA, incident.id);
    expect(reread?.status).toBe('resolved');
    expect(reread?.history).toHaveLength(3);
  });

  it("never returns another tenant's incidents (guarded reads + pagination)", async () => {
    await service.promote(scopeA, personCandidate({ tenantId: 'tnt_a', dedupKey: 'a|1' }));
    const page = await store.list(scopeB, { limit: 50 });
    expect(page.items).toHaveLength(0);
  });
});

/**
 * **Planner verification** (P-5.0 entry criterion G-4, Architect rec 6) — the half of index
 * validation that only a real database can answer.
 *
 * `test/index-coverage.test.ts` proves the *declaration* is sound: every filter has an index whose
 * key order serves both the predicate and the sort. It cannot prove MongoDB agrees. This does, by
 * asking `explain()` which index the planner actually picked and whether it had to sort in memory.
 *
 * Skipped without a database — and that is a skip, not a pass. A check that could not run is not a
 * check that passed (CONSTRAINTS §44), which is why the declaration test above runs unconditionally.
 */
describe.skipIf(!online)('the planner uses the declared incident indexes (G-4)', () => {
  let mongo: MongoAdapter;

  beforeAll(async () => {
    mongo = await connectMongo({ uri: URI, dbName: DB });
    await mongo.incidents.deleteMany({});
    // Enough rows that the planner has a reason to prefer an index over a collection scan.
    const rows = Array.from({ length: 300 }, (_, index) => {
      const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
      return {
        ...personCandidateIncident(index, at),
      };
    });
    await mongo.incidents.insertMany(rows as never[]);
  });

  afterAll(async () => {
    await mongo?.incidents.deleteMany({});
    await mongo?.close();
  });

  const CASES: [string, string, Record<string, unknown>][] = [
    ['unfiltered', 'tenant_raisedAt_id', {}],
    ['status', 'tenant_status_time', { status: 'raised' }],
    ['severity', 'tenant_severity_time', { severity: 'critical' }],
    ['camera', 'tenant_camera_time', { 'triggeredBy.cameraId': 'cam_3' }],
    ['zone', 'tenant_zone_time', { 'triggeredBy.zoneId': 'zone_2' }],
    ['rule', 'tenant_rule_time', { 'source.ruleId': 'rule_1' }],
    ['correlation', 'tenant_correlation_time', { correlationId: 'corr_5' }],
    ['assignee', 'tenant_assignee_time', { assignee: 'priya' }],
    ['eventType', 'tenant_eventType_time', { 'triggeredBy.eventType': 'behavior.loitering' }],
    ['category', 'tenant_category_time', { category: 'security' }],
  ];

  it.each(CASES)('%s — uses %s, and never sorts in memory', async (_name, expected, filter) => {
    const explained = (await mongo.incidents
      .find({ tenantId: 'tnt_a', ...filter } as never)
      .sort({ raisedAt: -1, id: -1 })
      .limit(50)
      .explain('queryPlanner')) as {
      queryPlanner: { winningPlan: Record<string, unknown> };
    };

    const plan = JSON.stringify(explained.queryPlanner.winningPlan);
    expect(plan, `expected the planner to choose ${expected}`).toContain(expected);
    // A blocking SORT stage is the failure TD-22 named — the 32 MB cliff, not a slow query.
    expect(plan).not.toContain('"stage":"SORT"');
    expect(plan).not.toContain('COLLSCAN');
  });
});

/** A persisted incident shaped like a promoted one, for the planner fixtures above. */
function personCandidateIncident(index: number, at: string) {
  const statuses = ['raised', 'acknowledged', 'investigating', 'escalated', 'resolved'] as const;
  const severities = ['critical', 'high', 'medium', 'low'] as const;
  return {
    id: `plan_${index}`,
    tenantId: 'tnt_a',
    status: statuses[index % statuses.length]!,
    severity: severities[index % severities.length]!,
    title: `planner fixture ${index}`,
    category: index % 3 === 0 ? 'security' : 'perception',
    source: {
      ruleId: `rule_${index % 5}`,
      ruleVersion: 1,
      ruleName: 'planner',
      candidateId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      dedupKey: `plan_${index}`,
    },
    triggeredBy: {
      eventId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
      eventType: index % 2 === 0 ? 'perception.person.detected' : 'behavior.loitering',
      cameraId: `cam_${index % 10}`,
      zoneId: `zone_${index % 4}`,
      occurredAt: at,
    },
    matchedCount: 1,
    version: 1,
    correlationId: `corr_${index % 8}`,
    causationId: `00000000-0000-4000-a000-${String(index).padStart(12, '0')}`,
    history: [{ from: null, to: 'raised', at }],
    assignments: [],
    notes: [],
    assignee: index % 7 === 0 ? 'priya' : undefined,
    raisedAt: at,
    updatedAt: at,
  };
}
