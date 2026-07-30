/**
 * G-3.5 — Failure & recovery behaviour (deliverables #5/#6, sequence-diagram §retry/recovery).
 *
 * Proven here:
 *  - Fail-closed:     a malformed event / cross-tenant capability output is DEAD-LETTERED (term), never
 *                     evaluated — it produces no incident and cannot leak across tenants.
 *  - Poison isolation a bad message does not wedge the pipeline: a subsequent valid event still flows
 *                     all the way to an alert (the system recovers on the very next message).
 *  - Degraded deliver a delivery-transport failure marks the notification `failed` (recorded, not lost)
 *                     while the incident stands — the alert outcome is durable and auditable.
 *  - Graceful no-op   a raised incident with no channels yields zero notifications and no error.
 *
 * (Transient-failure NAK→redelivery is unit-tested inside each service; the in-memory bus does not
 * redeliver, so the E2E layer asserts the term/ack dispositions and the recovery property instead.)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityOutputSubject, eventSubject } from '@vip/messaging';
import { PlatformHarness } from '../src/harness.js';
import { SCENARIOS, emitScenario, runScenario } from '../src/scenarios.js';

const TENANT = 'tnt_fail';
const person = SCENARIOS.find((s) => s.key === 'person-entrance')!;

describe('fail-closed + poison-message isolation', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(TENANT);
    await h.seedRule(TENANT, person.rule);
  });
  afterEach(async () => {
    await h.stop();
  });

  it('dead-letters a malformed event and still processes the next valid one (recovery)', async () => {
    // A garbage payload on the event subject — the Rule Engine must term it, never evaluate it.
    await h.bus.publish(eventSubject(TENANT, 'perception.person.detected'), { not: 'an-envelope' });
    expect(h.flow.some((d) => d.disposition === 'term')).toBe(true);
    expect(await h.incidents(TENANT)).toHaveLength(0);

    // The pipeline is not wedged: a valid detection now flows end-to-end.
    await emitScenario(h, TENANT, person);
    expect(await h.incidents(TENANT)).toHaveLength(1);
    expect((await h.notifications(TENANT))[0]!.status).toBe('delivered');
  });

  it('dead-letters a cross-tenant capability output (subject/body tenant mismatch)', async () => {
    // A DetectionResult whose body says tnt_fail, published on ANOTHER tenant's subject → term.
    const foreign = person.makeEntry(TENANT); // body.tenantId = TENANT
    await h.bus.publish(
      capabilityOutputSubject('tnt_other', 'perception.person-detection'),
      foreign,
    );
    expect(h.flow.some((d) => d.disposition === 'term')).toBe(true);
    // No event persisted for EITHER tenant — the cross-tenant message never became an event.
    expect(await h.events(TENANT)).toHaveLength(0);
    expect(await h.events('tnt_other')).toHaveLength(0);
    expect(await h.incidents(TENANT)).toHaveLength(0);
  });
});

describe('degraded delivery + graceful no-op', () => {
  it('records a delivery failure without losing the incident', async () => {
    // A webhook sender that always fails the transport.
    const h = new PlatformHarness({
      webhookSender: {
        async send() {
          return { ok: false, error: 'unreachable' };
        },
      },
    });
    await h.start();
    await h.seedChannel(TENANT, {
      name: 'siem',
      type: 'webhook',
      config: { url: 'https://x.invalid/h' },
      enabled: true,
    });
    await runScenario(h, TENANT, person);

    // The incident stands; the notification is recorded as failed (durable outcome, not a crash).
    expect(await h.incidents(TENANT)).toHaveLength(1);
    const notes = await h.notifications(TENANT);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.status).toBe('failed');
    await h.stop();
  });

  it('a raised incident with no channels produces zero notifications and no error', async () => {
    const h = new PlatformHarness();
    await h.start();
    // No seedChannel.
    await runScenario(h, TENANT, person);
    expect(await h.incidents(TENANT)).toHaveLength(1);
    expect(await h.notifications(TENANT)).toHaveLength(0);
    await h.stop();
  });
});
