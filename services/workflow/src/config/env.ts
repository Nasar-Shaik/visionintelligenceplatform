/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements env
 * parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version. `jwt`
 * verifies inbound control tokens (`/incidents` transitions); `database` is the incident store;
 * `nats` is the backbone (consume `incident.candidate`, publish `incident.*`).
 */
import {
  loadAppConfig,
  loadDatabaseConfig,
  loadJwtConfig,
  loadNatsConfig,
  type AppConfig,
  type DatabaseConfig,
  type JwtConfig,
  type NatsConfig,
} from '@vip/config';
import { IncidentSlaPolicy } from '@vip/contracts';

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  database: DatabaseConfig;
  nats: NatsConfig;
  /** Deployment-configured SLA targets (P-5.1, F-4). Empty is the honest default. */
  slaPolicies: IncidentSlaPolicy[];
}

/**
 * Parse `INCIDENT_SLA_POLICIES` — deployment-configurable SLA targets (P-5.1, F-4).
 *
 * Format: `tenant:severity:ackSeconds:resolveSeconds`, comma-separated. `-` skips a target.
 *   `tnt_a:critical:300:3600,tnt_a:high:900:14400,tnt_a:low:-:86400`
 *
 * ⚠️ **A malformed entry is dropped, not defaulted.** Inventing a target from a typo would produce
 * SLA verdicts nobody configured — and an incident reported as breaching a target that does not
 * exist is worse than one reported as `unknown`. Absent config means every incident is `unknown`,
 * which is the correct answer for a deployment that has not set targets.
 *
 * Env rather than a database because an SLA is a deployment policy, not tenant data — the same
 * reasoning as every other `@vip/config` group (ADR-0018). A per-tenant editable policy is a
 * product feature for a later slice, and this shape is what it would persist.
 */
function parseSlaPolicies(raw: string | undefined): IncidentSlaPolicy[] {
  if (!raw) return [];
  const policies: IncidentSlaPolicy[] = [];
  for (const entry of raw.split(',')) {
    const [tenantId, severity, ack, resolve] = entry.trim().split(':');
    if (!tenantId || !severity) continue;
    const candidate: Record<string, unknown> = { tenantId, severity };
    const ackSeconds = Number(ack);
    const resolveSeconds = Number(resolve);
    if (ack && ack !== '-' && Number.isInteger(ackSeconds) && ackSeconds > 0) {
      candidate['acknowledgeWithinSeconds'] = ackSeconds;
    }
    if (resolve && resolve !== '-' && Number.isInteger(resolveSeconds) && resolveSeconds > 0) {
      candidate['resolveWithinSeconds'] = resolveSeconds;
    }
    const parsed = IncidentSlaPolicy.safeParse(candidate);
    if (parsed.success) policies.push(parsed.data);
  }
  return policies;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'workflow', port: 8087 });
  const jwt = loadJwtConfig(env);
  const database = loadDatabaseConfig(env);
  const nats = loadNatsConfig(env);
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  const slaPolicies = parseSlaPolicies(env.INCIDENT_SLA_POLICIES);
  return { ...app, serviceVersion, jwt, database, nats, slaPolicies };
}
