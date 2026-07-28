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
import { connectMongo } from './adapters/mongo.js';
import { MongoRuleStore } from './adapters/mongo-rule-store.js';
import { InMemoryRuleStateStore } from './adapters/in-memory-rule-state.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const mongo = await connectMongo({ uri: config.database.uri });
  const bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'rules' });
  const store = new MongoRuleStore({ rules: mongo.rules, versions: mongo.versions });
  const state = new InMemoryRuleStateStore();
  const ruleService = new RuleService({
    store,
    dedupWindowMs: config.rules.candidateDedupWindowMs,
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

  const { app, registry } = await buildServer({ config, ruleService, readiness });

  const loggerRef: { current?: FastifyBaseLogger } = { current: app.log };
  const engine = new RuleEngine({
    bus,
    store,
    state,
    maxRulesPerEvent: config.rules.maxRulesPerEvent,
    candidateDedupWindowMs: config.rules.candidateDedupWindowMs,
    metrics: new RuleMetrics(registry),
    log: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  await engine.start();
  app.log.info('rule engine consumer started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await engine.stop();
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
