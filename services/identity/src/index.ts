/**
 * Bootstrap / composition root: load & validate config, connect MongoDB, wire the auth + user
 * services, build the server, listen, and shut down gracefully on SIGTERM/SIGINT (drain, then
 * close Mongo). The only file that touches the process/network and the driver lifecycle.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { TenantRepository } from '@vip/tenancy';
import { loadConfig } from './config/env.js';
import { connectMongo } from './adapters/mongo.js';
import { ReadinessRegistry } from './application/readiness.js';
import { LoggingEventPublisher } from './application/events.js';
import { AuthService } from './application/auth-service.js';
import { UserService } from './application/user-service.js';
import { buildServer } from './transport/server.js';

const clock = { now: () => new Date() };

async function main(): Promise<void> {
  loadDotEnv();
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

  const loggerRef: { current?: FastifyBaseLogger } = {};
  const publisher = new LoggingEventPublisher((event) =>
    loggerRef.current?.info({ event }, 'domain event published'),
  );

  const users = new TenantRepository(mongo.users);
  const authService = new AuthService({
    users,
    refreshTokens: mongo.refreshTokens,
    jwt: {
      secret: config.jwt.secret,
      accessTtl: config.jwt.accessTtl,
      refreshTtl: config.jwt.refreshTtl,
      issuer: config.serviceName,
      audience: 'vip',
    },
    clock,
    ids: { familyId: () => `fam_${randomUUID().replace(/-/g, '')}` },
    publisher,
  });
  /*
   * ⚠️ Constructed after `authService` because it depends on it: disabling a user and resetting a
   * password both end that user's sessions, and `AuthService` is the only owner of `refresh_tokens`.
   * The dependency is a one-method port (`SessionRevoker`), not the collection.
   */
  const userService = new UserService({
    users,
    clock,
    ids: { userId: () => `usr_${randomUUID().replace(/-/g, '')}` },
    publisher,
    sessions: authService,
  });

  const { app } = await buildServer({ config, auth: authService, users: userService, readiness });
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
  // eslint-disable-next-line no-console
  console.error('fatal: identity service failed to start', err);
  process.exit(1);
});
