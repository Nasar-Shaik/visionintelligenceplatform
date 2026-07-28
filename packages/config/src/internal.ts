/**
 * Internal service-to-service authentication group. Some control-plane calls between services are
 * NOT user requests and don't carry a user JWT — e.g. `media` asking `camera` to resolve a stream's
 * (decrypted) credentials. In Phase 1 those calls are authenticated by a shared `INTERNAL_API_KEY`
 * (`.env` only, ADR-0018), presented as a header and compared in constant time. A per-service
 * machine principal / mTLS replaces this later (documented extension point). No default — a service
 * exposing or calling an internal endpoint must fail fast if it is missing.
 */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface InternalConfig {
  apiKey: string;
}

export function loadInternalConfig(env: NodeJS.ProcessEnv = process.env): InternalConfig {
  const c = parseEnv(
    z.object({
      INTERNAL_API_KEY: z.string().min(16, 'INTERNAL_API_KEY must be at least 16 characters'),
    }),
    env,
    'internal',
  );
  return { apiKey: c.INTERNAL_API_KEY };
}
