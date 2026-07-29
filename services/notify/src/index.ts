/**
 * Bootstrap / composition root: load & validate config, connect Mongo + the NATS backbone, wire the
 * channel + notification stores, the channel/notification services, the channel-sender registry
 * (in-app + webhook), and the alert-engine consumer (with metrics on the /metrics registry), build
 * the server, listen, and shut down gracefully. The only file that touches the process/network and
 * constructs concrete adapters (Mongo, NATS, HTTP senders).
 */
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { NatsEventBus } from '@vip/messaging';
import { loadConfig } from './config/env.js';
import { ReadinessRegistry } from './application/readiness.js';
import { ChannelService } from './application/channel-service.js';
import { NotificationService } from './application/notification-service.js';
import { AlertEngine } from './application/alert-engine.js';
import { NotificationMetrics } from './application/metrics.js';
import { BusNotificationPublisher } from './application/notification-publisher.js';
import { ChannelSenderRegistry, InAppSender, WebhookSender } from './application/channel-sender.js';
import { connectMongo } from './adapters/mongo.js';
import { MongoChannelStore } from './adapters/mongo-channel-store.js';
import { MongoNotificationStore } from './adapters/mongo-notification-store.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const mongo = await connectMongo({ uri: config.database.uri });
  const bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'notify' });
  const channelStore = new MongoChannelStore({ channels: mongo.channels });
  const notificationStore = new MongoNotificationStore({ notifications: mongo.notifications });
  const publisher = new BusNotificationPublisher(bus);

  const readiness = new ReadinessRegistry();
  readiness.register('mongo', async () => {
    try {
      await mongo.ping();
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'ping failed' };
    }
  });

  const channelService = new ChannelService({ store: channelStore });
  const notificationService = new NotificationService({ store: notificationStore, publisher });

  const { app, registry } = await buildServer({
    config,
    channelService,
    notificationService,
    readiness,
  });

  const metrics = new NotificationMetrics(registry);
  notificationService.useMetrics(metrics);
  const senders = new ChannelSenderRegistry()
    .register('in-app', new InAppSender())
    .register('webhook', new WebhookSender(config.notify.webhookTimeoutMs));

  const loggerRef: { current?: FastifyBaseLogger } = { current: app.log };
  const engine = new AlertEngine({
    bus,
    channels: channelStore,
    notifications: notificationStore,
    senders,
    publisher,
    metrics,
    log: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  await engine.start();
  app.log.info('alert engine consumer started');

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
  console.error('fatal: notify service failed to start', err);
  process.exit(1);
});
