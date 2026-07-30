/**
 * A DB-free `CustodyLog` for unit tests + local wiring. Append-only; entries read oldest-first by
 * `seq` with a simple seq cursor. Enforces tenant scoping, mirroring the Mongo adapter.
 */
import type { TenantScope } from '@vip/tenancy';
import type { CustodyDoc } from '../domain/custody.js';
import type { CustodyLog } from '../application/ports.js';

const encodeSeq = (seq: number): string => Buffer.from(String(seq), 'utf8').toString('base64url');
const decodeSeq = (raw: string): number | undefined => {
  const n = Number(Buffer.from(raw, 'base64url').toString('utf8'));
  return Number.isFinite(n) ? n : undefined;
};

export class InMemoryCustodyLog implements CustodyLog {
  readonly #rows: CustodyDoc[] = [];

  async append(_scope: TenantScope, entry: CustodyDoc): Promise<void> {
    this.#rows.push(structuredClone(entry));
  }

  async head(scope: TenantScope, evidenceId: string): Promise<CustodyDoc | null> {
    const entries = this.#for(scope, evidenceId);
    return entries.length ? structuredClone(entries[entries.length - 1]!) : null;
  }

  async list(
    scope: TenantScope,
    evidenceId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: CustodyDoc[]; nextCursor?: string }> {
    let entries = this.#for(scope, evidenceId);
    const after = opts.cursor ? decodeSeq(opts.cursor) : undefined;
    if (after !== undefined) entries = entries.filter((e) => e.seq > after);
    const items = entries.slice(0, opts.limit).map((e) => structuredClone(e));
    if (entries.length <= opts.limit) return { items };
    return { items, nextCursor: encodeSeq(items[items.length - 1]!.seq) };
  }

  #for(scope: TenantScope, evidenceId: string): CustodyDoc[] {
    return this.#rows
      .filter((r) => r.tenantId === scope.tenantId && r.evidenceId === evidenceId)
      .sort((a, b) => a.seq - b.seq);
  }
}
