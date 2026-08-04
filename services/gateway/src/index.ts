/**
 * Bootstrap / composition root: load & validate config, build the server, listen, and shut down
 * gracefully on SIGTERM/SIGINT. The gateway holds no data store — it validates tokens and proxies.
 * When real-time delivery is enabled (G-5) it also dials the NATS backbone and wires the StreamHub
 * (over NatsEventBus) + its Prometheus metrics onto the /metrics registry.
 */
import { loadDotEnv } from '@vip/config';
import { NatsEventBus } from '@vip/messaging';
import { ReadinessRegistry } from './application/readiness.js';
import { loadConfig } from './config/env.js';
import { buildServer } from './transport/server.js';
import { StreamHub } from './application/stream-hub.js';
import { StreamMetrics } from './application/stream-metrics.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  // Real-time delivery (G-5): dial the backbone and stand up the StreamHub, or stay a pure proxy.
  let bus: NatsEventBus | undefined;
  let hub: StreamHub | undefined;
  if (config.stream.enabled) {
    bus = await NatsEventBus.connect({ servers: config.nats.url, name: 'gateway' });
    hub = new StreamHub({
      bus,
      limits: {
        maxConnectionsPerTenant: config.stream.maxConnectionsPerTenant,
        maxQueueDepth: config.stream.maxQueueDepth,
        replayBufferSize: config.stream.replayBufferSize,
        heartbeatIntervalMs: config.stream.heartbeatIntervalMs,
        maxConnectionDurationMs: config.stream.maxConnectionDurationMs,
      },
    });
  }

  /**
   * ⚠️ Found by deploying (P-5.8): the gateway registered **no** readiness checks, so `/ready`
   * answered `{"status":"pass","checks":[]}` unconditionally — a probe structurally incapable of
   * failing, on the one service a load balancer actually gates traffic on. Every other service
   * registers its dependencies; this one had kept the Phase-0 empty registry.
   *
   * ⚠️ Only the backbone is checked, and the omission is deliberate. Upstream services are *not*
   * probed here: the gateway can still serve the other eight when one is down, so failing readiness
   * for a single broken upstream would take the entire platform out of rotation — a much larger
   * outage than the one being reported. Upstream health is each service's own `/ready`.
   */
  const readiness = new ReadinessRegistry();
  if (bus) {
    const backbone = bus;
    readiness.register('nats', async () => {
      try {
        await backbone.ping();
        return { status: 'pass' };
      } catch (err) {
        return { status: 'fail', detail: err instanceof Error ? err.message : 'nats unreachable' };
      }
    });
  }

  const { app, registry } = await buildServer({ config, readiness, streamHub: hub });
  if (hub) {
    hub.useMetrics(new StreamMetrics(registry));
    app.log.info('real-time delivery (SSE) enabled');
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await hub?.close();
    await bus?.close();
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
