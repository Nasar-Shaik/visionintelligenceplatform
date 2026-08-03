/**
 * What playback remembers, and for exactly how long (P-5.6).
 *
 * An investigator who sets the volume once, drops the rate to 0.5× to read a number plate, and then
 * opens the next of forty clips does not want to do it again. So volume, rate and the position they
 * had reached are remembered — **per evidence item, for the current browser session only**.
 *
 * ### ⚠️ `sessionStorage`, deliberately — not `localStorage`, not the frozen view state
 *
 * Three stores were available and only one is correct:
 *
 * - **`WorkspaceViewState`** (frozen contract, server-persisted) carries zoom and playback rate as
 *   *workspace* preferences. Putting a per-clip playback position there would mean an investigator's
 *   scrub position on one item is durably recorded against their account — a record of exactly which
 *   seconds of footage a named person watched. That is a surveillance artifact nobody asked for, and
 *   it would outlive the retention window of the evidence it points at.
 * - **`localStorage`** survives the browser closing, so a shared control-room workstation would hand
 *   the next shift the previous operator's position in an investigation they may not be cleared for.
 * - **`sessionStorage`** dies with the tab, is not shared between tabs, and *is* restored by a
 *   refresh and by tab-restore — which is precisely the scope asked for: survive F5 and a crash
 *   restore, do not survive the shift.
 *
 * ### ⚠️ Storing an id here is safe in a way that restoring a *selection* is not
 *
 * `selection.tsx` refuses to persist which evidence item was open, because restoring it would fire a
 * fetch that 403s or 404s for reasons the operator cannot see. This map is the opposite shape: it is
 * only ever *consulted* for an item that has already loaded successfully. If access was withdrawn or
 * the item was purged, it never loads, so the entry is never read — it just ages out.
 */

/** What is worth remembering about one clip. All optional: absent means never set, not zero. */
export interface PlaybackMemoryEntry {
  positionSeconds?: number;
  rate?: number;
  volume?: number;
  muted?: boolean;
}

const STORAGE_KEY = 'vip.playback.memory.v1';

/**
 * ⚠️ A hard cap, because "open and close hundreds of evidence clips" is a real session.
 *
 * `sessionStorage` is a few megabytes and throws `QuotaExceededError` when full — and a throw in a
 * `useEffect` on the hundredth clip would break playback for the rest of the shift. Oldest entries
 * are evicted first, so a long investigation keeps the recent clips and quietly forgets the ones
 * from four hours ago.
 */
export const MEMORY_CAPACITY = 200;

/**
 * Positions below this are not worth restoring.
 *
 * ⚠️ Restoring a position of 0.4 s means the operator presses play and the clip appears not to start
 * from the beginning for no visible reason. Under a second is noise.
 */
const MIN_RESTORABLE_POSITION = 1;

/**
 * How close to the end still counts as "finished".
 *
 * ⚠️ Restoring somebody to 0.5 s before the end shows them a frozen last frame and an apparently
 * broken player. A clip watched to the end restarts at the beginning.
 */
const END_TOLERANCE_SECONDS = 2;

interface MemoryFile {
  /** Insertion-ordered; the first key is the oldest. */
  entries: Record<string, PlaybackMemoryEntry>;
  order: string[];
}

function storage(): Storage | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    return sessionStorage;
  } catch {
    /* ⚠️ Access itself throws when storage is blocked by policy. Memory is a nicety; never fatal. */
    return undefined;
  }
}

function read(): MemoryFile {
  const store = storage();
  if (store === undefined) return { entries: {}, order: [] };
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return { entries: {}, order: [] };
    const parsed = JSON.parse(raw) as Partial<MemoryFile>;
    /* ⚠️ Anything malformed is discarded whole. A half-trusted preference file is not worth code. */
    if (typeof parsed !== 'object' || parsed === null) return { entries: {}, order: [] };
    const entries = parsed.entries;
    const order = parsed.order;
    if (typeof entries !== 'object' || entries === null || !Array.isArray(order)) {
      return { entries: {}, order: [] };
    }
    return { entries: entries as Record<string, PlaybackMemoryEntry>, order };
  } catch {
    return { entries: {}, order: [] };
  }
}

function write(file: MemoryFile): void {
  const store = storage();
  if (store === undefined) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    /*
     * ⚠️ Quota, private mode, or a policy block. Silently giving up is right here: the operator
     * loses a convenience, and a toast about storage quota during an investigation is noise about
     * something they cannot fix.
     */
  }
}

/** What was remembered about this clip, if anything. */
export function recall(evidenceId: string): PlaybackMemoryEntry | undefined {
  const file = read();
  return file.entries[evidenceId];
}

/** Merge into what is remembered about this clip, evicting the oldest entries past the cap. */
export function remember(evidenceId: string, patch: PlaybackMemoryEntry): void {
  const file = read();
  const existing = file.entries[evidenceId] ?? {};
  const next: MemoryFile = {
    entries: { ...file.entries, [evidenceId]: { ...existing, ...patch } },
    order: [...file.order.filter((id) => id !== evidenceId), evidenceId],
  };
  while (next.order.length > MEMORY_CAPACITY) {
    const oldest = next.order.shift();
    if (oldest !== undefined) delete next.entries[oldest];
  }
  write(next);
}

/** Drop everything. Used when an investigation is closed, and by tests. */
export function forgetAll(): void {
  const store = storage();
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    /* see `storage()` */
  }
}

/**
 * The position to actually restore to, given the clip's length.
 *
 * ⚠️ Returns `undefined` rather than 0 for "start from the beginning", so the caller never issues a
 * pointless seek — a seek to 0 on load costs a re-buffer on some engines.
 */
export function restorablePosition(
  entry: PlaybackMemoryEntry | undefined,
  durationSeconds: number,
): number | undefined {
  const position = entry?.positionSeconds;
  if (position === undefined || !Number.isFinite(position)) return undefined;
  if (position < MIN_RESTORABLE_POSITION) return undefined;
  if (durationSeconds > 0 && position >= durationSeconds - END_TOLERANCE_SECONDS) return undefined;
  /* ⚠️ Clamped: a remembered position from a session whose duration was reported differently must
     never seek past the end and strand the player on a frozen frame. */
  return durationSeconds > 0 ? Math.min(position, durationSeconds) : position;
}
