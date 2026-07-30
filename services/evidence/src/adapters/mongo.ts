/**
 * Adapter: MongoDB connection + collections for the Evidence context. Owns connection lifecycle,
 * index creation, and a readiness ping. The `evidence` (manifests) + `evidence_custody` (chain-of-
 * custody) collections are handed to the @vip/tenancy-backed stores by the composition root — no other
 * module talks to the driver.
 */
import { MongoClient, type Db } from 'mongodb';
import type { EvidenceDoc } from '../domain/evidence.js';
import type { CustodyDoc } from '../domain/custody.js';
import { MongoEvidenceStore } from './mongo-evidence-store.js';
import { MongoCustodyLog } from './mongo-custody-log.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  evidence: MongoEvidenceStore;
  custody: MongoCustodyLog;
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
  const evidence = new MongoEvidenceStore(db.collection<EvidenceDoc>('evidence'));
  const custody = new MongoCustodyLog(db.collection<CustodyDoc>('evidence_custody'));
  await evidence.ensureIndexes();
  await custody.ensureIndexes();
  return {
    client,
    db,
    evidence,
    custody,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}
