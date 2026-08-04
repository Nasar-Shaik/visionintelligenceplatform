/**
 * Bootstrap / composition root: load & validate config, wire the real adapters (S3 object store,
 * HTTP camera source, ffmpeg decoder, null perception sink) into the stream supervisor, build the
 * server, listen, and shut down gracefully (stop all workers, drain requests). The only file that
 * touches the process/network and constructs concrete adapters.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { S3ObjectStore } from '@vip/storage';
import { loadConfig } from './config/env.js';
import { connectMongo } from './adapters/mongo.js';
import { ReadinessRegistry } from './application/readiness.js';
import { LoggingEventPublisher } from './application/events.js';
import { StreamSupervisor } from './application/stream-supervisor.js';
import { MediaCatalogService } from './application/media-catalog-service.js';
import { HttpCameraSource } from './adapters/http-camera-source.js';
import { FfmpegDecoder } from './adapters/ffmpeg-decoder.js';
import { NullFrameSink } from './adapters/null-frame-sink.js';
import { buildServer } from './transport/server.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();

  const objectStore = new S3ObjectStore({
    endpoint: config.storage.endpoint,
    // Media only writes segments today, but a store that can hand out an unreachable URL is a trap
    // for whoever adds the first read. Same public name as evidence uses.
    publicEndpoint: config.storage.publicEndpoint,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
    region: config.storage.region,
    bucket: config.storage.recordingsBucket,
    forcePathStyle: config.storage.forcePathStyle,
  });

  const mongo = await connectMongo({ uri: config.database.uri });

  const readiness = new ReadinessRegistry();
  readiness.register('storage', async () => {
    try {
      await objectStore.ping();
      return { status: 'pass' };
    } catch (err) {
      return { status: 'fail', detail: err instanceof Error ? err.message : 'ping failed' };
    }
  });
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

  const catalog = new MediaCatalogService({
    store: mongo.catalog,
    objectStore,
    clock: { now: () => new Date() },
    ids: { clipId: () => `clip_${randomUUID().replace(/-/g, '')}` },
    playbackTtlSeconds: config.playbackTtlSeconds,
  });

  const supervisor = new StreamSupervisor({
    cameraSource: new HttpCameraSource({
      baseUrl: config.ingestion.cameraUrl,
      internalKey: config.internal.apiKey,
    }),
    decoder: new FfmpegDecoder({ binary: config.ingestion.ffmpegBinary }),
    objectStore,
    frameSink: new NullFrameSink(),
    clock: { now: () => new Date() },
    options: {
      frameRate: config.ingestion.frameRate,
      segmentSeconds: config.ingestion.segmentSeconds,
    },
    publisher,
    // Index recorded segments into the catalog so they are listable/playable (P2-2 G-2).
    recordingSink: catalog,
    onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  const { app } = await buildServer({ config, supervisor, catalog, readiness });
  loggerRef.current = app.log;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    await supervisor.stopAll();
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
  console.error('fatal: media service failed to start', err);
  process.exit(1);
});
