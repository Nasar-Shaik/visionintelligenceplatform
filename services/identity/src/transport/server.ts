/**
 * Transport: server assembly. `buildServer` wires config → plugins → routes onto a Fastify
 * instance and returns it WITHOUT listening, so tests drive it via `app.inject()` and the
 * bootstrap (index.ts) owns network/lifecycle. Order matters: security, observability, and auth
 * decorators are registered before routes so they apply to every handler.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import type { AuthService } from '../application/auth-service.js';
import type { UserService } from '../application/user-service.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics } from './plugins/observability.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { createAuth, registerPrincipal } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/users.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  auth: AuthService;
  users: UserService;
  /** Process start time (for uptime). Injectable for deterministic tests. */
  startedAt?: Date;
  /** Pre-seeded readiness registry (adapters register their checks here). */
  readiness?: ReadinessRegistry;
}

export interface BuiltServer {
  app: FastifyInstance;
  readiness: ReadinessRegistry;
}

export async function buildServer(opts: BuildServerOptions): Promise<BuiltServer> {
  const { config } = opts;
  const startedAt = opts.startedAt ?? new Date();
  const readiness = opts.readiness ?? new ReadinessRegistry();

  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.nodeEnv === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && header.length > 0 ? header : randomUUID();
    },
    trustProxy: true,
  });

  await registerSecurity(app);
  const registry = registerMetrics(app, { serviceName: config.serviceName });
  registerTenantContext(app);
  registerPrincipal(app);
  const auth = createAuth({
    secret: config.jwt.secret,
    issuer: config.serviceName,
    audience: 'vip',
  });
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness });
  registerMetricsRoute(app, registry);
  registerRootRoute(app, { name: config.serviceName, version: config.serviceVersion, startedAt });
  registerAuthRoutes(app, { service: opts.auth, auth });
  registerUserRoutes(app, { service: opts.users, auth });

  return { app, readiness };
}
