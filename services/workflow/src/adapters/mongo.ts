/**
 * Adapter: MongoDB connection + the `incidents` collection. Owns connection lifecycle, index
 * creation, and a readiness ping. The collection is handed to a @vip/tenancy repository by the
 * composition root — no other module talks to the driver. Uniqueness on `(tenantId, source.dedupKey)`
 * is what makes candidate promotion idempotent even across restarts / concurrent consumers.
 */
import { MongoClient, type Collection, type Db, type IndexSpecification } from 'mongodb';
import type { Incident } from '@vip/contracts';
import { INCIDENT_INDEXES } from './indexes.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  incidents: Collection<Incident>;
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
  const incidents = db.collection<Incident>('incidents');
  await ensureIndexes(incidents);
  return {
    client,
    db,
    incidents,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Create every declared index. The set lives in `indexes.ts` as **data**, so the coverage test can
 * read the same declaration the driver does — an index that exists only in this function is an
 * index no test can reason about, which is how TD-22 happened.
 *
 * Directions: the cursor pair is descending (newest first) and equality keys ascending. Direction
 * does not affect coverage for a uniformly-ordered sort — MongoDB walks an index backwards just as
 * cheaply — but matching the sort exactly keeps the plan obvious in `explain()`.
 *
 * No **pre-existing** index changed shape here: the three P1-8 indexes are declared with exactly the
 * keys and directions they were created with, so this is purely additive and needs no drop/rebuild
 * reconcile (the events context does need one — see its `ensureIndexes`).
 */
async function ensureIndexes(incidents: Collection<Incident>): Promise<void> {
  for (const spec of INCIDENT_INDEXES) {
    if (spec.implicit) continue;
    const keys: Record<string, 1 | -1> = {};
    for (const key of spec.keys) keys[key] = spec.descending?.includes(key) ? -1 : 1;
    await incidents.createIndex(keys as IndexSpecification, {
      name: spec.name,
      ...(spec.unique ? { unique: true } : {}),
    });
  }
}
