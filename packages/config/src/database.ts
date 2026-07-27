/** Database (MongoDB) configuration group. */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface DatabaseConfig {
  uri: string;
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const c = parseEnv(z.object({ MONGO_URI: z.string().min(1) }), env, 'database');
  return { uri: c.MONGO_URI };
}
