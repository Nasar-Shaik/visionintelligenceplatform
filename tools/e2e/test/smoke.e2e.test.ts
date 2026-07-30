/**
 * Smoke test — proves the harness composes the real spine and the synchronous cascade runs:
 * one person DetectionResult → one persisted event → one raised incident → one delivered notification.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlatformHarness } from '../src/harness.js';
import { SCENARIOS, runScenario } from '../src/scenarios.js';

const TENANT = 'tnt_smoke';

describe('E2E smoke — full spine cascade', () => {
  let h: PlatformHarness;
  beforeEach(async () => {
    h = new PlatformHarness();
    await h.start();
    await h.seedChannel(TENANT);
  });
  afterEach(async () => {
    await h.stop();
  });

  it('drives person detection → event → incident → alert in one turn', async () => {
    const person = SCENARIOS.find((s) => s.key === 'person-entrance')!;
    await runScenario(h, TENANT, person);

    const events = await h.events(TENANT);
    const incidents = await h.incidents(TENANT);
    const notifications = await h.notifications(TENANT);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('perception.person.detected');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.severity).toBe('medium');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.status).toBe('delivered');
  });
});
