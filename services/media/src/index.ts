/**
 * Bootstrap / composition root: load & validate config, wire the real adapters (S3 object store,
 * HTTP camera source, ffmpeg decoder, null perception sink) into the stream supervisor, build the
 * server, listen, and shut down gracefully (stop all workers, drain requests). The only file that
 * touches the process/network and constructs concrete adapters.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { S3ObjectStore, TenantObjectStore } from '@vip/storage';
import { loadConfig } from './config/env.js';
import { connectMongo } from './adapters/mongo.js';
import { ReadinessRegistry } from './application/readiness.js';
import { LoggingEventPublisher } from './application/events.js';
import { StreamSupervisor } from './application/stream-supervisor.js';
import { MediaCatalogService } from './application/media-catalog-service.js';
import { HttpCameraSource } from './adapters/http-camera-source.js';
import { FfmpegDecoder } from './adapters/ffmpeg-decoder.js';
import { NullFrameSink } from './adapters/null-frame-sink.js';
import { HttpFrameSink } from './adapters/http-frame-sink.js';
import { BufferedEventPublisher } from './adapters/event-publisher.js';
import { AssignmentGate } from './application/assignment-gate.js';
import { AssignmentClient } from './adapters/assignment-client.js';
import { AnalysisService } from './application/analysis-service.js';
import { AnalysisWorker, defaultWorkerId } from './application/analysis-worker.js';
import { AnalysisRunner } from './application/analysis-runner.js';
import { StoredMediaFrameSourceFactory } from './adapters/stored-media-frame-source.js';
import { HttpAnalysisEvents } from './adapters/http-analysis-events.js';
import { HttpAnalysisIncidents } from './adapters/http-analysis-incidents.js';
import { FfmpegSnapshotExtractor } from './adapters/ffmpeg-snapshot.js';
import { FfprobeMediaProbe } from './adapters/ffprobe.js';
import { CameraSourceDirectory } from './adapters/camera-source-directory.js';
import { NatsEventBus } from '@vip/messaging';
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

  /*
   * ⚠️ The perception seam (P-8 Phase 2, ADR-A). Configured → frames go to the AI runtime; not
   * configured → the null sink, which is exactly what every deployment did before this phase. The
   * choice is one environment variable and it is logged at boot, because "are frames going anywhere"
   * must be answerable from the log rather than inferred from a counter that reads zero.
   */
  /*
   * ⚠️ The Event Publisher bridge (P-8 Phase 5). Off unless enabled, and it needs a broker — so the
   * connection is made only when the bridge is on. A media deployment that does not publish must not
   * fail to start because NATS is unreachable; recording does not depend on the backbone.
   */
  let eventBus: NatsEventBus | undefined;
  let eventPublisher: BufferedEventPublisher | undefined;
  if (config.eventBridge.enabled && config.nats !== undefined) {
    eventBus = await NatsEventBus.connect({ servers: config.nats.url, name: 'media-publisher' });
    eventPublisher = new BufferedEventPublisher({
      bus: eventBus,
      enabled: true,
      perCamera: config.eventBridge.queuePerCamera,
      maxInflight: config.eventBridge.maxInflight,
      maxAttempts: config.eventBridge.maxAttempts,
      onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
    });
  }

  /*
   * ⚠️ Camera Processing Assignment (P-8 Phase 6). The gate is created before the sink because the
   * sink consults it on the frame path; the client is created after, because it needs the sink to
   * release queues. That ordering is the only coupling between the two.
   */
  const gate = config.assignment.enabled ? new AssignmentGate() : undefined;

  const frameSink =
    config.perception.url === ''
      ? new NullFrameSink()
      : new HttpFrameSink({
          url: config.perception.url,
          internalKey: config.internal.apiKey,
          capabilityId: config.perception.capabilityId,
          queuePerCamera: config.perception.queuePerCamera,
          maxInflight: config.perception.maxInflight,
          timeoutMs: config.perception.timeoutMs,
          onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
          ...(eventPublisher === undefined ? {} : { publisher: eventPublisher }),
          ...(gate === undefined ? {} : { gate }),
        });

  /*
   * ⚠️ **The release wiring — this is what closes the defect P-8 Phase 5 measured.**
   *
   * A camera switched off and back on begins its frame sequence again at 1. A publisher still
   * holding `lastSeq` from the previous session treats every new frame as stale and drops it, for
   * ever, silently: Phase 5 measured a re-enabled camera publishing 0 and dropping 32. Releasing both
   * the sink's queue and the publisher's ordering gate whenever the control plane says the session
   * has changed is the fix, and it is driven by a version number rather than by timing.
   *
   * `BufferedEventPublisher.release()` was written in Phase 5 and deliberately left uncalled, so that
   * this milestone would plug in without a redesign. This is the call.
   */
  const assignmentClient =
    gate === undefined
      ? undefined
      : new AssignmentClient({
          controlPlaneUrl: config.ingestion.cameraUrl,
          internalKey: config.internal.apiKey,
          gate,
          intervalMs: config.assignment.intervalMs,
          degradedMs: config.assignment.degradedMs,
          onRelease: (tenantId, cameraId) => {
            if (frameSink instanceof HttpFrameSink) frameSink.release(tenantId, cameraId);
            eventPublisher?.release(tenantId, cameraId);
          },
          ...(frameSink instanceof HttpFrameSink
            ? { runtimeFailures: () => frameSink.drainRuntimeFailures() }
            : {}),
          /*
           * ⚠️ Facts for **every supervised camera**, not just the assigned ones. A camera
           * deliberately excluded from AI still records, and the capability matrix has to be able to
           * say so — reporting only assigned cameras would leave every recording-only camera
           * answering "unknown" for ever. `idle` moves no state machine on the control plane, so a
           * recording-only camera appearing here cannot disturb its assignment.
           */
          cameraFacts: () =>
            supervisor.allHealth().map((stream) => ({
              tenantId: stream.tenantId,
              cameraId: stream.cameraId,
              state: 'idle' as const,
              runtimeId: null,
              recording: stream.recording,
              /*
               * ⚠️ OMITTED when the supervisor's health is `unknown`, rather than mapped onto
               * `degraded`. An idle worker has not demonstrated a recording problem, and reporting
               * one would put a red badge on a camera nobody has measured — the exact failure
               * ADR-0039 exists to prevent. Absent here becomes `unknown` in the matrix.
               */
              ...(stream.health === 'unknown' ? {} : { recordingHealth: stream.health }),
              ...(eventPublisher === undefined
                ? {}
                : {
                    tracking: eventPublisher.trackingFor(stream.tenantId, stream.cameraId),
                    eventsPublished:
                      eventPublisher.publishedFor(stream.tenantId, stream.cameraId) ?? 0,
                  }),
            })),
          onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
        });

  const cameraSource = new HttpCameraSource({
    baseUrl: config.ingestion.cameraUrl,
    internalKey: config.internal.apiKey,
  });

  /*
   * ⚠️ Offline video investigation (P-8 Phase 8). Built from what already exists: the same object
   * store recordings use, the same camera resolve the supervisor uses, and the frame rate the live
   * path is configured with. Nothing here is a second ingestion design.
   */
  /*
   * ⭐ **The stored-media source, signing with the SAME store recordings use** (slice 3).
   *
   * ⛔ **`presignInternalGet`, never `presignGet`.** This URL is read by **ffmpeg inside this
   * container**, so it must name the endpoint this process itself talks to. `presignGet` signs
   * against the *public* endpoint because a browser has to resolve it — handed to a container that
   * is `Connection refused`, which is exactly how the confirm step failed in deployment while
   * passing every unit test.
   *
   * ⚠️ Wrapped per tenant so a session can only ever address its own prefix.
   */
  const frameSources = new StoredMediaFrameSourceFactory(
    async (tenantId, key) =>
      new TenantObjectStore(objectStore, tenantId).presignInternalGet(
        key,
        config.analysis.sourceUrlTtlSeconds,
      ),
    { binary: config.ingestion.ffmpegBinary },
  );

  const analysisWorker = new AnalysisWorker({
    store: mongo.analyses,
    sources: frameSources,
    /* ⭐ The SAME sink every camera pushes to. Not a copy of it, not a second configuration of it. */
    sink: frameSink,
    clock: { now: () => new Date() },
    workerId: defaultWorkerId(hostname(), process.pid),
    onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  const analysisRunner = new AnalysisRunner({
    worker: analysisWorker,
    maxConcurrent: config.analysis.maxConcurrent,
    onLog: (level, msg, fields) => loggerRef.current?.[level]({ ...fields }, msg),
  });

  const analyses = new AnalysisService({
    store: mongo.analyses,
    objectStore,
    probe: new FfprobeMediaProbe({ binary: config.ingestion.ffprobeBinary }),
    cameras: new CameraSourceDirectory(cameraSource),
    clock: { now: () => new Date() },
    ids: {
      analysisId: () => `ana_${randomUUID().replace(/-/g, '')}`,
      sessionId: () => `ases_${randomUUID().replace(/-/g, '')}`,
    },
    capabilityId: config.perception.capabilityId,
    defaultFrameRate: config.ingestion.frameRate,
    playbackTtlSeconds: config.playbackTtlSeconds,
    runner: analysisRunner,
    /*
     * ⚠️ Wired only when an events service is configured. Without one the timeline says it is
     * unavailable — which is honest — rather than returning an empty one that reads as "nothing
     * happened in this recording".
     */
    ...(config.eventsUrl === ''
      ? {}
      : {
          events: new HttpAnalysisEvents({ baseUrl: config.eventsUrl }),
        }),
    ...(config.workflowUrl === ''
      ? {}
      : { incidents: new HttpAnalysisIncidents({ baseUrl: config.workflowUrl }) }),
    snapshots: new FfmpegSnapshotExtractor({ binary: config.ingestion.ffmpegBinary }),
    /* ⛔ INTERNAL, like the frame source: ffmpeg runs in this container, not in a browser. */
    signSource: async (tenantId, key) =>
      new TenantObjectStore(objectStore, tenantId).presignInternalGet(
        key,
        config.analysis.sourceUrlTtlSeconds,
      ),
  });

  const supervisor = new StreamSupervisor({
    cameraSource,
    decoder: new FfmpegDecoder({ binary: config.ingestion.ffmpegBinary }),
    objectStore,
    frameSink,
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

  const { app } = await buildServer({
    config,
    supervisor,
    catalog,
    analyses,
    readiness,
    ...(frameSink instanceof HttpFrameSink ? { perception: frameSink } : {}),
    ...(eventPublisher === undefined ? {} : { eventPublisher }),
    ...(gate !== undefined && assignmentClient !== undefined && frameSink instanceof HttpFrameSink
      ? {
          assignment: {
            gate,
            client: assignmentClient,
            perception: frameSink,
            ...(eventPublisher === undefined ? {} : { publisher: eventPublisher }),
          },
        }
      : {}),
  });
  loggerRef.current = app.log;
  app.log.info(
    {
      perception:
        config.perception.url === ''
          ? 'disabled (null sink)'
          : `${config.perception.url} · ${config.perception.capabilityId}`,
      frameRate: config.ingestion.frameRate,
      queuePerCamera: config.perception.queuePerCamera,
      maxInflight: config.perception.maxInflight,
    },
    'perception sink configured',
  );
  /*
   * ⚠️ Logged at boot either way. "Is this deployment governed by assignment?" must be answerable
   * from the log rather than inferred from a counter that reads zero — the two possible zeroes
   * ("nothing assigned" and "the gate is off, everything is analysed") mean opposite things.
   */
  app.log.info(
    {
      enabled: config.assignment.enabled,
      controlPlane: config.assignment.enabled ? config.ingestion.cameraUrl : null,
      intervalMs: config.assignment.intervalMs,
    },
    config.assignment.enabled
      ? 'camera processing assignment ENABLED — only assigned cameras are analysed'
      : 'camera processing assignment disabled — every camera is analysed',
  );
  assignmentClient?.start();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutdown signal received, draining');
    assignmentClient?.stop();
    /*
     * ⚠️ Analyses are cancelled BEFORE the supervisor stops, and never waited for. A deploy must not
     * be held open by a four-hour analysis; each session checkpoints every chunk, so it resumes from
     * where it stopped rather than from the beginning — which is what the checkpoint is for.
     */
    await analysisRunner.stop();
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
