/**
 * Adapter: MongoDB connection + the `events` collection for the event store. Owns connection
 * lifecycle, index creation, and a readiness ping. The collection is handed to a @vip/tenancy
 * repository by the composition root — no other module talks to the driver (STORAGE_ARCHITECTURE).
 * The stored document is an `EventEnvelope` plus a `dedupKey`; the unique `{tenantId, dedupKey}`
 * index is what makes normalization idempotent (at-least-once safe).
 */
import { MongoClient, type Collection, type Db, type IndexSpecification } from 'mongodb';
import type { EventEnvelope } from '@vip/contracts';
import { EVENT_INDEXES } from './indexes.js';

/** The persisted shape: the envelope + its dedup key (tenantId is already on the envelope). */
export interface EventDoc extends EventEnvelope {
  dedupKey: string;
}

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  events: Collection<EventDoc>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectMongoOptions {
  uri: string;
  dbName?: string;
  serverSelectionTimeoutMS?: number;
}

export async function connectMongo(opts: ConnectMongoOptions): Promise<MongoAdapter> {
  const client = new MongoClient(opts.uri, {
    serverSelectionTimeoutMS: opts.serverSelectionTimeoutMS ?? 5000,
  });
  await client.connect();
  const db = opts.dbName ? client.db(opts.dbName) : client.db();
  const events = db.collection<EventDoc>('events');
  await ensureIndexes(events);
  return {
    client,
    db,
    events,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Create every index declared in `indexes.ts`, reconciling names whose key set changed.
 *
 * ⚠️ **Three pre-existing indexes gained the cursor key `id` in P-5.0** (`tenant_occurredAt`,
 * `tenant_type_time`, `tenant_camera_time`) — they stopped at `occurredAt` and so abandoned the
 * `(occurredAt, id)` sort. Re-declaring an existing name with different keys is an
 * `IndexOptionsConflict`, which would fail the service at boot, so a changed key set is dropped and
 * rebuilt. Each old index is a strict prefix of its replacement, so nothing loses coverage — but
 * the rebuild is real work on a large collection and is logged for exactly that reason.
 */
async function ensureIndexes(events: Collection<EventDoc>): Promise<void> {
  const existing = await events.indexes().catch(() => []);
  for (const spec of EVENT_INDEXES) {
    if (spec.implicit) continue;
    const keys: Record<string, 1 | -1> = {};
    for (const key of spec.keys) keys[key] = spec.descending?.includes(key) ? -1 : 1;

    const current = existing.find((index) => index.name === spec.name);
    if (current && JSON.stringify(current.key) !== JSON.stringify(keys)) {
      await events.dropIndex(spec.name);
    }
    await events.createIndex(keys as IndexSpecification, {
      name: spec.name,
      ...(spec.unique ? { unique: true } : {}),
    });
  }
}
