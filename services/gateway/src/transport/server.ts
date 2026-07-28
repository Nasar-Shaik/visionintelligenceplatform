/**
 * Transport: gateway server assembly. Wires config → plugins → routes and returns the app
 * without listening (inject-testable). Edge auth is applied per-route (whoami, proxy).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics } from './plugins/observability.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerGatewayRoutes } from './routes/gateway.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  startedAt?: Date;
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
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness });
  registerMetricsRoute(app, registry);
  registerRootRoute(app, { name: config.serviceName, version: config.serviceVersion, startedAt });
  registerGatewayRoutes(app, {
    jwt: { secret: config.jwt.secret, issuer: 'identity', audience: 'vip' },
    upstreams: config.upstreams,
  });

  return { app, readiness };
}
