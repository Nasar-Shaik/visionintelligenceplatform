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
