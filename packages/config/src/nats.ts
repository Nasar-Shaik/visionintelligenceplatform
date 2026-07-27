/** NATS/JetStream (event backbone) configuration group. */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface NatsConfig {
  url: string;
}

export function loadNatsConfig(env: NodeJS.ProcessEnv = process.env): NatsConfig {
  const c = parseEnv(z.object({ NATS_URL: z.string().min(1) }), env, 'nats');
  return { url: c.NATS_URL };
}
