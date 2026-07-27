/**
 * Typed, validated configuration (12-factor / Principle 8). Environment is the ONLY
 * config source; the service fails fast at boot if anything is missing or malformed,
 * so a misconfigured instance never serves traffic.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Logical service name — appears in logs/metrics/traces. */
  SERVICE_NAME: z.string().min(1).default('identity'),
  /** Semantic version, injected by the package manager at runtime when present. */
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Parse and validate configuration from a raw environment (defaults to `process.env`).
 * @throws ZodError with all offending keys if validation fails — caught at bootstrap.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvSchema.parse({
    ...env,
    // npm/pnpm expose the manifest version here; fall back to the schema default.
    SERVICE_VERSION: env.SERVICE_VERSION ?? env.npm_package_version,
  });
}
