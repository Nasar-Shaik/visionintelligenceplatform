/**
 * Bootstrap / composition root: load & validate config, connect MongoDB, wire the tenant-scoped
 * repositories and application service, build the server, listen, and shut down gracefully on
 * SIGTERM/SIGINT (drain requests, then close Mongo — Principle 8, 12-factor disposability).
 * This is the only file that touches the process/network and the driver lifecycle.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { TenantRepository } from '@vip/tenancy';
import { loadConfig } from './config/env.js';
import { connectMongo } from './adapters/mongo.js';
import { ReadinessRegistry } from './application/readiness.js';
import { LoggingEventPublisher } from './application/events.js';
import { TenantService } from './application/tenant-service.js';
import { buildServer } from './transport/server.js';

const clock = { now: () => new Date() };
const ids = {
  tenantId: () => `tnt_${randomUUID().replace(/-/g, '')}`,
  orgNodeId: () => `on_${randomUUID().replace(/-/g, '')}`,
};

async function main(): Promise<void> {
  loadDotEnv(); // load .env into process.env once (no-op in prod / tests)
  const config = loadConfig();
  const mongo = await connectMongo({ uri: config.database.uri });

  const readiness = new ReadinessRegistry();
  readiness.register('mongo', async () => {
    try {
      await mongo.ping();
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'ping failed' };
    }
  });

  // The logger only exists once the app is built; the publisher reads it lazily via this holder.
  const loggerRef: { current?: FastifyBaseLogger } = {};
  const publisher = new LoggingEventPublisher((event) =>
    loggerRef.current?.info({ event }, 'domain event published'),
  );

  const service = new TenantService({
    tenants: new TenantRepository(mongo.tenants),
    orgNodes: new TenantRepository(mongo.orgNodes),
    clock,
    ids,
    publisher,
  });

  const { app } = await buildServer({ config, service, readiness });
  loggerRef.current = app.log;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
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
  // Last-resort handler for failures before the logger exists (e.g. bad config / no Mongo).
  // eslint-disable-next-line no-console
  console.error('fatal: tenant service failed to start', err);
  process.exit(1);
});
