/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements
 * env parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version +
 * rule tunables. `jwt` verifies inbound control tokens (`/rules` CRUD); `database` is the rule store;
 * `nats` is the backbone (consume `event.persisted`, publish `incident.candidate`/`rule.matched`).
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  loadJwtConfig,
  loadNatsConfig,
  parseEnv,
  type AppConfig,
  type DatabaseConfig,
  type JwtConfig,
  type NatsConfig,
} from '@vip/config';
import { z } from 'zod';

export interface RulesTuning {
  /** Cap on how many enabled rules are evaluated per event (bounds fan-out). */
  maxRulesPerEvent: number;
  /** Dedup window (ms) for identical incident candidates (idempotent downstream). */
  candidateDedupWindowMs: number;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  database: DatabaseConfig;
  nats: NatsConfig;
  rules: RulesTuning;
  /**
   * The camera context, for validation-time scope resolution and the zone-name cache (P-8 Phase 7).
   *
   * ⚠️ `url: ''` is a valid deployment and means **unconfigured**, not broken. The service then uses
   * `unavailableCameraDirectory`, which reports `available: false` — so a camera- or zone-scoped rule
   * cannot be enabled and says exactly why, rather than going live on a check nobody ran.
   *
   * ⚠️ That was already the behaviour before this milestone and nobody had noticed, because nothing
   * wired a camera directory at all: **every camera-scoped rule in every deployment was unverifiable
   * and therefore un-enablable.** Recorded as [L-56]. Wiring this is what fixes it.
   */
  camera: { url: string; internalKey: string; catalogIntervalMs: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'rules', port: 8086 });
  const jwt = loadJwtConfig(env);
  const database = loadDatabaseConfig(env);
  const nats = loadNatsConfig(env);
  const tuning = parseEnv(
    z.object({
      RULES_MAX_PER_EVENT: z.coerce.number().int().min(1).max(10_000).default(1_000),
      RULES_CANDIDATE_DEDUP_WINDOW_MS: z.coerce
        .number()
        .int()
        .min(0)
        .max(3_600_000)
        .default(60_000),
      CAMERA_SERVICE_URL: z.string().default(''),
      INTERNAL_API_KEY: z.string().default(''),
      RULES_ZONE_CATALOG_INTERVAL_MS: z.coerce
        .number()
        .int()
        .min(1_000)
        .max(600_000)
        .default(15_000),
    }),
    env,
    'rules',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return {
    ...app,
    serviceVersion,
    jwt,
    database,
    nats,
    rules: {
      maxRulesPerEvent: tuning.RULES_MAX_PER_EVENT,
      candidateDedupWindowMs: tuning.RULES_CANDIDATE_DEDUP_WINDOW_MS,
    },
    camera: {
      /* ⚠️ Both must be present. A URL with no key would 401 on every call and report unavailable —
       * correct, but for a reason that looks like a camera-service outage rather than a missing env. */
      url: tuning.INTERNAL_API_KEY === '' ? '' : tuning.CAMERA_SERVICE_URL,
      internalKey: tuning.INTERNAL_API_KEY,
      catalogIntervalMs: tuning.RULES_ZONE_CATALOG_INTERVAL_MS,
    },
  };
}
