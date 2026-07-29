/** Shared test helpers: token minting + sample raised Incident + channel input builders. */
import { signAccessToken } from '@vip/auth';
import type { CreateChannelInput, Incident } from '@vip/contracts';

export const SECRET = 'test-secret-at-least-16-chars';

export function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}

export const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

/** A well-formed raised incident (critical, high-confidence person). */
export function raisedIncident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tnt_a',
    status: 'raised',
    severity: 'critical',
    title: 'High-confidence person',
    category: 'perception',
    source: {
      ruleId: 'rule_1',
      ruleVersion: 1,
      ruleName: 'high-confidence person',
      candidateId: '22222222-2222-4222-8222-222222222222',
      dedupKey: 'tnt_a|rule_1|-|123',
    },
    triggeredBy: {
      eventId: '33333333-3333-4333-8333-333333333333',
      eventType: 'perception.person.detected',
      cameraId: 'cam_1',
      occurredAt: '2026-07-29T22:00:00.000Z',
    },
    matchedCount: 1,
    version: 1,
    correlationId: 'corr-abc',
    causationId: '22222222-2222-4222-8222-222222222222',
    history: [{ from: null, to: 'raised', at: '2026-07-29T22:00:00.500Z', by: 'system' }],
    raisedAt: '2026-07-29T22:00:00.500Z',
    updatedAt: '2026-07-29T22:00:00.500Z',
    ...overrides,
  };
}

export function inAppChannelInput(overrides: Partial<CreateChannelInput> = {}): CreateChannelInput {
  return { name: 'ops inbox', type: 'in-app', config: {}, enabled: true, ...overrides };
}

export function webhookChannelInput(
  overrides: Partial<CreateChannelInput> = {},
): CreateChannelInput {
  return {
    name: 'siem',
    type: 'webhook',
    config: { url: 'https://siem.test/hook' },
    enabled: true,
    ...overrides,
  };
}
