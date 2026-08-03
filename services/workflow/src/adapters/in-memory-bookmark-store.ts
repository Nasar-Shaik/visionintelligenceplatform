/**
 * A DB-free `BookmarkStore` for unit tests and local wiring. Enforces the same tenant scoping and
 * `(createdAt, id)` keyset paging as the Mongo adapter.
 */
import type { PlaybackBookmark } from '@vip/contracts';
import { TenancyError, type TenantScope } from '@vip/tenancy';
import type { BookmarkPage, BookmarkQuery, BookmarkStore } from '../application/bookmark-store.js';

export class InMemoryBookmarkStore implements BookmarkStore {
  private readonly rows: PlaybackBookmark[] = [];

  private owned(scope: TenantScope, row: PlaybackBookmark): boolean {
    return row.tenantId === scope.tenantId;
  }

  async insert(scope: TenantScope, bookmark: PlaybackBookmark): Promise<void> {
    if (bookmark.tenantId !== scope.tenantId) {
      throw new TenancyError('cross-tenant write refused');
    }
    this.rows.push(bookmark);
  }

  async get(scope: TenantScope, id: string): Promise<PlaybackBookmark | null> {
    return this.rows.find((row) => this.owned(scope, row) && row.id === id) ?? null;
  }

  async list(scope: TenantScope, query: BookmarkQuery): Promise<BookmarkPage> {
    /* Oldest first: a bookmark list is read as a route through the footage, not as a news feed. */
    const all = this.rows
      .filter((row) => this.owned(scope, row) && row.incidentId === query.incidentId)
      .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));

    const start = query.cursor ? all.findIndex((row) => row.id === query.cursor) + 1 : 0;
    const page = all.slice(start, start + query.limit);
    const next = all.length > start + query.limit ? page[page.length - 1]?.id : undefined;
    return { items: page, ...(next !== undefined ? { nextCursor: next } : {}) };
  }

  async remove(scope: TenantScope, id: string): Promise<boolean> {
    const index = this.rows.findIndex((row) => this.owned(scope, row) && row.id === id);
    if (index < 0) return false;
    this.rows.splice(index, 1);
    return true;
  }
}
