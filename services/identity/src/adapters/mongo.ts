/**
 * Adapter: MongoDB connection + collections for the identity service. `users` is tenant-scoped
 * (driven through @vip/tenancy); `refresh_tokens` is control-plane (looked up by token hash).
 * Owns connection lifecycle, indexes, and a readiness ping — the only module that talks to the
 * driver (STORAGE_ARCHITECTURE).
 */
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { UserDoc } from '../domain/user.js';
import type { RefreshTokenDoc } from '../domain/refresh.js';

export interface MongoAdapter {
  client: MongoClient;
  db: Db;
  users: Collection<UserDoc>;
  refreshTokens: Collection<RefreshTokenDoc>;
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
  // Honor the database in the connection string; `dbName` overrides (used by tests for isolation).
  const db = opts.dbName ? client.db(opts.dbName) : client.db();
  const users = db.collection<UserDoc>('users');
  const refreshTokens = db.collection<RefreshTokenDoc>('refresh_tokens');
  await ensureIndexes(users, refreshTokens);
  return {
    client,
    db,
    users,
    refreshTokens,
    async ping() {
      await db.command({ ping: 1 });
    },
    async close() {
      await client.close();
    },
  };
}

async function ensureIndexes(
  users: Collection<UserDoc>,
  refreshTokens: Collection<RefreshTokenDoc>,
): Promise<void> {
  // Email is unique within a tenant; tenant-leading so queries are tenant-scoped (Law 5).
  await users.createIndex({ tenantId: 1, email: 1 }, { unique: true, name: 'uniq_tenant_email' });
  // Reuse-detection revokes by family. Expiry is enforced logically (isUsable); a periodic
  // reaper of past-`expiresAt` records is a later optimization (expiresAt stored as an ISO string).
  await refreshTokens.createIndex({ familyId: 1 }, { name: 'family' });
  await refreshTokens.createIndex({ principalId: 1 }, { name: 'principal' });
}
