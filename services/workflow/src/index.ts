/**
 * Bootstrap / composition root: load & validate config, connect Mongo + the NATS backbone, wire the
 * incident store + lifecycle service + promoter consumer (with lifecycle metrics on the /metrics
 * registry), build the server, listen, and shut down gracefully. The only file that touches the
 * process/network and constructs concrete adapters (Mongo, NATS).
 */
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { NatsEventBus } from '@vip/messaging';
import { loadConfig } from './config/env.js';
import { ReadinessRegistry } from './application/readiness.js';
import { IncidentService } from './application/incident-service.js';
import { IncidentPromoter } from './application/incident-promoter.js';
import { IncidentMetrics } from './application/metrics.js';
import { BusIncidentPublisher } from './application/incident-publisher.js';
import { connectMongo } from './adapters/mongo.js';
import { MongoIncidentStore } from './adapters/mongo-incident-store.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const mongo = await connectMongo({ uri: config.database.uri });
  const bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'workflow' });
  const store = new MongoIncidentStore({ incidents: mongo.incidents });

  const readiness = new ReadinessRegistry();
  readiness.register('mongo', async () => {
    try {
      await mongo.ping();
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'ping failed' };
    }
  });

  const incidentService = new IncidentService({
    store,
    publisher: new BusIncidentPublisher(bus),
  });

  const { app, registry } = await buildServer({ config, incidentService, readiness });

  // The registry only exists after the server is built; attach metrics to the shared service now,
  // so both the HTTP transition routes and the promoter consumer record onto the same registry.
  const metrics = new IncidentMetrics(registry);
  incidentService.useMetrics(metrics);
  const loggerRef: { current?: FastifyBaseLogger } = { current: app.log };
  const promoter = new IncidentPromoter({
    bus,
    service: incidentService,
    metrics,
    log: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  await promoter.start();
  app.log.info('incident promoter consumer started');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await promoter.stop();
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
  console.error('fatal: workflow service failed to start', err);
  process.exit(1);
});
