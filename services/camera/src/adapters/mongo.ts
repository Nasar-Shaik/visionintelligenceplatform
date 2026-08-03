/**
 * Adapter: MongoDB connection + collections for the camera service. Owns connection lifecycle,
 * index creation, and a readiness ping. The `cameras` and `camera_probes` collections are
 * handed to @vip/tenancy repositories by the composition root — no other module talks to the driver
 * (STORAGE_ARCHITECTURE).
 */
import { MongoClient, type Collection, type Db, type IndexSpecification } from 'mongodb';
import type { CameraDoc } from '../domain/camera.js';
import type { ProbeRecordDoc } from '../domain/probe-archive.js';
import { CAMERA_INDEXES, PROBE_INDEXES } from './indexes.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  cameras: Collection<CameraDoc>;
  /** The immutable probe archive (P-2.2). Append-only: nothing in the service ever updates it. */
  probes: Collection<ProbeRecordDoc>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectMongoOptions {
  uri: string;
  dbName?: string;
  /** Fail fast if no server is selectable within this many ms (default 5000). */
  serverSelectionTimeoutMS?: number;
}

export async function connectMongo(opts: ConnectMongoOptions): Promise<MongoAdapter> {
  const client = new MongoClient(opts.uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 5000,
  });
  await client.connect();
  // Honor the database in the connection string; `dbName` overrides (used by tests for isolation).
  const db = opts.dbName ? client.db(opts.dbName) : client.db();
  const cameras = db.collection<CameraDoc>('cameras');
  const probes = db.collection<ProbeRecordDoc>('camera_probes');
  await ensureIndexes(cameras, probes);
  return {
    client,
    db,
    cameras,
    probes,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(
  cameras: Collection<CameraDoc>,
  probes: Collection<ProbeRecordDoc>,
): Promise<void> {
  /*
   * Created from the declared specs so the code and the coverage test cannot disagree. Every index
   * is tenant-leading (Law 5); every camera index ends in `_id`, the cursor key — see `indexes.ts`
   * for why the trailing key decides whether paging costs O(page) or O(matches).
   */
  /*
   * ⚠️ A changed key set under an existing name is dropped and rebuilt, **because otherwise the
   * service does not start.**
   *
   * Found by deploying against a database that had run an earlier build, which is the only way to
   * find it: every test runs against a fresh database, so the conflict cannot occur there. When
   * `tenant_zone` gained its `_id` cursor key, MongoDB answered `IndexOptionsConflict` —
   * *"An existing index has the same name as the requested index"* — and the camera service exited
   * at boot. On a customer's machine that is an upgrade that takes the fleet offline.
   *
   * Each old index is a strict prefix of its replacement, so nothing loses coverage during the
   * rebuild. The evidence and events stores already did this; camera and tenant did not.
   */
  const reconcile = async <T extends { name?: string; key?: unknown }>(
    collection: Collection<never>,
    name: string,
    keys: Record<string, 1 | -1>,
    existing: readonly T[],
    options: { unique?: boolean } = {},
  ) => {
    const current = existing.find((index) => index.name === name);
    if (current && JSON.stringify(current.key) !== JSON.stringify(keys)) {
      await collection.dropIndex(name);
    }
    await collection.createIndex(keys as IndexSpecification, {
      name,
      ...(options.unique ? { unique: true } : {}),
    });
  };

  const cameraIndexes = await cameras.indexes().catch(() => []);
  for (const spec of CAMERA_INDEXES) {
    if (spec.implicit) continue; // `_id_` is created by MongoDB; declared only so coverage sees it.
    const keys = Object.fromEntries(spec.keys.map((key) => [key, 1])) as Record<string, 1 | -1>;
    await reconcile(
      cameras as unknown as Collection<never>,
      spec.name,
      keys,
      cameraIndexes,
      spec.unique ? { unique: true } : {},
    );
  }
  // P-2.2: probe history is read newest-first per camera, and aggregated per tenant for the fleet
  // view. Descending on `at` so both reads walk the index rather than sorting a scan.
  const probeIndexes = await probes.indexes().catch(() => []);
  for (const spec of PROBE_INDEXES) {
    const keys = Object.fromEntries(spec.keys.map((key) => [key, key === 'at' ? -1 : 1])) as Record<
      string,
      1 | -1
    >;
    await reconcile(probes as unknown as Collection<never>, spec.name, keys, probeIndexes);
  }
}
