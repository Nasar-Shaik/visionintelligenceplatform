import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryEventBus,
  eventSubject,
  ALL_INCIDENTS,
  ALL_RULE_MATCHES,
  type BusMessage,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import type { IncidentCandidate } from '@vip/contracts';
import { RuleEngine } from '../src/application/rule-engine.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { InMemoryRuleStateStore } from '../src/adapters/in-memory-rule-state.js';
import { RuleStatsRegistry } from '../src/application/rule-stats.js';
import { personEvent, personRuleInput } from './helpers.js';

let bus: InMemoryEventBus;
let store: InMemoryRuleStore;
let engine: RuleEngine;
const scopeA = TenantScope.fromTenantId('tnt_a');

async function startEngine(): Promise<void> {
  engine = new RuleEngine({
    bus,
    store,
    state: new InMemoryRuleStateStore(),
    maxRulesPerEvent: 100,
    candidateDedupWindowMs: 60_000,
    now: () => new Date('2026-07-29T22:00:00.500Z'),
    newId: () => 'inc_1',
  });
  await engine.start();
}

/** Collect incident.candidate + rule.matched published on the automation subjects. */
function collect(): { candidates: IncidentCandidate[]; matches: string[] } {
  const out = { candidates: [] as IncidentCandidate[], matches: [] as string[] };
  void bus.subscribe(
    { stream: 'AUTOMATION', durable: 'probe-inc', filterSubject: ALL_INCIDENTS },
    (m: BusMessage) => {
      out.candidates.push(m.json());
      m.ack();
    },
  );
  void bus.subscribe(
    { stream: 'AUTOMATION', durable: 'probe-rule', filterSubject: ALL_RULE_MATCHES },
    (m: BusMessage) => {
      out.matches.push(m.subject);
      m.ack();
    },
  );
  return out;
}

async function emit(event = personEvent()): Promise<void> {
  await bus.publish(eventSubject(event.tenantId, event.type), event);
}

beforeEach(() => {
  bus = new InMemoryEventBus();
  store = new InMemoryRuleStore({ now: () => new Date('2026-07-29T21:00:00.000Z') });
});

describe('RuleEngine — event → match → incident candidate', () => {
  it('raises an incident.candidate when an enabled rule matches (acceptance)', async () => {
    await store.create(scopeA, personRuleInput());
    const out = collect();
    await startEngine();
    await emit();

    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({
      tenantId: 'tnt_a',
      severity: 'high',
      category: 'perception',
      triggeredBy: { eventType: 'perception.person.detected', cameraId: 'cam_1', zoneId: 'zone_1' },
      matchedCount: 1,
    });
    expect(out.matches).toContain('t.tnt_a.rule.matched');
  });

  it('does not raise when the condition fails (low confidence)', async () => {
    await store.create(scopeA, personRuleInput());
    const out = collect();
    await startEngine();
    await emit(personEvent({ confidence: 0.5 }));
    expect(out.candidates).toHaveLength(0);
  });

  it('only evaluates enabled rules (draft/disabled are ignored)', async () => {
    await store.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    await store.create(scopeA, personRuleInput({ lifecycle: 'disabled' }));
    const out = collect();
    await startEngine();
    await emit();
    expect(out.candidates).toHaveLength(0);
  });

  it('never triggers on its own outputs (they land on distinct incident.*/rule.* roots)', async () => {
    // a permissive rule that would match any event on the events stream
    await store.create(
      scopeA,
      personRuleInput({ eventTypes: [], categories: [], condition: undefined }),
    );
    const out = collect();
    await startEngine();
    // publish an event, which produces a candidate + a rule.matched on the automation roots …
    await emit();
    expect(out.candidates).toHaveLength(1);
    // … and those automation messages are NOT on t.*.event.*, so the engine never re-consumes them.
    const reconsumed = bus.delivered.filter(
      (d) => d.subject.startsWith('t.tnt_a.incident') || d.subject.startsWith('t.tnt_a.rule'),
    );
    // only our test probes received them; the engine's consumer is on t.*.event.> only
    expect(reconsumed.every((d) => d.disposition === 'ack')).toBe(true);
    expect(out.candidates).toHaveLength(1); // still exactly one — no self-trigger cascade
  });

  it('enforces a windowed threshold (≥3 within 60s) before raising', async () => {
    await store.create(
      scopeA,
      personRuleInput({ window: { withinSeconds: 60, count: 3, groupBy: 'camera' } }),
    );
    const out = collect();
    await startEngine();
    await emit();
    await emit();
    expect(out.candidates).toHaveLength(0); // 2 < 3
    await emit();
    expect(out.candidates).toHaveLength(1); // 3rd crosses the threshold
    expect(out.candidates[0]!.matchedCount).toBe(3);
  });

  it('does not leak rules across tenants', async () => {
    await store.create(TenantScope.fromTenantId('tnt_b'), personRuleInput());
    const out = collect();
    await startEngine();
    await emit(personEvent({ tenantId: 'tnt_a' })); // tnt_a has no rules
    expect(out.candidates).toHaveLength(0);
  });

  it('dead-letters an invalid envelope (fail-closed)', async () => {
    const out = collect();
    await startEngine();
    await bus.publish(eventSubject('tnt_a', 'perception.person.detected'), { not: 'an envelope' });
    const consumed = bus.delivered.find((d) => d.subject.startsWith('t.tnt_a.event.perception'));
    expect(consumed?.disposition).toBe('term');
    expect(out.candidates).toHaveLength(0);
  });
});

/**
 * Per-rule counters and warm-up (P-4.1, Architect recs 3 + 5).
 *
 * These assert an **operational** property, so they go through the real engine rather than poking the
 * registry: the value of a counter is that it reflects what the hot path actually did.
 */
describe('RuleEngine — runtime statistics and warm-up', () => {
  let stats: RuleStatsRegistry;

  async function startWithStats(): Promise<void> {
    stats = new RuleStatsRegistry();
    engine = new RuleEngine({
      bus,
      store,
      state: new InMemoryRuleStateStore(),
      maxRulesPerEvent: 100,
      candidateDedupWindowMs: 60_000,
      stats,
      now: () => new Date('2026-07-29T22:00:00.500Z'),
      newId: () => 'inc_1',
    });
    await engine.start();
  }

  it('counts evaluations and matches per rule, and times what it evaluated', async () => {
    await store.create(scopeA, personRuleInput({ name: 'matches' }));
    await store.create(
      scopeA,
      personRuleInput({
        name: 'never',
        condition: { field: 'confidence', op: 'gte', value: 0.99 },
      }),
    );
    collect();
    await startWithStats();
    await emit();
    await emit();

    const byName = new Map(stats.snapshot('tnt_a').map((s) => [s.ruleName, s]));
    expect(byName.get('matches')).toMatchObject({ evaluations: 2, matches: 2, failures: 0 });
    // The distinction the platform could not previously draw: evaluated, but never matching.
    expect(byName.get('never')).toMatchObject({ evaluations: 2, matches: 0 });
    expect(byName.get('matches')?.lastMatchedAt).toBe('2026-07-29T22:00:00.500Z');
    expect(byName.get('never')?.lastMatchedAt).toBeUndefined();
    expect(byName.get('matches')?.avgEvaluationMicros).toBeGreaterThanOrEqual(0);
  });

  it('counts an event a rule’s scope rejected as an evaluation, but does not time it', async () => {
    await store.create(
      scopeA,
      personRuleInput({ scope: { nodeIds: ['on_elsewhere'], cameraIds: [] } }),
    );
    collect();
    await startWithStats();
    await emit();

    const [rule] = stats.snapshot('tnt_a');
    expect(rule).toMatchObject({ evaluations: 1, matches: 0 });
    // Never validated, so the scope is unresolved and matches nothing — no work worth timing.
    expect(rule?.avgEvaluationMicros).toBe(0);
  });

  it('records a throwing rule as a failure and keeps evaluating the rest', async () => {
    await store.create(scopeA, personRuleInput({ name: 'good', priority: 10 }));
    const bad = await store.create(scopeA, personRuleInput({ name: 'bad', priority: 900 }));
    // A condition that cannot be walked — a defect, whatever produced it.
    Object.defineProperty(await store.get(scopeA, bad.id), 'condition', {
      get() {
        throw new Error('corrupt condition');
      },
    });

    const out = collect();
    await startWithStats();
    await emit();

    const byName = new Map(stats.snapshot('tnt_a').map((s) => [s.ruleName, s]));
    expect(byName.get('bad')?.failures).toBe(1);
    // The event is not lost and the healthy rule still fires.
    expect(byName.get('good')?.matches).toBe(1);
    expect(out.candidates).toHaveLength(1);
  });

  it('warms a tenant so the first live event does not pay the compilation', async () => {
    await store.create(scopeA, personRuleInput());
    collect();
    await startWithStats();

    await engine.warm('tnt_a');
    expect(engine.cacheStats('tnt_a')).toMatchObject({ compilations: 1, rules: 1 });

    await emit();
    // The event was a hit, not a compilation — which is the whole point of warming.
    expect(engine.cacheStats('tnt_a')).toMatchObject({ compilations: 1, hits: 1 });
  });

  it('never lets a failed warm-up escape into the write that triggered it', async () => {
    const broken = {
      async listEnabled() {
        throw new Error('mongo is down');
      },
    } as unknown as typeof store;
    engine = new RuleEngine({
      bus,
      store: broken,
      state: new InMemoryRuleStateStore(),
      maxRulesPerEvent: 100,
      candidateDedupWindowMs: 60_000,
    });
    await expect(engine.warm('tnt_a')).resolves.toBeUndefined();
  });
});
