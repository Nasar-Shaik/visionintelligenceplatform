/**
 * Transport: server assembly. `buildServer` wires config → plugins → routes onto Fastify and returns
 * it WITHOUT listening (tests drive it via `app.inject()`; the bootstrap owns network/lifecycle + the
 * engine consumer). The Prometheus registry is returned so the composition root can register the
 * rule-engine evaluation metrics on it (same registry `/metrics` serves).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';
import type { ServiceConfig } from '../config/env.js';
import { ReadinessRegistry } from '../application/readiness.js';
import type { RuleService } from '../application/rule-service.js';
import type { RuleEngine } from '../application/rule-engine.js';
import { registerSecurity } from './plugins/security.js';
import { registerMetrics } from './plugins/observability.js';
import { createAuth, registerPrincipal } from './plugins/auth.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerRootRoute } from './routes/root.js';
import { registerRuleAuthoringRoutes } from './routes/rule-authoring.js';
import { registerRuleOperationsRoutes } from './routes/rule-operations.js';
import { registerRuleLiveRoutes } from './routes/rule-live.js';

export interface BuildServerOptions {
  config: ServiceConfig;
  ruleService: RuleService;
  startedAt?: Date;
  readiness?: ReadinessRegistry;
  /**
   * The evaluating engine on this node (P-8 Phase 7), late-bound.
   *
   * ⚠️ A **reference cell**, not the engine: the engine is constructed after the server because it
   * needs the metrics registry, and the live-status plane must not force that order to invert. An
   * empty cell means this node does not evaluate, which the routes answer with a `503`.
   */
  engine?: { current?: RuleEngine };
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
  /*
   * Two planes, one service (P-4.2, Architect rec 9). The paths are unchanged — the separation is
   * about who calls what and why each half changes, not about URLs.
   */
  registerRuleAuthoringRoutes(app, { service: opts.ruleService, auth });
  registerRuleOperationsRoutes(app, { service: opts.ruleService, auth });
  /* P-8 Phase 7 — live status, dry-run results and templates. See `rule-live.ts`. */
  registerRuleLiveRoutes(app, { auth, engine: opts.engine ?? {} });

  return { app, readiness, registry };
}
