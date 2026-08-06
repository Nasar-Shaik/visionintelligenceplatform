/**
 * Bootstrap / composition root: load & validate config, connect Mongo + the NATS backbone, wire the
 * rule store + CRUD service + engine consumer (with evaluation metrics on the /metrics registry),
 * build the server, listen, and shut down gracefully. The only file that touches the process/network
 * and constructs concrete adapters (Mongo, NATS, in-memory rule state).
 */
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { NatsEventBus } from '@vip/messaging';
import { loadConfig } from './config/env.js';
import { ReadinessRegistry } from './application/readiness.js';
import { RuleService } from './application/rule-service.js';
import { RuleEngine } from './application/rule-engine.js';
import { RuleMetrics } from './application/metrics.js';
import { RuleStatsRegistry } from './application/rule-stats.js';
import { connectMongo } from './adapters/mongo.js';
import { MongoRuleStore } from './adapters/mongo-rule-store.js';
import { InMemoryRuleStateStore } from './adapters/in-memory-rule-state.js';
import { InMemoryDwellStateStore } from './adapters/in-memory-dwell-state.js';
import { HttpCameraDirectory, ZoneCatalog } from './adapters/http-camera-directory.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  /* Declared first: the adapters below log through it, and it is bound once the server exists. */
  const loggerRef: { current?: FastifyBaseLogger } = {};

  const mongo = await connectMongo({ uri: config.database.uri });
  const bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'rules' });
  const store = new MongoRuleStore({ rules: mongo.rules, versions: mongo.versions });
  const state = new InMemoryRuleStateStore();
  /*
   * Where a subject's visit lives between two events (P-8 Phase 7).
   *
   * ⚠️ In-memory, bounded and swept. State is lost on restart, and a visit in progress restarts its
   * clock — recorded in KNOWN_LIMITATIONS rather than hidden. The alternative was a durable write on
   * the per-event path, which puts a disk between a camera and an alert.
   */
  const dwell = new InMemoryDwellStateStore();

  /*
   * The camera context (P-8 Phase 7). ⚠️ Unconfigured is valid and fails CLOSED: camera-, group- and
   * zone-scoped rules cannot be validated, so they cannot be enabled, and the report says why.
   */
  const cameraDirectory =
    config.camera.url === ''
      ? undefined
      : new HttpCameraDirectory({
          baseUrl: config.camera.url,
          internalKey: config.camera.internalKey,
          onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
        });
  /*
   * ⚠️ Fails SOFT, unlike the directory above. A candidate whose zone could not be named carries the
   * zone id — honest and actionable. Blocking an alert on a name lookup would be the wrong trade.
   */
  const zoneCatalog =
    config.camera.url === ''
      ? undefined
      : new ZoneCatalog({
          baseUrl: config.camera.url,
          internalKey: config.camera.internalKey,
          intervalMs: config.camera.catalogIntervalMs,
          onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
        });
  /*
   * The engine is constructed after the HTTP server (it needs the metrics registry), so authoring
   * writes reach its compiled-rule cache through a late-bound reference rather than a construction
   * order dependency. Without this, a rule an operator just saved is invisible to the engine until
   * the compiled set expires — "saved" followed by nothing happening, which reads as a broken product.
   */
  const engineRef: { current?: RuleEngine } = {};
  /*
   * Durable per-rule counters, owned here rather than by the engine: they must survive every
   * recompilation of a tenant's rule set, and both the engine (which writes them) and the HTTP service
   * (which reports them) need the same instance (P-4.1, Architect rec 3).
   */
  const ruleStats = new RuleStatsRegistry();
  const node = process.env.HOSTNAME ?? 'rules';
  const ruleService = new RuleService({
    store,
    ...(cameraDirectory === undefined ? {} : { cameras: cameraDirectory }),
    dedupWindowMs: config.rules.candidateDedupWindowMs,
    /*
     * Invalidate, then **warm** (Architect rec 5). Invalidating alone leaves the rebuild to the next
     * event — which is the event the author is watching for. Warming moves the cost onto the write,
     * where someone is already waiting and a few milliseconds are invisible. Not awaited: the save must
     * not fail because an optimisation did, and `warm` never throws.
     */
    onRulesChanged: (tenantId) => {
      engineRef.current?.invalidate(tenantId);
      void engineRef.current?.warm(tenantId);
    },
    diagnostics: {
      node,
      uptimeSeconds: () => ruleStats.uptimeSeconds,
      cacheStats: (tenantId) => engineRef.current?.cacheStats(tenantId),
      ruleStats: (tenantId) => ruleStats.snapshot(tenantId),
      history: (tenantId, ruleId) => ruleStats.historyFor(tenantId, ruleId),
    },
  });

  const readiness = new ReadinessRegistry();
  readiness.register('mongo', async () => {
    try {
      await mongo.ping();
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'ping failed' };
    }
  });

  const { app, registry } = await buildServer({
    config,
    ruleService,
    readiness,
    engine: engineRef,
  });

  loggerRef.current = app.log;
  const engine = new RuleEngine({
    bus,
    store,
    state,
    dwell,
    ...(zoneCatalog === undefined ? {} : { zones: zoneCatalog.lookup }),
    node,
    maxRulesPerEvent: config.rules.maxRulesPerEvent,
    candidateDedupWindowMs: config.rules.candidateDedupWindowMs,
    stats: ruleStats,
    metrics: new RuleMetrics(registry),
    log: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  engineRef.current = engine;
  zoneCatalog?.start();
  await engine.start();
  app.log.info('rule engine consumer started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await engine.stop();
    zoneCatalog?.stop();
    await bus.close();
    await mongo.close();
    await app.close();
    app.log.info('shutdown complete');
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandledRejection'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('fatal: rules service failed to start', err);
  process.exit(1);
});
