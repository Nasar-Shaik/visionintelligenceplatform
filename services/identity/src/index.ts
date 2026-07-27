/**
 * Bootstrap: load & validate config, build the server, start listening, and shut down
 * gracefully on SIGTERM/SIGINT (drain in-flight requests before exit — Principle 8,
 * 12-factor disposability). This is the only file that touches the process/network.
 */
import { loadConfig } from './config/env.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
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

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err: unknown) => {
  // Last-resort handler for failures before the logger exists (e.g. bad config).
  // eslint-disable-next-line no-console
  console.error('fatal: identity service failed to start', err);
  process.exit(1);
});
