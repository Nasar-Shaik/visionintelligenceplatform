/**
 * Fail-fast validation helper. Each config group validates only its own keys against a
 * Zod schema; on failure it throws a `ConfigError` with a clear, aggregated message
 * naming the group and every offending key — so a misconfigured deployment aborts at
 * startup with an actionable error instead of failing mysteriously later.
 */
import type { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parse `env` against `schema`; throw a ConfigError listing all issues if invalid. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv,
  group: string,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid "${group}" configuration:\n${issues}`);
  }
  return result.data;
}
