/**
 * Transport: gateway server assembly. Wires config → plugins → routes and returns the app
 * without listening (inject-testable). Edge auth is applied per-route (whoami, proxy).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics } from './plugins/observability.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerGatewayRoutes } from './routes/gateway.js';
import { registerCors } from './plugins/cors.js';
import { registerStreamRoutes } from './routes/stream.js';
import { assertSystemPrefixFree, registerSystemRoutes } from './routes/system.js';
import { SystemHealthService } from '../application/system-health.js';
import type { StreamHub } from '../application/stream-hub.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  startedAt?: Date;
  readiness?: ReadinessRegistry;
  /**
   * Real-time delivery hub (G-5). Injected by the composition root (over NatsEventBus) or a test
   * (over InMemoryEventBus). When present + `config.stream.enabled`, the SSE + diagnostics routes
   * and CORS are mounted; when absent, the gateway is a pure proxy (backward compatible).
   */
  streamHub?: StreamHub | undefined;
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
  if (config.stream.enabled && config.stream.allowedOrigins.length > 0) {
    registerCors(app, { allowedOrigins: config.stream.allowedOrigins });
  }
  const registry = registerMetrics(app, { serviceName: config.serviceName });
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness });
  registerMetricsRoute(app, registry);
  registerRootRoute(app, { name: config.serviceName, version: config.serviceVersion, startedAt });

  const jwt = { secret: config.jwt.secret, issuer: 'identity', audience: 'vip' };
  if (config.stream.enabled && opts.streamHub) {
    registerStreamRoutes(app, {
      jwt,
      hub: opts.streamHub,
      reconnectRetryMs: config.stream.reconnectRetryMs,
    });
  }
  /*
   * P-6.4 — the platform's view of itself. Registered before the proxy for the same reason the
   * stream route is: `/api/system/health` is a static path beside `/api/:service/*`, and the boot
   * assertion is what stops an upstream from ever being named `system`.
   */
  assertSystemPrefixFree(config.upstreams);
  registerSystemRoutes(app, {
    jwt,
    health: new SystemHealthService({
      upstreams: config.upstreams,
      ownReadiness: async () => {
        const report = await readiness.run();
        return {
          status: report.status,
          checks: report.checks.map((c) =>
            c.detail === undefined
              ? { name: c.name, status: c.status }
              : { name: c.name, status: c.status, detail: c.detail },
          ),
        };
      },
      streamEnabled: config.stream.enabled,
    }),
  });

  // Proxy routes register the catch-all `/api/:service/*`; keep them AFTER the specific
  // `/api/stream` route so the stream route wins.
  registerGatewayRoutes(app, { jwt, upstreams: config.upstreams });

  return { app, readiness, registry };
}
