/**
 * Bootstrap / composition root: load & validate config, connect Mongo + the NATS backbone, wire the
 * event store + ingest consumer + query service, build the server, listen, and shut down gracefully
 * (stop the consumer, close the bus + db, drain requests). The only file that touches the
 * process/network and constructs concrete adapters (Mongo, NATS).
 */
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { NatsEventBus } from '@vip/messaging';
import { loadConfig } from './config/env.js';
import { ReadinessRegistry } from './application/readiness.js';
import { EventIngestService } from './application/event-ingest-service.js';
import { EventQueryService } from './application/event-query-service.js';
import { connectMongo } from './adapters/mongo.js';
import { MongoEventStore } from './adapters/mongo-event-store.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const mongo = await connectMongo({ uri: config.database.uri });
  const bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'events' });
  const store = new MongoEventStore(mongo.events);

  const loggerRef: { current?: FastifyBaseLogger } = {};
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields?: object): void =>
    loggerRef.current?.[level]({ ...fields }, msg);

  const ingest = new EventIngestService({
    bus,
    store,
    dedupWindowMs: config.events.dedupWindowMs,
    log,
  });
  const queryService = new EventQueryService({
    store,
    bus,
    replayCeiling: config.events.replayCeiling,
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

  const { app } = await buildServer({ config, queryService, readiness });
  loggerRef.current = app.log;

  await ingest.start();
  app.log.info('event ingest consumer started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await ingest.stop();
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
  console.error('fatal: events service failed to start', err);
  process.exit(1);
});
