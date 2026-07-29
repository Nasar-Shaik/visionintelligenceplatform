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
} from '@vip/config';
import { z } from 'zod';

export interface ServiceConfig extends AppConfig {
  serviceVersion: string;
  jwt: JwtConfig;
  /** Prefix → upstream base URL, e.g. `{ identity, tenant, camera, media }`. */
  upstreams: Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const app = loadAppConfig(env, { serviceName: 'gateway', port: 8080 });
  const jwt = loadJwtConfig(env);
  const g = parseEnv(
    z.object({
      IDENTITY_URL: z.url().default('http://localhost:8080'),
      TENANT_URL: z.url().default('http://localhost:8081'),
      CAMERA_URL: z.url().default('http://localhost:8082'),
      MEDIA_URL: z.url().default('http://localhost:8083'),
      EVENTS_URL: z.url().default('http://localhost:8084'),
      RULES_URL: z.url().default('http://localhost:8086'),
      WORKFLOW_URL: z.url().default('http://localhost:8087'),
      NOTIFY_URL: z.url().default('http://localhost:8088'),
    }),
    env,
    'gateway',
  );
  const serviceVersion = env.SERVICE_VERSION ?? env.npm_package_version ?? '0.1.0';
  return {
    ...app,
    serviceVersion,
    jwt,
    upstreams: {
      identity: g.IDENTITY_URL,
      tenant: g.TENANT_URL,
      camera: g.CAMERA_URL,
      media: g.MEDIA_URL,
      events: g.EVENTS_URL,
      rules: g.RULES_URL,
      workflow: g.WORKFLOW_URL,
      notify: g.NOTIFY_URL,
    },
  };
}
