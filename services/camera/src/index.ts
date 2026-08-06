/**
 * Bootstrap / composition root: load & validate config, connect MongoDB, derive the credential
 * vault (@vip/crypto SecretBox) once from the app secret, wire the tenant-scoped repository and
 * application service, build the server, listen, and shut down gracefully on SIGTERM/SIGINT
 * (drain requests, then close Mongo). The only file that touches the process/network + driver.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { loadDotEnv } from '@vip/config';
import { TenantRepository } from '@vip/tenancy';
import { SecretBox } from '@vip/crypto';
import { loadConfig } from './config/env.js';
import { connectMongo } from './adapters/mongo.js';
import { ReadinessRegistry } from './application/readiness.js';
import { LoggingEventPublisher } from './application/events.js';
import { CameraService } from './application/camera-service.js';
import { AssignmentService } from './application/assignment-service.js';
import { HttpRuleAvailability } from './application/capability-matrix.js';
import { HttpDiscoveryProvider, UnavailableDiscoveryProvider } from './application/discovery.js';
import { HttpStreamProbe, UnavailableStreamProbe } from './application/stream-probe.js';
import { buildServer } from './transport/server.js';

const clock = { now: () => new Date() };
const ids = {
  cameraId: () => `cam_${randomUUID().replace(/-/g, '')}`,
  probeId: () => `prb_${randomUUID().replace(/-/g, '')}`,
};

/** Audit-entry ids. Injected so the domain stays deterministic under test. */
const assignmentIds = { historyId: () => `ash_${randomUUID().replace(/-/g, '')}` };

async function main(): Promise<void> {
  loadDotEnv(); // load .env into process.env once (no-op in prod / tests)
  const config = loadConfig();
  const mongo = await connectMongo({ uri: config.database.uri });
  const vault = SecretBox.fromSecret(config.crypto.encryptionKey);

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

  // P-1: ONVIF discovery is a capability the camera service CALLS, not one it implements — the
  // platform's only tested ONVIF stack lives in the AI runtime (ADR-0023). Unconfigured is a valid
  // deployment: it reports discovery as unavailable instead of refusing to start.
  const discovery = config.discoveryUrl
    ? new HttpDiscoveryProvider({
        baseUrl: config.discoveryUrl,
        internalKey: config.internal.apiKey,
      })
    : new UnavailableDiscoveryProvider();

  // P-2: stream validation is the same arrangement — the runtime owns the decode path, the camera
  // service owns the lifecycle it feeds (ADR-0024). One URL configures both, because they are the
  // same runtime; a deployment without it can still onboard cameras, and says plainly that it cannot
  // test them rather than reporting every camera as failed.
  const probe = config.discoveryUrl
    ? new HttpStreamProbe({
        baseUrl: config.discoveryUrl,
        internalKey: config.internal.apiKey,
      })
    : new UnavailableStreamProbe();

  const service = new CameraService({
    cameras: new TenantRepository(mongo.cameras),
    // P-2.2: the immutable probe archive. Its own collection rather than an array on the camera —
    // probe reports are ~2 KB each and a camera probed every five minutes would otherwise grow its
    // own document past what a single record should ever hold.
    probes: new TenantRepository(mongo.probes),
    vault,
    clock,
    ids,
    publisher,
    discovery,
    probe,
  });

  /*
   * Camera Processing Assignment (P-8 Phase 6) — the control plane.
   *
   * ⚠️ Always constructed. Unlike perception and the event bridge, this has no "off" switch and
   * needs none: with no runtime registered, every camera is `unassigned`, the plan is empty, and the
   * deployment behaves exactly as it did before this milestone. Making it optional would have added
   * a flag whose only effect is to hide the reason nothing is being analysed.
   */
  const assignments = new AssignmentService({
    assignments: mongo.assignments,
    profiles: mongo.processingProfiles,
    runtimes: mongo.processingRuntimes,
    history: mongo.assignmentHistory,
    groups: mongo.cameraGroups,
    facts: mongo.processingFacts,
    meta: mongo.assignmentMeta,
    /*
     * ⚠️ The rule catalogue, for the capability matrix's `rules` fact only. Unconfigured is a valid
     * deployment: the fact reads `unknown`, which is the truth, rather than `false`, which would
     * tell an operator their rules are missing when nobody has looked.
     */
    ...(config.rulesUrl === '' ? {} : { rules: new HttpRuleAvailability(config.rulesUrl) }),
    cameras: new TenantRepository(mongo.cameras),
    clock,
    ids: assignmentIds,
    publisher,
  });

  const { app } = await buildServer({ config, service, readiness, assignments });
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
  console.error('fatal: camera service failed to start', err);
  process.exit(1);
});
