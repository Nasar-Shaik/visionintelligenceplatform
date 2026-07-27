/** Redis (cache/state) configuration group. */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface RedisConfig {
  url: string;
}

export function loadRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  const c = parseEnv(z.object({ REDIS_URL: z.string().min(1) }), env, 'redis');
  return { url: c.REDIS_URL };
}
