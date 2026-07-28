/** Shared test helpers: a valid DetectionResult builder + access-token minting (identity iss/aud). */
import { signAccessToken } from '@vip/auth';
import type { DetectionResult } from '@vip/contracts';

export const SECRET = 'test-secret-at-least-16-chars';

export function token(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken(
    { principalId: 'usr_1', tenantId, email: 'u@acme.com', roles },
    { secret: SECRET, issuer: 'identity', audience: 'vip' },
  ).then((r) => r.token);
}

export const authHeader = (t: string) => ({ authorization: `Bearer ${t}` });

/** A well-formed capability output (person detection) for a tenant. */
export function detectionResult(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    capabilityId: 'perception.person-detection',
    capabilityVersion: '1.0.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'stub',
    model: {
      name: 'stub-detector',
      version: '1.0.0',
      task: 'object-detection',
      family: '*',
      accelerator: 'cpu',
    },
    frame: { seq: 7, capturedAt: '2026-07-28T00:00:00.000Z' },
    detections: [
      {
        label: 'person',
        confidence: 0.84,
        bbox: [0.1, 0.2, 0.3, 0.4],
        attributes: {},
        metadata: {},
      },
    ],
    inferenceMs: 12,
    correlationId: 'corr_9',
    at: '2026-07-28T00:00:00.100Z',
    ...overrides,
  };
}
