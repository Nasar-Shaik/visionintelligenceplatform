/**
 * G-3.5 req #4 — Multi-tenant validation. The whole platform is fail-closed on tenant (Law 5): a
 * subject is rooted at t.{tenantId}, every store filters by scope, and the rule engine loads rules for
 * the event's own tenant only. Here Tenant A and Tenant B both run an IDENTICAL person rule + channel;
 * an event for A must produce zero B incidents / B alerts / B dashboard data, and B cannot read A's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { PlatformHarness } from '../src/harness.js';
import { SCENARIOS, runScenario } from '../src/scenarios.js';

const A = 'tnt_a';
const B = 'tnt_b';

describe('multi-tenant isolation', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(A);
    await h.seedChannel(B);
  });
  afterEach(async () => {
    await h.stop();
  });

  it('Tenant A events never produce Tenant B incidents, alerts, or dashboard data', async () => {
    const person = SCENARIOS.find((s) => s.key === 'person-entrance')!;
    // Both tenants have the SAME rule; only A receives the event.
    await h.seedRule(B, person.rule);
    await runScenario(h, A, person); // seeds A's rule + emits A's detection

    // A sees exactly one of each.
    expect(await h.events(A)).toHaveLength(1);
    expect(await h.incidents(A)).toHaveLength(1);
    expect(await h.notifications(A)).toHaveLength(1);

    // B sees nothing — an A event cannot cross into B despite B having an identical rule + channel.
    expect(await h.events(B)).toHaveLength(0);
    expect(await h.incidents(B)).toHaveLength(0);
    expect(await h.notifications(B)).toHaveLength(0);
  });

  it("B cannot read A's incident through B's scope (guarded read → not found)", async () => {
    const person = SCENARIOS.find((s) => s.key === 'person-entrance')!;
    await runScenario(h, A, person);
    const aIncident = (await h.incidents(A))[0]!;

    // Directly probing the store under B's scope for A's incident id returns null (fail-closed).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (h as any).incidentStore;
    expect(await store.get(TenantScope.fromTenantId(B), aIncident.id)).toBeNull();
    // And A's own scope still resolves it — isolation is directional, not lossy.
    expect(await store.get(TenantScope.fromTenantId(A), aIncident.id)).not.toBeNull();
  });

  it('two tenants receiving the same event type each get their own isolated incident', async () => {
    const fire = SCENARIOS.find((s) => s.key === 'fire-warehouse')!;
    await runScenario(h, A, fire);
    await runScenario(h, B, fire);

    const aInc = await h.incidents(A);
    const bInc = await h.incidents(B);
    expect(aInc).toHaveLength(1);
    expect(bInc).toHaveLength(1);
    expect(aInc[0]!.tenantId).toBe(A);
    expect(bInc[0]!.tenantId).toBe(B);
    expect(aInc[0]!.id).not.toBe(bInc[0]!.id);
  });
});
