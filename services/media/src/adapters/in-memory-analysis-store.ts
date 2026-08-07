/**
 * Adapter: an in-memory `AnalysisStore` for unit tests and for a media deployment running without
 * Mongo (P-8 Phase 8).
 *
 * ⚠️ **It enforces the tenant scope rather than assuming it.** A fake that ignores the scope makes
 * every isolation test vacuous — the service would pass its tests and leak in production, which is
 * precisely the class of defect the guard exists to prevent. So reads filter on `tenantId` and
 * writes stamp it, exactly as `TenantRepository` does.
 */
import {
  isTerminalSessionState,
  type AnalysisSessionState,
  type VideoAnalysisQuery,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { AnalysisDoc, AnalysisSessionDoc } from '../domain/analysis.js';
import type { AnalysisStore } from '../application/ports.js';
import { DuplicateSessionError } from '../application/errors.js';
import { decodeCursor, encodeCursor } from './catalog-cursor.js';

export class InMemoryAnalysisStore implements AnalysisStore {
  readonly #analyses = new Map<string, AnalysisDoc>();
  readonly #sessions = new Map<string, AnalysisSessionDoc>();

  async putAnalysis(scope: TenantScope, doc: AnalysisDoc): Promise<void> {
    this.#analyses.set(doc._id, { ...doc, tenantId: scope.tenantId });
  }

  async getAnalysis(scope: TenantScope, id: string): Promise<AnalysisDoc | null> {
    const doc = this.#analyses.get(id);
    return doc !== undefined && doc.tenantId === scope.tenantId ? doc : null;
  }

  async listAnalyses(
    scope: TenantScope,
    q: VideoAnalysisQuery,
  ): Promise<{ items: AnalysisDoc[]; nextCursor?: string }> {
    const cur = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    const rows = [...this.#analyses.values()]
      .filter((d) => d.tenantId === scope.tenantId)
      .filter((d) => q.cameraId === undefined || d.cameraId === q.cameraId)
      .filter((d) => q.state === undefined || d.state === q.state)
      .filter(
        (d) =>
          cur === undefined ||
          d.createdAt < cur.sortKey ||
          (d.createdAt === cur.sortKey && d._id < cur.id),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b._id.localeCompare(a._id)
          : b.createdAt.localeCompare(a.createdAt),
      );
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
    const doc = await this.getAnalysis(scope, id);
    if (doc === null) return false;
    for (const session of await this.listSessions(scope, id)) this.#sessions.delete(session._id);
    return this.#analyses.delete(id);
  }

  /**
   * ⚠️ Enforces the SAME uniqueness the Mongo adapter gets from its index.
   *
   * A fake that accepts a duplicate `(analysisId, sequence)` makes the race test vacuous — it would
   * pass here and fail in production, which is the failure mode a test double exists to prevent.
   */
  async putSession(scope: TenantScope, doc: AnalysisSessionDoc): Promise<void> {
    const clash = [...this.#sessions.values()].find(
      (s) =>
        s._id !== doc._id &&
        s.tenantId === scope.tenantId &&
        s.analysisId === doc.analysisId &&
        s.sequence === doc.sequence,
    );
    if (clash !== undefined) throw new DuplicateSessionError(doc.analysisId, doc.sequence);
    this.#sessions.set(doc._id, { ...doc, tenantId: scope.tenantId });
  }

  async getSession(scope: TenantScope, id: string): Promise<AnalysisSessionDoc | null> {
    const doc = this.#sessions.get(id);
    return doc !== undefined && doc.tenantId === scope.tenantId ? doc : null;
  }

  /**
   * ⚠️ Enforces the SAME expectation the Mongo filter does. A fake that always accepts would make
   * every race test vacuous — it would pass here and race in production, which is exactly the
   * failure a test double exists to prevent.
   */
  async compareAndSetSession(
    scope: TenantScope,
    id: string,
    expected: { state: AnalysisSessionState; workerId: string | null },
    next: AnalysisSessionDoc,
  ): Promise<boolean> {
    /*
     * ⛔ **No `await` between the read and the write, and that is the entire point.**
     *
     * The first version of this method did `const current = await this.getSession(...)` and then
     * compared. Two workers claiming one session both got past the check and both "won" — because
     * the await yielded the event loop between reading and writing, which is the exact
     * read-then-write hazard this method exists to eliminate. The race test caught it, which is what
     * the test was for; a permissive double would have passed it and raced in production.
     *
     * Mongo gets atomicity from a single `updateOne` carrying the filter. Here it comes from doing
     * the whole compare-and-set inside one synchronous run of the event loop, reading the Map
     * directly rather than through the async accessor.
     */
    const current = this.#sessions.get(id);
    if (current === undefined || current.tenantId !== scope.tenantId) return false;
    if (current.state !== expected.state) return false;
    const heldBy = current.lease?.workerId ?? null;
    if (heldBy !== expected.workerId) return false;
    this.#sessions.set(id, { ...next, tenantId: scope.tenantId });
    return true;
  }

  async listSessions(scope: TenantScope, analysisId: string): Promise<AnalysisSessionDoc[]> {
    return [...this.#sessions.values()]
      .filter((s) => s.tenantId === scope.tenantId && s.analysisId === analysisId)
      .sort((a, b) => b.sequence - a.sequence);
  }

  async listActiveSessions(scope: TenantScope): Promise<AnalysisSessionDoc[]> {
    return [...this.#sessions.values()]
      .filter((s) => s.tenantId === scope.tenantId && !isTerminalSessionState(s.state))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
