/**
 * Adapter: MongoDB connection + collections for the media catalog (P2-2 G-2). Owns connection
 * lifecycle, index creation, and a readiness ping. The `recordings`/`clips` collections are handed to
 * the @vip/tenancy-backed `MongoMediaCatalog` by the composition root — no other module talks to the
 * driver (STORAGE_ARCHITECTURE). Media's live path (ingestion) does not need Mongo; the catalog does.
 */
import { MongoClient, type Db } from 'mongodb';
import type { RecordingDoc } from '../domain/recording.js';
import type { ClipDoc } from '../domain/clip.js';
import type { AnalysisDoc, AnalysisSessionDoc } from '../domain/analysis.js';
import { MongoMediaCatalog } from './mongo-media-catalog.js';
import { MongoAnalysisStore } from './mongo-analysis-store.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  catalog: MongoMediaCatalog;
  /** Offline video investigation (P-8 Phase 8). */
  analyses: MongoAnalysisStore;
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
  const db = opts.dbName ? client.db(opts.dbName) : client.db();
  const recordings = db.collection<RecordingDoc>('recordings');
  const clips = db.collection<ClipDoc>('clips');
  const catalog = new MongoMediaCatalog(recordings, clips);
  await catalog.ensureIndexes();
  const analyses = new MongoAnalysisStore(
    db.collection<AnalysisDoc>('analyses'),
    db.collection<AnalysisSessionDoc>('analysisSessions'),
  );
  await analyses.ensureIndexes();
  return {
    client,
    db,
    catalog,
    analyses,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}
