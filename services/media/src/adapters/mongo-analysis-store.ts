/**
 * Adapter: `AnalysisStore` over MongoDB, routed through @vip/tenancy `TenantRepository` so every
 * read and write is tenant-scoped structurally (Law 5) — P-8 Phase 8.
 *
 * Listings use the guard's `aggregate` (which prepends the tenant `$match`) with keyset pagination,
 * newest-first by `(createdAt, _id)`; ISO timestamps order as strings. The same approach the
 * recordings and clips catalogue already uses, deliberately, so there is one paging idiom here.
 */
import type { Collection } from 'mongodb';
import type { VideoAnalysisQuery } from '@vip/contracts';
import { TenantRepository, type PlainObject, type TenantScope } from '@vip/tenancy';
import type { AnalysisDoc, AnalysisSessionDoc } from '../domain/analysis.js';
import type { AnalysisStore } from '../application/ports.js';
import { DuplicateSessionError } from '../application/errors.js';
import { decodeCursor, encodeCursor } from './catalog-cursor.js';

export class MongoAnalysisStore implements AnalysisStore {
  readonly #analyses: TenantRepository<AnalysisDoc>;
  readonly #sessions: TenantRepository<AnalysisSessionDoc>;
  readonly #analysesCol: Collection<AnalysisDoc>;
  readonly #sessionsCol: Collection<AnalysisSessionDoc>;

  constructor(analyses: Collection<AnalysisDoc>, sessions: Collection<AnalysisSessionDoc>) {
    this.#analyses = new TenantRepository<AnalysisDoc>(analyses);
    this.#sessions = new TenantRepository<AnalysisSessionDoc>(sessions);
    this.#analysesCol = analyses;
    this.#sessionsCol = sessions;
  }

  async putAnalysis(scope: TenantScope, doc: AnalysisDoc): Promise<void> {
    const existing = await this.#analyses.findOne(scope, { _id: doc._id } as PlainObject);
    if (existing === null) {
      await this.#analyses.insertOne(scope, doc as Omit<AnalysisDoc, 'tenantId'>);
      return;
    }
    await this.#analyses.updateOne(scope, { _id: doc._id } as PlainObject, {
      $set: doc as unknown as PlainObject,
    });
  }

  async getAnalysis(scope: TenantScope, id: string): Promise<AnalysisDoc | null> {
    return this.#analyses.findOne(scope, { _id: id } as PlainObject);
  }

  async listAnalyses(
    scope: TenantScope,
    q: VideoAnalysisQuery,
  ): Promise<{ items: AnalysisDoc[]; nextCursor?: string }> {
    const match: PlainObject = {};
    if (q.cameraId !== undefined) match['cameraId'] = q.cameraId;
    if (q.state !== undefined) match['state'] = q.state;
    const cur = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    if (cur !== undefined) {
      match['$or'] = [
        { createdAt: { $lt: cur.sortKey } },
        { createdAt: cur.sortKey, _id: { $lt: cur.id } },
      ];
    }
    const rows = await this.#analyses.aggregate<AnalysisDoc>(scope, [
      { $match: match },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: q.limit + 1 },
    ]);
    if (rows.length <= q.limit) return { items: rows };
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return {
      items,
      ...(last === undefined
        ? {}
        : { nextCursor: encodeCursor({ sortKey: last.createdAt, id: last._id }) }),
    };
  }

  async deleteAnalysis(scope: TenantScope, id: string): Promise<boolean> {
    /*
     * ⚠️ Sessions go with it — a session pointing at an analysis that no longer exists is a record
     * nothing can interpret. Deleted one at a time **through the guard** rather than with a bulk
     * delete on the raw collection: the guard is what makes the tenant scope structural, and the
     * count is bounded at `maxSessionsPerAnalysis` (20) by the contract, so the loop has a ceiling.
     * The service already refuses to delete while a session is running, so nothing here is in flight.
     */
    for (const session of await this.listSessions(scope, id)) {
      await this.#sessions.deleteOne(scope, { _id: session._id } as PlainObject);
    }
    return (await this.#analyses.deleteOne(scope, { _id: id } as PlainObject)) > 0;
  }

  /**
   * ⚠️ A duplicate `(tenantId, analysisId, sequence)` is surfaced, not swallowed.
   *
   * Deciding a new session's sequence is a read-then-write: two operators pressing "run" together
   * both see zero existing sessions and both claim sequence 1. The check in the service cannot close
   * that on its own — no amount of re-reading makes a read-then-write atomic — so the **unique index
   * decides**, and the loser gets a conflict naming what happened rather than a second session that
   * silently shares a number with the first.
   */
  async putSession(scope: TenantScope, doc: AnalysisSessionDoc): Promise<void> {
    const existing = await this.#sessions.findOne(scope, { _id: doc._id } as PlainObject);
    if (existing === null) {
      try {
        await this.#sessions.insertOne(scope, doc as Omit<AnalysisSessionDoc, 'tenantId'>);
      } catch (err: unknown) {
        if ((err as { code?: number }).code === 11000) {
          throw new DuplicateSessionError(doc.analysisId, doc.sequence);
        }
        throw err;
      }
      return;
    }
    await this.#sessions.updateOne(scope, { _id: doc._id } as PlainObject, {
      $set: doc as unknown as PlainObject,
    });
  }

  async getSession(scope: TenantScope, id: string): Promise<AnalysisSessionDoc | null> {
    return this.#sessions.findOne(scope, { _id: id } as PlainObject);
  }

  async listSessions(scope: TenantScope, analysisId: string): Promise<AnalysisSessionDoc[]> {
    return this.#sessions.aggregate<AnalysisSessionDoc>(scope, [
      { $match: { analysisId } },
      { $sort: { sequence: -1 } },
    ]);
  }

  async listActiveSessions(scope: TenantScope): Promise<AnalysisSessionDoc[]> {
    return this.#sessions.aggregate<AnalysisSessionDoc>(scope, [
      { $match: { state: { $in: ['queued', 'running'] } } },
      { $sort: { createdAt: 1 } },
    ]);
  }

  /**
   * ⚠️ Every index leads with `tenantId`, because every query does — the guard prepends it, so an
   * index that does not would be unusable for the only shape this collection is ever read in
   * (INDEX_POLICY).
   */
  async ensureIndexes(): Promise<void> {
    await this.#analysesCol.createIndexes([
      { key: { tenantId: 1, createdAt: -1, _id: -1 }, name: 'analyses_tenant_created' },
      { key: { tenantId: 1, cameraId: 1, createdAt: -1 }, name: 'analyses_tenant_camera_created' },
      { key: { tenantId: 1, state: 1, createdAt: -1 }, name: 'analyses_tenant_state_created' },
    ]);
    await this.#sessionsCol.createIndexes([
      /*
       * ⭐ UNIQUE, and that is the point rather than an optimisation. It is the only thing that
       * makes "one run number per analysis" true under two simultaneous requests; the service's
       * check is the friendly path and this is the guarantee.
       */
      {
        key: { tenantId: 1, analysisId: 1, sequence: -1 },
        name: 'sessions_tenant_analysis_seq',
        unique: true,
      },
      { key: { tenantId: 1, state: 1, createdAt: 1 }, name: 'sessions_tenant_state_created' },
    ]);
  }
}
