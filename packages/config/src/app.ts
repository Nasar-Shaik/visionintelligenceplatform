/** App/runtime configuration group — the process identity and logging level. */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppConfig {
  nodeEnv: NodeEnv;
  serviceName: string;
  host: string;
  port: number;
  logLevel: LogLevel;
}

export interface AppDefaults {
  /** Each service supplies its own name/port default so it needn't re-parse env. */
  serviceName?: string;
  port?: number;
}

export function loadAppConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: AppDefaults = {},
): AppConfig {
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SERVICE_NAME: z
      .string()
      .min(1)
      .default(defaults.serviceName ?? 'service'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(defaults.port ?? 8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  });
  const c = parseEnv(schema, env, 'app');
  return {
    nodeEnv: c.NODE_ENV,
    serviceName: c.SERVICE_NAME,
    host: c.HOST,
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
  };
}
