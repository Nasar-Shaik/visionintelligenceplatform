/**
 * Transport: server assembly. `buildServer` wires config → plugins → routes onto a Fastify
 * instance and returns it WITHOUT listening, so tests drive it via `app.inject()` and the
 * bootstrap (index.ts) owns network/lifecycle. Order matters: security, observability, and the
 * principal decorator are registered before routes so they apply to every handler.
 *
 * Access tokens are minted by identity (`iss=identity`, `aud=vip`); the camera service verifies
 * with those same expectations (matching the gateway) — see plugins/auth.ts.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import type { CameraService } from '../application/camera-service.js';
import type { AssignmentService } from '../application/assignment-service.js';
import type { ZoneService } from '../application/zone-service.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics, registerAssignmentMetrics } from './plugins/observability.js';
import { createAuth, registerPrincipal } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerCameraRoutes } from './routes/cameras.js';
import { registerAssignmentRoutes } from './routes/assignments.js';
import { registerZoneRoutes } from './routes/zones.js';
import { registerInternalRoutes } from './routes/internal.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  /** The application service (camera-inventory use-cases). */
  service: CameraService;
  /** Process start time (for uptime). Injectable for deterministic tests. */
  startedAt?: Date;
  /** Pre-seeded readiness registry (adapters register their checks here). */
  readiness?: ReadinessRegistry;
  /**
   * Camera Processing Assignment (P-8 Phase 6). Optional so a test that only exercises the camera
   * inventory does not have to construct six collections it never reads — the assignment routes are
   * simply not mounted, which is also a valid deployment.
   */
  assignments?: AssignmentService;
  /**
   * Detection zones (P-8 Phase 7). Optional for the same reason as `assignments`: a deployment that
   * has not wired them simply has no zones, stamps no `zoneId` on any event, and behaves exactly as
   * it did before this milestone.
   */
  zones?: ZoneService;
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
  registerPrincipal(app);
  const auth = createAuth({ secret: config.jwt.secret, issuer: 'identity', audience: 'vip' });
  registerErrorHandler(app);

  registerHealthRoutes(app, { readiness });
  registerMetricsRoute(app, registry);
  registerRootRoute(app, { name: config.serviceName, version: config.serviceVersion, startedAt });
  registerCameraRoutes(app, { service: opts.service, auth });
  if (opts.assignments !== undefined) {
    registerAssignmentRoutes(app, { assignments: opts.assignments, auth });
    registerAssignmentMetrics(registry, opts.assignments);
  }
  if (opts.zones !== undefined) registerZoneRoutes(app, { zones: opts.zones, auth });
  registerInternalRoutes(app, {
    service: opts.service,
    internalKey: config.internal.apiKey,
    ...(opts.assignments === undefined ? {} : { assignments: opts.assignments }),
    ...(opts.zones === undefined ? {} : { zones: opts.zones }),
  });

  return { app, readiness };
}
