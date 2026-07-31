/**
 * Gateway configuration — app + jwt (for edge token verification) + upstream service URLs.
 * All via @vip/config (no direct `process.env` reads; ADR-0018).
 */
import {
  loadAppConfig,
  loadJwtConfig,
  parseEnv,
  type AppConfig,
  type JwtConfig,
  type NatsConfig,
} from '@vip/config';
import { z } from 'zod';

/** Real-time delivery (G-5) — CORS + StreamHub operational limits (Architect rec 4). */
export interface StreamConfig {
  /** Master switch: when false, the SSE route + backbone subscription are not mounted. */
  enabled: boolean;
  /** Allowed browser origins for CORS (the console). Empty ⇒ same-origin only. */
  allowedOrigins: string[];
  maxConnectionsPerTenant: number;
  maxQueueDepth: number;
  replayBufferSize: number;
  heartbeatIntervalMs: number;
  maxConnectionDurationMs: number;
  /** SSE `retry:` hint sent to clients (reconnect backoff, ms). */
  reconnectRetryMs: number;
}

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  /** Backbone connection (only used when `stream.enabled`). */
  nats: NatsConfig;
  stream: StreamConfig;
  /** Prefix → upstream base URL, e.g. `{ identity, tenant, camera, media }`. */
  upstreams: Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'gateway', port: 8080 });
  const jwt = loadJwtConfig(env);
  // Upstream defaults MUST match each service's default `PORT` (see services/*/src/config/env.ts)
  // so `pnpm dev:all` works with zero env config. The gateway itself owns 8080; identity is on
  // 8089 to avoid colliding with it (8085 is reserved for the Python inference runtime).
  const g = parseEnv(
    z.object({
      IDENTITY_URL: z.url().default('http://localhost:8089'),
      TENANT_URL: z.url().default('http://localhost:8081'),
      CAMERA_URL: z.url().default('http://localhost:8082'),
      MEDIA_URL: z.url().default('http://localhost:8083'),
      EVENTS_URL: z.url().default('http://localhost:8084'),
      RULES_URL: z.url().default('http://localhost:8086'),
      WORKFLOW_URL: z.url().default('http://localhost:8087'),
      NOTIFY_URL: z.url().default('http://localhost:8088'),
      EVIDENCE_URL: z.url().default('http://localhost:8090'),
      // Real-time delivery (G-5). NATS is only dialed when STREAM_ENABLED.
      NATS_URL: z.string().min(1).default('nats://localhost:4222'),
      STREAM_ENABLED: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
      CORS_ALLOWED_ORIGINS: z.string().default(''),
      STREAM_MAX_CONNECTIONS_PER_TENANT: z.coerce.number().int().positive().default(50),
      STREAM_MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(500),
      STREAM_REPLAY_BUFFER_SIZE: z.coerce.number().int().positive().default(200),
      STREAM_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
      STREAM_MAX_CONNECTION_DURATION_MS: z.coerce.number().int().positive().default(3_600_000),
      STREAM_RECONNECT_RETRY_MS: z.coerce.number().int().positive().default(3_000),
    }),
    env,
    'gateway',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  const allowedOrigins = g.CORS_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return {
    ...app,
    serviceVersion,
    jwt,
    nats: { url: g.NATS_URL },
    stream: {
      enabled: g.STREAM_ENABLED,
      allowedOrigins,
      maxConnectionsPerTenant: g.STREAM_MAX_CONNECTIONS_PER_TENANT,
      maxQueueDepth: g.STREAM_MAX_QUEUE_DEPTH,
      replayBufferSize: g.STREAM_REPLAY_BUFFER_SIZE,
      heartbeatIntervalMs: g.STREAM_HEARTBEAT_INTERVAL_MS,
      maxConnectionDurationMs: g.STREAM_MAX_CONNECTION_DURATION_MS,
      reconnectRetryMs: g.STREAM_RECONNECT_RETRY_MS,
    },
    upstreams: {
      identity: g.IDENTITY_URL,
      tenant: g.TENANT_URL,
      camera: g.CAMERA_URL,
      media: g.MEDIA_URL,
      events: g.EVENTS_URL,
      rules: g.RULES_URL,
      workflow: g.WORKFLOW_URL,
      notify: g.NOTIFY_URL,
      evidence: g.EVIDENCE_URL,
    },
  };
}
