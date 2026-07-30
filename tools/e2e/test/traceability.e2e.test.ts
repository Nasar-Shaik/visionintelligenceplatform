/**
 * G-3.5 req #1 (Traceability) + #2 (correlationId propagation) + the five Architect flow scenarios.
 *
 * Traceability chain proven end-to-end (an operator can answer "why did this alert fire?"):
 *
 *   EventEnvelope.id ─▶ IncidentCandidate.triggeredBy.eventId
 *   IncidentCandidate.id ─▶ Incident.source.candidateId (= Incident.causationId)
 *   Incident.id ─▶ Notification.incidentId (= Notification.causationId)
 *   correlationId ─▶ identical across Event, Candidate, Incident, Notification
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncidentCandidate } from '@vip/contracts';
import { PlatformHarness } from '../src/harness.js';
import { SCENARIOS, runScenario } from '../src/scenarios.js';

const TENANT = 'tnt_trace';

function candidateOnBus(h: PlatformHarness): IncidentCandidate {
  const msg = h.bus.published.find((m) => m.subject.endsWith('.incident.candidate'));
  if (!msg) throw new Error('no incident.candidate was published');
  return msg.data as IncidentCandidate;
}

describe('end-to-end traceability + correlationId propagation', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(TENANT);
  });
  afterEach(async () => {
    await h.stop();
  });

  it('links Event → Candidate → Incident → Notification by id and preserves correlationId', async () => {
    const fire = SCENARIOS.find((s) => s.key === 'fire-warehouse')!;
    await runScenario(h, TENANT, fire);

    const event = (await h.events(TENANT))[0]!;
    const candidate = candidateOnBus(h);
    const incident = (await h.incidents(TENANT))[0]!;
    const notification = (await h.notifications(TENANT))[0]!;

    // id reference chain — every object points back to its origin.
    expect(candidate.triggeredBy.eventId).toBe(event.id);
    expect(incident.triggeredBy.eventId).toBe(event.id);
    expect(incident.source.candidateId).toBe(candidate.id);
    expect(incident.causationId).toBe(candidate.id);
    expect(notification.incidentId).toBe(incident.id);
    expect(notification.causationId).toBe(incident.id);

    // correlationId is preserved verbatim across the whole spine (req #2).
    const corr = fire.correlationId;
    expect(event.correlationId).toBe(corr);
    expect(candidate.correlationId).toBe(corr);
    expect(incident.correlationId).toBe(corr);
    expect(notification.correlationId).toBe(corr);
  });

  it('propagates the inference correlationId from DetectionResult through to Notification', async () => {
    // The inference runtime stamps correlationId on the DetectionResult; it must survive normalisation
    // and every downstream hop unchanged (Camera→Media→Inference→Bus→Rules→Workflow→Notify).
    const person = SCENARIOS.find((s) => s.key === 'person-entrance')!;
    await runScenario(h, TENANT, person);
    const event = (await h.events(TENANT))[0]!;
    const incident = (await h.incidents(TENANT))[0]!;
    const notification = (await h.notifications(TENANT))[0]!;
    expect([event.correlationId, incident.correlationId, notification.correlationId]).toEqual([
      'corr-person',
      'corr-person',
      'corr-person',
    ]);
  });

  // --- The five Architect flow scenarios ---------------------------------------------------------

  it('Scenario 1: Camera→…→Inference→Event→Rule→Incident→Alert→Dashboard', async () => {
    await runScenario(
      h,
      TENANT,
      SCENARIOS.find((s) => s.key === 'person-entrance')!,
    );
    expect(await h.events(TENANT)).toHaveLength(1);
    expect(await h.incidents(TENANT)).toHaveLength(1);
    expect((await h.notifications(TENANT))[0]!.status).toBe('delivered');
  });

  it('Scenario 2: System Event→Rule→Incident→Alert', async () => {
    await runScenario(
      h,
      TENANT,
      SCENARIOS.find((s) => s.key === 'camera-offline')!,
    );
    const incident = (await h.incidents(TENANT))[0]!;
    expect(incident.triggeredBy.eventType).toBe('system.camera.disconnected');
    expect((await h.notifications(TENANT))[0]!.status).toBe('delivered');
  });

  it('Scenario 3: Camera Offline→System Event→Rule→Alert', async () => {
    await runScenario(
      h,
      TENANT,
      SCENARIOS.find((s) => s.key === 'camera-offline')!,
    );
    const notification = (await h.notifications(TENANT))[0]!;
    expect(notification.severity).toBe('high');
    expect(notification.correlationId).toBe('corr-camoff');
  });

  it('Scenario 4: Person Detection→Event→Rule→Incident→Notification', async () => {
    await runScenario(
      h,
      TENANT,
      SCENARIOS.find((s) => s.key === 'person-entrance')!,
    );
    const incident = (await h.incidents(TENANT))[0]!;
    const notification = (await h.notifications(TENANT))[0]!;
    expect(notification.incidentId).toBe(incident.id);
  });

  it('Scenario 5: Fire Detection→High Priority Incident→Alert', async () => {
    await runScenario(
      h,
      TENANT,
      SCENARIOS.find((s) => s.key === 'fire-warehouse')!,
    );
    const incident = (await h.incidents(TENANT))[0]!;
    expect(incident.severity).toBe('critical');
    expect((await h.notifications(TENANT))[0]!.status).toBe('delivered');
  });
});
