/**
 * Transport: server assembly. `buildServer` wires config → plugins → routes onto Fastify and returns
 * it WITHOUT listening (tests drive it via `app.inject()`; the bootstrap owns network/lifecycle + the
 * alert-engine consumer). The Prometheus registry is returned so the composition root can register
 * the alert-engine metrics on it (same registry `/metrics` serves).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import type { ChannelService } from '../application/channel-service.js';
import type { NotificationService } from '../application/notification-service.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics } from './plugins/observability.js';
import { createAuth, registerPrincipal } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerChannelRoutes } from './routes/channels.js';
import { registerNotificationRoutes } from './routes/notifications.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  channelService: ChannelService;
  notificationService: NotificationService;
  startedAt?: Date;
  readiness?: ReadinessRegistry;
}

export interface BuiltServer {
  app: FastifyInstance;
  readiness: ReadinessRegistry;
  registry: Registry;
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
  registerPrincipal(app);
  const auth = createAuth({ secret: config.jwt.secret, issuer: 'identity', audience: 'vip' });
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness });
  registerMetricsRoute(app, registry);
  registerRootRoute(app, { name: config.serviceName, version: config.serviceVersion, startedAt });
  registerChannelRoutes(app, { service: opts.channelService, auth });
  registerNotificationRoutes(app, { service: opts.notificationService, auth });

  return { app, readiness, registry };
}
