/**
 * Adapter: `BookmarkStore` over MongoDB, routed through the @vip/tenancy `TenantRepository` so every
 * read and write is tenant-scoped structurally. Paging is oldest-first keyset by `(at, id)` — the
 * order an investigator reads a bookmark list in, because it is a route through the footage.
 */
import type { Collection } from 'mongodb';
import type { PlaybackBookmark } from '@vip/contracts';
import { TenantRepository, type TenantScope } from '@vip/tenancy';
import type { BookmarkPage, BookmarkQuery, BookmarkStore } from '../application/bookmark-store.js';

export interface MongoBookmarkStoreDeps {
  bookmarks: Collection<PlaybackBookmark>;
}

/** Drop Mongo's `_id`; the contract has no such field and a leaked ObjectId is storage detail. */
function strip(row: PlaybackBookmark & { _id?: unknown }): PlaybackBookmark {
  const rest = { ...row };
  delete rest._id;
  return rest as PlaybackBookmark;
}

function encodeCursor(row: PlaybackBookmark): string {
  return Buffer.from(`${row.at}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return at && id ? { at, id } : null;
  } catch {
    return null;
  }
}

export class MongoBookmarkStore implements BookmarkStore {
  private readonly bookmarks: TenantRepository<PlaybackBookmark>;

  constructor(deps: MongoBookmarkStoreDeps) {
    this.bookmarks = new TenantRepository<PlaybackBookmark>(deps.bookmarks);
  }

  async insert(scope: TenantScope, bookmark: PlaybackBookmark): Promise<void> {
    await this.bookmarks.insertOne(scope, bookmark as Omit<PlaybackBookmark, 'tenantId'>);
  }

  async get(scope: TenantScope, id: string): Promise<PlaybackBookmark | null> {
    const row = await this.bookmarks.findOne(scope, { id } as never);
    return row === null ? null : strip(row);
  }

  async list(scope: TenantScope, query: BookmarkQuery): Promise<BookmarkPage> {
    const filter: Record<string, unknown> = { incidentId: query.incidentId };
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    if (after) {
      /* Keyset, oldest-first: strictly after (at, id). */
      filter.$or = [{ at: { $gt: after.at } }, { at: after.at, id: { $gt: after.id } }];
    }
    const rows = await this.bookmarks.findMany(scope, filter as never, {
      sort: { at: 1, id: 1 } as never,
      limit: query.limit + 1,
    });
    const items = rows.map(strip);
    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    const last = page[page.length - 1];
    return {
      items: page,
      ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
    };
  }

  async remove(scope: TenantScope, id: string): Promise<boolean> {
    return (await this.bookmarks.deleteOne(scope, { id } as never)) > 0;
  }
}
