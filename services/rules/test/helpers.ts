/** Shared test helpers: token minting + sample EventEnvelope + sample rule input builders. */
import { signAccessToken } from '@vip/auth';
import type { CreateRuleInput, EventEnvelope } from '@vip/contracts';

export const SECRET = 'test-secret-at-least-16-chars';

export function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}

export const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

/** A well-formed persisted perception event (person detected, conf 0.9, in zone_1). */
export function personEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'perception.person.detected',
    envelopeVersion: '1.0.0',
    category: 'perception',
    schemaVersion: '1.0.0',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    zoneId: 'zone_1',
    occurredAt: '2026-07-29T22:00:00.000Z',
    ingestedAt: '2026-07-29T22:00:00.100Z',
    producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
    confidence: 0.9,
    subjects: [{ class: 'person', bbox: [0.1, 0.2, 0.3, 0.4], attributes: { color: 'red' } }],
    payload: { label: 'person' },
    evidenceRefs: [],
    priority: 'info',
    ...overrides,
  };
}

/** A rule that raises an incident on any high-confidence person detection. */
export function personRuleInput(overrides: Partial<CreateRuleInput> = {}): CreateRuleInput {
  return {
    name: 'high-confidence person',
    lifecycle: 'enabled',
    priority: 100,
    eventTypes: ['perception.person.detected'],
    categories: [],
    condition: { field: 'confidence', op: 'gte', value: 0.8 },
    severity: 'high',
    actions: [{ type: 'raise-incident' }],
    ...overrides,
  };
}
