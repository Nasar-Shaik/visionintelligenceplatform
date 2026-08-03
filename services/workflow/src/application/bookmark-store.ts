/**
 * Port: **investigation bookmarks** (P-5.5).
 *
 * ⚠️ **A separate collection, not a field on the incident.** Notes and attachments live on the
 * incident document because they are bounded by design (`MAX_NOTES`) and every read of an incident
 * wants them. Bookmarks are neither: an investigator reviewing an hour of footage may leave dozens,
 * they are only wanted when a player is open, and growing the incident document with them would
 * make every queue listing carry playback detail nobody asked for.
 *
 * ⚠️ **The Workflow context owns them** — `PlaybackBookmark` is a statement an investigator made
 * about evidence, so it belongs to the investigation and references the evidence by id
 * (CONTEXT_OWNERSHIP; CONSTRAINTS §60). Nothing here writes to an evidence record.
 */
import type { PlaybackBookmark } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';

export interface BookmarkQuery {
  incidentId: string;
  /** Bounded, always — an unbounded read of operator-generated rows is an outage waiting for a busy day. */
  limit: number;
  cursor?: string | undefined;
}

export interface BookmarkPage {
  items: PlaybackBookmark[];
  nextCursor?: string | undefined;
}

export interface BookmarkStore {
  insert(scope: TenantScope, bookmark: PlaybackBookmark): Promise<void>;
  list(scope: TenantScope, query: BookmarkQuery): Promise<BookmarkPage>;
  get(scope: TenantScope, id: string): Promise<PlaybackBookmark | null>;
  /**
   * Remove one.
   *
   * ⚠️ Bookmarks **are** deletable, and that is a deliberate difference from notes. A note is a
   * statement in an investigation record and rewriting it destroys the record's value. A bookmark is
   * a navigational marker — deleting one removes a pointer, not a claim. Returns false when nothing
   * matched, so the caller answers 404 rather than pretending.
   */
  remove(scope: TenantScope, id: string, actor: string): Promise<boolean>;
}
