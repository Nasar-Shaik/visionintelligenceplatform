/**
 * Bootstrap / composition root: load & validate config, select the StorageProvider (local/s3),
 * connect Mongo + the NATS backbone, wire the evidence store + custody log + service (with metrics on
 * the /metrics registry) + the evidence publisher + the incident→evidence consumer, build the server,
 * listen, and shut down gracefully. The only file that constructs concrete adapters + touches the
 * process/network.
 */
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { NatsEventBus } from '@vip/messaging';
import { loadConfig } from './config/env.js';
import { ReadinessRegistry } from './application/readiness.js';
import { EvidenceService } from './application/evidence-service.js';
import { EvidenceMetrics } from './application/metrics.js';
import { BusEvidencePublisher } from './application/evidence-publisher.js';
import {
  IncidentEvidenceConsumer,
  NoopIncidentEvidenceExtractor,
} from './application/incident-consumer.js';
import { buildStorageProvider } from './adapters/storage-provider.js';
import { connectMongo } from './adapters/mongo.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const objectStore = buildStorageProvider(config);
  const mongo = await connectMongo({ uri: config.database.uri });
  const bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'evidence' });
  await bus.ensureStream('EVIDENCE', ['t.*.evidence.>']);

  const readiness = new ReadinessRegistry();
  readiness.register('mongo', async () => {
    try {
      await mongo.ping();
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'ping failed' };
    }
  });
  readiness.register('storage', async () => {
    try {
      await objectStore.head('__readiness__'); // provider-agnostic connectivity probe
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'storage unreachable' };
    }
  });

  const service = new EvidenceService({
    store: mongo.evidence,
    custody: mongo.custody,
    objectStore,
    publisher: new BusEvidencePublisher(bus),
    downloadTtlSeconds: config.evidence.downloadTtlSeconds,
    defaultRetentionDays: config.evidence.defaultRetentionDays,
  });

  const { app, registry } = await buildServer({ config, service, readiness });
  const metrics = new EvidenceMetrics(registry);
  service.useMetrics(metrics);

  const loggerRef: { current?: FastifyBaseLogger } = { current: app.log };
  const log = (level: 'info' | 'warn' | 'error', msg: string, fields?: object): void => {
    loggerRef.current?.[level]({ ...fields }, msg);
  };

  let consumer: IncidentEvidenceConsumer | undefined;
  if (config.evidence.consumeIncidents) {
    consumer = new IncidentEvidenceConsumer({
      bus,
      // Live media-backed extraction is deferred (needs the Media frame source) — see README/TD.
      extractor: new NoopIncidentEvidenceExtractor(log),
      service,
      metrics,
      log,
    });
    await consumer.start();
    app.log.info('incident → evidence consumer started');
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await consumer?.stop();
    await bus.close();
    await app.close();
    await mongo.close();
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
  console.error('fatal: evidence service failed to start', err);
  process.exit(1);
});
