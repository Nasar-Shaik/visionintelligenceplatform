/**
 * Transport: server assembly. `buildServer` wires config → plugins → routes onto a Fastify
 * instance and returns it WITHOUT listening, so tests drive it via `app.inject()` and the bootstrap
 * (index.ts) owns network/lifecycle. Access tokens are minted by identity (`iss=identity`,
 * `aud=vip`); the media service verifies with those expectations (matching the gateway).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import type { StreamSupervisor } from '../application/stream-supervisor.js';
import type { MediaCatalogService } from '../application/media-catalog-service.js';
import type { FrameSinkStats } from '../adapters/http-frame-sink.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics, registerPerceptionMetrics } from './plugins/observability.js';
import { createAuth, registerPrincipal } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerStreamRoutes } from './routes/streams.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerClipRoutes } from './routes/clips.js';
import { registerPerceptionRoutes } from './routes/perception.js';
import { registerTrackingRoutes } from './routes/tracking.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  supervisor: StreamSupervisor;
  catalog: MediaCatalogService;
  startedAt?: Date;
  readiness?: ReadinessRegistry;
  /** The perception sink, when one is configured — its counters become `/metrics` series. */
  perception?: { stats(): FrameSinkStats };
  /** Injected so the tracking proxy can be driven without a runtime (tests only). */
  trackingFetch?: typeof fetch;
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
  if (opts.perception !== undefined) registerPerceptionMetrics(registry, opts.perception);
  registerPrincipal(app);
  const auth = createAuth({ secret: config.jwt.secret, issuer: 'identity', audience: 'vip' });
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness });
  registerMetricsRoute(app, registry);
  registerRootRoute(app, { name: config.serviceName, version: config.serviceVersion, startedAt });
  registerStreamRoutes(app, { supervisor: opts.supervisor, auth });
  registerRecordingRoutes(app, { catalog: opts.catalog, auth });
  registerClipRoutes(app, { catalog: opts.catalog, auth });
  registerPerceptionRoutes(app, {
    auth,
    ...(opts.perception === undefined ? {} : { perception: opts.perception }),
    runtimeUrl: config.perception.url,
    internalKey: config.internal.apiKey,
    capabilityId: config.perception.capabilityId,
  });
  registerTrackingRoutes(app, {
    auth,
    runtimeUrl: config.perception.url,
    internalKey: config.internal.apiKey,
    ...(opts.trackingFetch === undefined ? {} : { fetch: opts.trackingFetch }),
  });

  return { app, readiness };
}
