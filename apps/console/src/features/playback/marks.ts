/**
 * Culling and clustering timeline marks (P-5.6).
 *
 * ### ⚠️ The bound this exists to enforce
 *
 * An investigation into a fortnight of footage accumulates bookmarks without limit — one per person
 * of interest per camera per pass, and there is no reason for that number to stay small. The naïve
 * renderer maps every bookmark to a React element and filters afterwards, which means the cost of
 * drawing the timeline is proportional to the number of bookmarks *ever created*, not to the number
 * currently visible. At four thousand marks that is four thousand tooltip subtrees constructed and
 * discarded on every scrub.
 *
 * Culling happens here, on plain data, before any element exists. What survives is bounded by the
 * **width of the track in pixels**, not by the size of the collection.
 *
 * ### ⚠️ Overlapping pins are not information
 *
 * Twenty bookmarks inside one second of a day-long timeline render as one smudge of overlapping
 * icons. The operator cannot tell there are twenty, cannot click the one they want, and — worst —
 * cannot tell that the others exist. Collapsing them into a counted cluster says *there are twenty
 * here, zoom in*, which is the true statement.
 */

/** A drawable mark: either one bookmark, or several that share a pixel column. */
export interface MarkCluster {
  /** Stable across renders at the same zoom, so React does not rebuild the row on every scrub. */
  key: string;
  /** Where to seek — the earliest moment in the cluster. */
  offsetSeconds: number;
  /** Position across the visible window, 0–100. */
  percent: number;
  /** How many bookmarks collapsed into this one. `1` is the ordinary case. */
  count: number;
  /** The earliest bookmark's label, shown alone or as "nearest is …". */
  label: string;
}

/**
 * How close is "the same place".
 *
 * ⚠️ 1.5% of the track — roughly a pin's own width at any realistic panel size. Expressed as a
 * fraction rather than in pixels because this module never measures the DOM; a percentage is exactly
 * what the renderer positions with, so the clustering and the drawing agree by construction.
 */
const CLUSTER_PERCENT = 1.5;

/**
 * A hard ceiling on drawn marks.
 *
 * ⚠️ Clustering alone bounds the count at ~67 for a full track, but that assumes marks are spread.
 * This is the guarantee that holds even if the clustering assumption is ever broken by a change to
 * `CLUSTER_PERCENT`: no arrangement of any number of bookmarks can put more than this on screen.
 */
export const MAX_DRAWN_MARKS = 120;

interface Markable {
  id: string;
  at: string;
  label: string;
}

/**
 * Cull to the visible window, then collapse marks that share a pixel column.
 *
 * @param startedAtMs the session start, in epoch milliseconds
 * @param windowStart the visible window's start, in seconds from the session start
 * @param windowSeconds the visible window's width, in seconds
 */
export function clusterMarks(
  marks: readonly Markable[],
  startedAtMs: number,
  windowStart: number,
  windowSeconds: number,
): MarkCluster[] {
  if (marks.length === 0 || windowSeconds <= 0) return [];

  const visible: { offsetSeconds: number; percent: number; label: string; id: string }[] = [];
  for (const mark of marks) {
    const at = Date.parse(mark.at);
    /* ⚠️ An unparseable timestamp is dropped, not defaulted to zero — a bookmark silently pinned to
         the start of the recording is worse than one that is absent. */
    if (Number.isNaN(at)) continue;
    const offsetSeconds = (at - startedAtMs) / 1000;
    const percent = ((offsetSeconds - windowStart) / windowSeconds) * 100;
    if (percent < 0 || percent > 100) continue;
    visible.push({ offsetSeconds, percent, label: mark.label, id: mark.id });
  }

  /* Ascending, so a cluster's representative is genuinely its earliest member. */
  visible.sort((a, b) => a.offsetSeconds - b.offsetSeconds);

  const clusters: MarkCluster[] = [];
  for (const mark of visible) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && mark.percent - last.percent < CLUSTER_PERCENT) {
      last.count += 1;
      continue;
    }
    clusters.push({
      /* ⚠️ Keyed on the representative's id, not on the index: an index key makes React reuse a
           tooltip from a different bookmark when the window scrolls by one mark. */
      key: mark.id,
      offsetSeconds: mark.offsetSeconds,
      percent: mark.percent,
      count: 1,
      label: mark.label,
    });
    if (clusters.length >= MAX_DRAWN_MARKS) break;
  }

  return clusters;
}
