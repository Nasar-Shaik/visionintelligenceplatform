/**
 * JWT / token configuration group. Defined now for a single home, but **consumed from
 * P1** when the identity service issues tokens (no auth exists yet). `JWT_SECRET` has no
 * default — a token-issuing service must fail fast if it is missing.
 */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface JwtConfig {
  secret: string;
  accessTtl: string;
  refreshTtl: string;
}

export function loadJwtConfig(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  const c = parseEnv(
    z.object({
      JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
      JWT_ACCESS_TTL: z.string().min(1).default('15m'),
      JWT_REFRESH_TTL: z.string().min(1).default('7d'),
    }),
    env,
    'jwt',
  );
  return { secret: c.JWT_SECRET, accessTtl: c.JWT_ACCESS_TTL, refreshTtl: c.JWT_REFRESH_TTL };
}
