/** Shared test helpers: token minting + sample IncidentCandidate builder. */
import { signAccessToken } from '@vip/auth';
import type { IncidentCandidate } from '@vip/contracts';

export const SECRET = 'test-secret-at-least-16-chars';

export function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}

export const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

/** A well-formed incident candidate (critical, high-confidence person, in zone_1). */
export function personCandidate(overrides: Partial<IncidentCandidate> = {}): IncidentCandidate {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: 'tnt_a',
    ruleId: 'rule_1',
    ruleVersion: 1,
    ruleName: 'high-confidence person',
    severity: 'critical',
    title: 'High-confidence person',
    category: 'perception',
    triggeredBy: {
      eventId: '33333333-3333-4333-8333-333333333333',
      eventType: 'perception.person.detected',
      cameraId: 'cam_1',
      zoneId: 'zone_1',
      occurredAt: '2026-07-29T22:00:00.000Z',
    },
    matchedCount: 1,
    correlationId: 'corr-abc',
    dedupKey: 'tnt_a|rule_1|-|123',
    at: '2026-07-29T22:00:00.500Z',
    ...overrides,
  };
}
