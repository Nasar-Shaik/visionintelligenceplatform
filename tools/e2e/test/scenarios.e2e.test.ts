/**
 * G-3.5 req #8 — Deterministic AI scenarios. Each of the nine reusable scenarios drives the real
 * spine Inference/Producer → EventEnvelope → Rule → Incident → Alert → Dashboard, and asserts:
 *  - contracts        the persisted event re-parses against the EventEnvelope contract
 *  - routing          the event reaches rules, the candidate reaches workflow, the incident reaches notify
 *  - EventEnvelope     correct canonical type + category
 *  - rule evaluation  exactly the scenario's rule fires
 *  - incident         one incident at the expected severity, traceable to the originating event
 *  - alert            one notification, delivered, traceable to the incident
 *  - dashboard        the read model (events/incidents/notifications) reflects all three
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { EventEnvelope, Incident, Notification } from '@vip/contracts';
import { PlatformHarness } from '../src/harness.js';
import { SCENARIOS, runScenario } from '../src/scenarios.js';

const TENANT = 'tnt_scn';

describe('deterministic AI scenarios (regression + demo)', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(TENANT);
  });
  afterEach(async () => {
    await h.stop();
  });

  it.each(SCENARIOS)('$title ($eventType)', async (scenario) => {
    await runScenario(h, TENANT, scenario);

    // --- dashboard read model reflects the event -------------------------------------------------
    const events = await h.events(TENANT);
    expect(events).toHaveLength(1);
    const event = events[0]!;

    // --- contracts: the persisted envelope re-parses cleanly ------------------------------------
    expect(EventEnvelope.safeParse(event).success).toBe(true);
    expect(event.type).toBe(scenario.eventType);
    expect(event.category).toBe(scenario.category);
    expect(event.correlationId).toBe(scenario.correlationId);

    // --- incident: one, expected severity, traceable to the originating event -------------------
    const incidents = await h.incidents(TENANT);
    expect(incidents).toHaveLength(1);
    const incident = incidents[0]!;
    expect(Incident.safeParse(incident).success).toBe(true);
    expect(incident.severity).toBe(scenario.severity);
    expect(incident.status).toBe('raised');
    expect(incident.triggeredBy.eventId).toBe(event.id);
    expect(incident.triggeredBy.eventType).toBe(scenario.eventType);
    expect(incident.correlationId).toBe(scenario.correlationId);

    // --- alert: one, delivered, traceable to the incident ---------------------------------------
    const notifications = await h.notifications(TENANT);
    expect(notifications).toHaveLength(1);
    const notification = notifications[0]!;
    expect(Notification.safeParse(notification).success).toBe(true);
    expect(notification.status).toBe('delivered');
    expect(notification.incidentId).toBe(incident.id);
    expect(notification.causationId).toBe(incident.id);
    expect(notification.correlationId).toBe(scenario.correlationId);

    // --- routing: the strict boundary — the runtime NEVER emits incident.* directly. Every
    //     incident subject on the bus is produced by workflow AFTER a rule candidate, never from the
    //     detection/producer entry itself.
    const subjects = h.publishedSubjects();
    expect(subjects.some((s) => s.includes('.event.'))).toBe(true);
    expect(subjects.some((s) => s.endsWith('.incident.candidate'))).toBe(true);
    expect(subjects.some((s) => s.endsWith('.incident.raised'))).toBe(true);
    expect(subjects.some((s) => s.includes('.notification.'))).toBe(true);
  });

  it('covers all nine Architect-named scenarios', () => {
    expect(SCENARIOS.map((s) => s.key).sort()).toEqual(
      [
        'camera-offline',
        'fight-detected',
        'fire-warehouse',
        'loitering',
        'person-entrance',
        'ppe-violation',
        'queue-threshold',
        'smoke-server-room',
        'theft-suspected',
      ].sort(),
    );
  });
});
