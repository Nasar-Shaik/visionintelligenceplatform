/**
 * Bootstrap / composition root: load & validate config, build the server, listen, and shut down
 * gracefully on SIGTERM/SIGINT. The gateway holds no data store — it validates tokens and proxies.
 */
import { loadDotEnv } from '@vip/config';
import { loadConfig } from './config/env.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const { app } = await buildServer({ config });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
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
  console.error('fatal: gateway service failed to start', err);
  process.exit(1);
});
