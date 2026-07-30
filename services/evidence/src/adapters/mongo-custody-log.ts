/**
 * Adapter: `CustodyLog` over MongoDB via @vip/tenancy `TenantRepository` (tenant-scoped, Law 5).
 * Append-only; a unique `(tenantId, evidenceId, seq)` index makes the hash-chain sequence collision-
 * proof. `head` reads the latest entry; `list` reads oldest-first by `seq` with a numeric seq cursor.
 */
import type { Collection } from 'mongodb';
import { TenantRepository, type PlainObject, type TenantScope } from '@vip/tenancy';
import type { CustodyDoc } from '../domain/custody.js';
import type { CustodyLog } from '../application/ports.js';

const encodeSeq = (seq: number): string => Buffer.from(String(seq), 'utf8').toString('base64url');
const decodeSeq = (raw: string): number | undefined => {
  const n = Number(Buffer.from(raw, 'base64url').toString('utf8'));
  return Number.isFinite(n) ? n : undefined;
};

export class MongoCustodyLog implements CustodyLog {
  readonly #repo: TenantRepository<CustodyDoc>;
  readonly #col: Collection<CustodyDoc>;

  constructor(col: Collection<CustodyDoc>) {
    this.#repo = new TenantRepository<CustodyDoc>(col);
    this.#col = col;
  }

  async append(scope: TenantScope, entry: CustodyDoc): Promise<void> {
    await this.#repo.insertOne(scope, entry as Omit<CustodyDoc, 'tenantId'>);
  }

  async head(scope: TenantScope, evidenceId: string): Promise<CustodyDoc | null> {
    const rows = await this.#repo.aggregate<CustodyDoc>(scope, [
      { $match: { evidenceId } },
      { $sort: { seq: -1 } },
      { $limit: 1 },
    ]);
    return rows[0] ?? null;
  }

  async list(
    scope: TenantScope,
    evidenceId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: CustodyDoc[]; nextCursor?: string }> {
    const match: PlainObject = { evidenceId };
    const after = opts.cursor ? decodeSeq(opts.cursor) : undefined;
    if (after !== undefined) match['seq'] = { $gt: after };
    const rows = await this.#repo.aggregate<CustodyDoc>(scope, [
      { $match: match },
      { $sort: { seq: 1 } },
      { $limit: opts.limit + 1 },
    ]);
    if (rows.length <= opts.limit) return { items: rows };
    const items = rows.slice(0, opts.limit);
    return { items, nextCursor: encodeSeq(items[items.length - 1]!.seq) };
  }

  async ensureIndexes(): Promise<void> {
    await this.#col.createIndex(
      { tenantId: 1, evidenceId: 1, seq: 1 },
      { name: 'tenant_evidence_seq', unique: true },
    );
  }
}
