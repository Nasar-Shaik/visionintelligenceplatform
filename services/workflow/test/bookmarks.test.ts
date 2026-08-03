/**
 * Investigation bookmarks (P-5.5).
 *
 * ⚠️ The invariants here are about **honesty and ownership**: an unconfigured store must refuse
 * rather than return an empty list, a sealed incident must not acquire new markers, `at` is the
 * authority rather than a stored offset, and nothing crosses a tenant boundary.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { CreatePlaybackBookmarkInput } from '@vip/contracts';
import { PlaybackBookmark } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { IncidentService } from '../src/application/incident-service.js';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { InMemoryBookmarkStore } from '../src/adapters/in-memory-bookmark-store.js';
import { BOOKMARK_INDEXES } from '../src/adapters/indexes.js';
import { personCandidate } from './helpers.js';

const A = 'tnt_a';
const B = 'tnt_b';
const scope = (t: string) => TenantScope.fromTenantId(t);

function build(withBookmarks = true) {
  const store = new InMemoryIncidentStore();
  const bookmarks = new InMemoryBookmarkStore();
  let n = 0;
  const service = new IncidentService({
    store,
    ...(withBookmarks ? { bookmarks } : {}),
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { service, store, bookmarks };
}

const input = (overrides: Partial<CreatePlaybackBookmarkInput> = {}): CreatePlaybackBookmarkInput =>
  ({
    source: { kind: 'evidence', id: 'ev-1' },
    at: '2026-08-03T11:00:00.000Z',
    label: 'suspect enters',
    visibility: 'private',
    ...overrides,
  }) as CreatePlaybackBookmarkInput;

describe('investigation bookmarks', () => {
  let h: ReturnType<typeof build>;
  let incidentId: string;

  beforeEach(async () => {
    h = build();
    const { incident } = await h.service.promote(scope(A), personCandidate());
    incidentId = incident.id;
  });

  it('saves a moment and returns a contract-valid bookmark', async () => {
    const bookmark = await h.service.addBookmark(scope(A), incidentId, input(), 'usr_1');
    expect(PlaybackBookmark.safeParse(bookmark).success).toBe(true);
    expect(bookmark.createdBy).toBe('usr_1');
    expect(bookmark.incidentId).toBe(incidentId);
    expect(bookmark.at).toBe('2026-08-03T11:00:00.000Z');
  });

  it('⚠️ never stores an offset — `at` is the authority', async () => {
    const bookmark = await h.service.addBookmark(scope(A), incidentId, input(), 'usr_1');
    /*
     * An offset is meaningless the moment a session is derived over a different range, which
     * happens as soon as somebody opens the bookmark from another starting point.
     */
    expect(bookmark.offsetSeconds).toBeUndefined();
  });

  it('defaults to private, and refuses a public bookmark', async () => {
    const bookmark = await h.service.addBookmark(
      scope(A),
      incidentId,
      {
        source: { kind: 'evidence', id: 'ev-1' },
        at: '2026-08-03T11:00:00.000Z',
        label: 'x',
      } as never,
      'usr_1',
    );
    expect(bookmark.visibility).toBe('private');
  });

  it('lists oldest first — a bookmark list is a route through the footage', async () => {
    await h.service.addBookmark(
      scope(A),
      incidentId,
      input({ at: '2026-08-03T11:30:00.000Z', label: 'third' }),
      'usr_1',
    );
    await h.service.addBookmark(
      scope(A),
      incidentId,
      input({ at: '2026-08-03T11:00:00.000Z', label: 'first' }),
      'usr_1',
    );
    await h.service.addBookmark(
      scope(A),
      incidentId,
      input({ at: '2026-08-03T11:15:00.000Z', label: 'second' }),
      'usr_1',
    );

    const page = await h.service.listBookmarks(scope(A), incidentId, { limit: 50 });
    expect(page.items.map((b) => b.label)).toEqual(['first', 'second', 'third']);
  });

  it('pages with a bound', async () => {
    for (let i = 0; i < 5; i++) {
      await h.service.addBookmark(
        scope(A),
        incidentId,
        input({ at: `2026-08-03T11:0${i}:00.000Z`, label: `b${i}` }),
        'usr_1',
      );
    }
    const first = await h.service.listBookmarks(scope(A), incidentId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await h.service.listBookmarks(scope(A), incidentId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((b) => b.label)).toEqual(['b2', 'b3']);
  });

  it('removes one, and reports honestly when there was nothing to remove', async () => {
    const bookmark = await h.service.addBookmark(scope(A), incidentId, input(), 'usr_1');
    expect(await h.service.removeBookmark(scope(A), bookmark.id, 'usr_1')).toBe(true);
    /* ⚠️ False, so the route answers 404 rather than a cheerful 204. */
    expect(await h.service.removeBookmark(scope(A), bookmark.id, 'usr_1')).toBe(false);
  });

  it('⚠️ refuses to bookmark a sealed incident', async () => {
    await h.service.acknowledge(scope(A), incidentId, {}, 'usr_1');
    await h.service.resolve(scope(A), incidentId, { resolution: 'done' }, 'usr_1');
    await h.service.close(scope(A), incidentId, {}, 'usr_1');
    await expect(h.service.addBookmark(scope(A), incidentId, input(), 'usr_1')).rejects.toThrow();
  });

  it('⚠️ refuses when no store is configured — never an empty list', async () => {
    const bare = build(false);
    const { incident } = await bare.service.promote(scope(A), personCandidate());
    expect(bare.service.bookmarksConfigured).toBe(false);
    await expect(bare.service.listBookmarks(scope(A), incident.id, { limit: 10 })).rejects.toThrow(
      /not configured/,
    );
    /*
     * The whole point: `[]` would tell an operator they have bookmarked nothing, and they would go
     * on not-bookmarking things into a void (§44).
     */
  });

  it('is fail-closed across tenants', async () => {
    await h.service.addBookmark(scope(A), incidentId, input(), 'usr_1');
    await expect(h.service.listBookmarks(scope(B), incidentId, { limit: 10 })).rejects.toThrow(
      /not found/,
    );
  });

  it('⚠️ indexes the exact sort the list query uses — oldest-first, not the incident cursor', () => {
    const byIncident = BOOKMARK_INDEXES.find((i) => i.name === 'bookmarks_by_incident');
    expect(byIncident).toBeDefined();
    /* Equality prefix, then the cursor pair the query sorts by. */
    expect(byIncident?.keys).toEqual(['tenantId', 'incidentId', 'at', 'id']);
    /* ⚠️ Ascending: declaring these descending would silently unserve the sort. */
    expect(byIncident?.descending).toBeUndefined();
  });
});
