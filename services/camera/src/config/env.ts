/**
 * Service configuration — delegates to the shared `@vip/config` groups (no service re-implements
 * env parsing; no code reads `process.env` directly, ADR-0018) and layers on the service version.
 * `jwt` verifies inbound access tokens; `crypto` supplies the secret for credential vaulting.
 * Fail-fast validation happens inside `@vip/config`.
 */
import {
  loadAppConfig,
  loadCryptoConfig,
  loadDatabaseConfig,
  loadInternalConfig,
  loadJwtConfig,
  type AppConfig,
  type CryptoConfig,
  type DatabaseConfig,
  type InternalConfig,
  type JwtConfig,
} from '@vip/config';

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  database: DatabaseConfig;
  jwt: JwtConfig;
  crypto: CryptoConfig;
  /** Shared key authenticating internal service-to-service calls (e.g. media resolving a stream). */
  internal: InternalConfig;
  /**
   * Network-discovery provider (P-1). The AI runtime exposes ONVIF discovery as a read-only
   * capability (ADR-0023); this is its base URL. **Optional on purpose** — a deployment that onboards
   * from a list of RTSP URLs is a supported deployment, and the service reports discovery as
   * unavailable rather than failing to start.
   */
  discoveryUrl?: string;
  /**
   * Rules service base URL, read ONLY for the capability matrix's `rules` fact (P-8 Phase 6 rec 1).
   * ⚠️ Empty is a valid deployment: the fact reads `unknown` rather than `false`.
   */
  rulesUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'camera', port: 8082 });
  const database = loadDatabaseConfig(env);
  const jwt = loadJwtConfig(env);
  const crypto = loadCryptoConfig(env);
  const internal = loadInternalConfig(env);
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  // Read directly rather than through a @vip/config group: it is a single optional URL used by one
  // service, and a shared group would imply a platform-wide convention that does not exist yet. If a
  // second service needs it, that is the moment to promote it (ADR-0018 governs secrets, not URLs).
  const discoveryUrl = env.CAMERA_DISCOVERY_URL?.trim();
  const rulesUrl = env.RULES_URL?.trim() ?? '';
  return {
    ...app,
    serviceVersion,
    database,
    jwt,
    crypto,
    internal,
    ...(discoveryUrl ? { discoveryUrl } : {}),
    rulesUrl,
  };
}
