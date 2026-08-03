/**
 * The investigation playback timeline (P-5.5; touch and scale hardening in P-5.6).
 *
 * ### ⚠️ A gap is drawn to scale, never closed up
 *
 * Recorded CCTV is not continuous — a camera drops, a disk fills, a retention sweep purges the
 * middle of a day. A scrubber built over concatenated segments silently compresses those holes, so
 * an operator sees 14:00 run straight into 14:20 and reads it as twenty uneventful minutes. That is
 * the playback equivalent of an omitted timeline source, and it is worse, because the gap in the
 * footage is usually what the investigation is about.
 *
 * So every position here is computed against **wall-clock duration including gaps**, and a gap is a
 * visibly different, hatched band with its stated reason.
 *
 * ### ⚠️ Zoom exists because an hour of footage is 3,600 pixels of nothing
 *
 * At 1× the whole range fits the panel and a five-second event is sub-pixel. Zoom keeps the
 * rendering count bounded instead: ticks are generated for the **visible window only**, so a day of
 * footage costs the same number of DOM nodes as a minute of it.
 *
 * ### ⚠️ P-5.6 — everything drawn here is culled to the visible window, bookmarks included
 *
 * The first version filtered bookmarks *after* mapping every one of them into a React element, so a
 * timeline over a busy week with four thousand marks built four thousand `Tooltip` subtrees to throw
 * almost all of them away on every render. Culling now happens on the data, before any element
 * exists, and marks that would land on the same pixel column are **collapsed into a single cluster**
 * — twenty overlapping bookmark pins are not information, they are a smear that hides the one the
 * operator is looking for.
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { PlaybackBookmark, PlaybackSession } from '@vip/contracts';
import { Bookmark, Minus, Plus, ZoomIn } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import { cn } from '@/lib/cn';
import { MAX_TICKS, tickStep } from './scale';
import { clusterMarks, type MarkCluster } from './marks';

/** Zoom bounds. ⚠️ Both ends are real limits, not preferences — see `scale.ts`. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 240;

/** Drawn clusters above which pins become a smear and the density band takes over. */
const DENSITY_THRESHOLD = 24;

export interface PlaybackTimelineProps {
  session: PlaybackSession;
  /** Current head position, in seconds from the session start. */
  positionSeconds: number;
  bookmarks?: readonly PlaybackBookmark[];
  onSeek?: (offsetSeconds: number) => void;
  className?: string;
}

function formatTick(offsetSeconds: number, startedAt: string, step: number): string {
  const at = new Date(Date.parse(startedAt) + offsetSeconds * 1000);
  /* ⚠️ The label's precision follows the step: a day-scale axis labelled to the second is noise. */
  if (step >= 86400) {
    return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  if (step >= 60) {
    return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return at.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function PlaybackTimelineImpl({
  session,
  positionSeconds,
  bookmarks = [],
  onSeek,
  className,
}: PlaybackTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(0);

  /**
   * Live touch points, by pointer id.
   *
   * ⚠️ A `Map` in a ref rather than state: a pinch fires `pointermove` for both fingers at display
   * refresh rate, and routing each one through `setState` would re-render the whole timeline
   * 120 times a second while the operator's fingers are still moving.
   */
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ distance: number; zoom: number; anchor: number } | undefined>(
    undefined,
  );
  const panRef = useRef<{ x: number; offset: number; moved: boolean } | undefined>(undefined);

  const total = Math.max(1, session.durationSeconds);
  const visible = total / zoom;
  /* Keep the window inside the range whatever the zoom does. */
  const start = Math.max(0, Math.min(offset, total - visible));
  const step = tickStep(visible);

  const pct = useCallback(
    (seconds: number) => ((seconds - start) / visible) * 100,
    [start, visible],
  );

  /* ⚠️ Ticks for the visible window only — a day costs the same nodes as a minute. */
  const ticks = useMemo(() => {
    const out: number[] = [];
    const first = Math.ceil(start / step) * step;
    for (let t = first; t <= start + visible && out.length <= MAX_TICKS + 2; t += step) {
      out.push(t);
    }
    return out;
  }, [start, visible, step]);

  const startedAtMs = Date.parse(session.startedAt);

  /*
   * Bookmarks land by wall clock, never by a stored offset — `at` is the authority.
   *
   * ⚠️ Culled and clustered before any element exists. See `marks.ts` for the bound this puts on
   * the DOM regardless of how many bookmarks an investigation accumulates.
   */
  const clusters: readonly MarkCluster[] = useMemo(
    () => clusterMarks(bookmarks, startedAtMs, start, visible),
    [bookmarks, startedAtMs, start, visible],
  );

  /**
   * ⚠️ Past this many drawn clusters, individual pins stop being distinguishable from each other and
   * the track becomes a solid band of icons. Measured on a rendered 4,000-bookmark timeline, not
   * chosen: at 67 clusters the pins abutted and hid the footage, the gaps and the playhead.
   */
  const dense = clusters.length > DENSITY_THRESHOLD;
  const densityPeak = useMemo(
    () => Math.max(1, ...clusters.map((cluster) => cluster.count)),
    [clusters],
  );

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect === undefined || onSeek === undefined) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(start + ratio * visible);
    },
    [onSeek, start, visible],
  );

  /** Re-anchor the window so `anchor` seconds stays under `ratio` of the track width. */
  const applyZoom = useCallback(
    (nextZoom: number, anchor: number, ratio: number) => {
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
      const nextVisible = total / clamped;
      setZoom(clamped);
      setOffset(Math.max(0, Math.min(anchor - ratio * nextVisible, total - nextVisible)));
    },
    [total],
  );

  /** ⚠️ Wheel zoom anchors on the pointer, so the frame under the cursor stays put. */
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (session.durationSeconds === 0) return;
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      applyZoom(zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2), start + ratio * visible, ratio);
    },
    [zoom, start, visible, applyZoom, session.durationSeconds],
  );

  /* ── touch: pinch to zoom, drag to pan ────────────────────────────────────────────────────── */

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      /*
       * ⚠️ Capture, so a finger that slides off the track keeps driving the gesture instead of
       * stranding the timeline mid-pinch with one pointer it will never hear from again.
       */
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        /*
         * ⚠️ Throws `InvalidPointerId` for a pointer the browser no longer considers active — and
         * an uncaught throw here aborts the handler *before* the pinch is registered, so the
         * gesture silently does nothing. Capture is an optimisation; the gesture is the feature.
         */
      }

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a === undefined || b === undefined) return;
        const rect = trackRef.current?.getBoundingClientRect();
        const mid = (a.x + b.x) / 2;
        const ratio =
          rect === undefined ? 0.5 : Math.min(1, Math.max(0, (mid - rect.left) / rect.width));
        pinchRef.current = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          zoom,
          anchor: start + ratio * visible,
        };
        /* A pinch is not a pan; drop any drag the first finger had started. */
        panRef.current = undefined;
      } else if (pointers.size === 1 && event.pointerType === 'touch') {
        panRef.current = { x: event.clientX, offset: start, moved: false };
      }
    },
    [zoom, start, visible],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      const pinch = pinchRef.current;
      if (pinch !== undefined && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a === undefined || b === undefined) return;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.distance === 0) return;
        const rect = trackRef.current?.getBoundingClientRect();
        const mid = (a.x + b.x) / 2;
        const ratio =
          rect === undefined ? 0.5 : Math.min(1, Math.max(0, (mid - rect.left) / rect.width));
        applyZoom((pinch.zoom * distance) / pinch.distance, pinch.anchor, ratio);
        return;
      }

      const pan = panRef.current;
      if (pan !== undefined && pointers.size === 1) {
        const rect = trackRef.current?.getBoundingClientRect();
        if (rect === undefined || rect.width === 0) return;
        const deltaPx = event.clientX - pan.x;
        /* ⚠️ Below this the "drag" is a tap with a shaky hand, and treating it as a pan would
             swallow the seek the operator meant. */
        if (Math.abs(deltaPx) > 4) pan.moved = true;
        const deltaSeconds = -(deltaPx / rect.width) * visible;
        setOffset(Math.max(0, Math.min(pan.offset + deltaSeconds, total - visible)));
      }
    },
    [applyZoom, visible, total],
  );

  const endPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchRef.current = undefined;

      const pan = panRef.current;
      if (pointers.size === 0) {
        /*
         * ⚠️ A touch that never moved is a seek. Without this a tablet operator can pan the
         * timeline but can never jump to a moment on it, because `click` is suppressed by the
         * pointer capture above.
         */
        if (pan !== undefined && !pan.moved && event.pointerType === 'touch') {
          seekFromClientX(event.clientX);
        }
        panRef.current = undefined;
      }
    },
    [seekFromClientX],
  );

  if (session.durationSeconds === 0) {
    return (
      <p className={cn('text-xs text-text-subtle', className)} data-testid="timeline-still">
        This item is a single frame — there is no timeline to scrub.
      </p>
    );
  }

  return (
    <div className={cn('space-y-1.5', className)} data-testid="playback-timeline">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
          Timeline
        </span>
        <span className="text-[11px] text-text-subtle">
          {session.gaps.length === 0
            ? 'continuous'
            : `${session.gaps.length} gap${session.gaps.length === 1 ? '' : 's'}`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 pointer-coarse:size-11"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => applyZoom(zoom / 2, start + visible / 2, 0.5)}
          >
            <Minus className="size-3" aria-hidden />
          </Button>
          <span
            className="w-12 text-center font-mono text-[11px] tabular-nums text-text-subtle"
            data-testid="timeline-zoom"
          >
            {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 pointer-coarse:size-11"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => applyZoom(zoom * 2, start + visible / 2, 0.5)}
          >
            <Plus className="size-3" aria-hidden />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-1 text-text-subtle">
                <ZoomIn className="size-3" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Scroll to zoom around the pointer; pinch to zoom and drag to pan on touch
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Playback timeline"
        aria-valuemin={0}
        aria-valuemax={session.durationSeconds}
        aria-valuenow={Math.round(positionSeconds)}
        aria-valuetext={new Date(startedAtMs + positionSeconds * 1000).toLocaleTimeString()}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClick={(event) => {
          /* Mouse and keyboard only — touch seeks from `endPointer`, see the note there. */
          if (panRef.current === undefined) seekFromClientX(event.clientX);
        }}
        onKeyDown={(event) => {
          if (onSeek === undefined) return;
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, positionSeconds - step));
          if (event.key === 'ArrowRight') onSeek(Math.min(total, positionSeconds + step));
        }}
        /* ⚠️ `touch-none` hands the gestures to us: without it the browser's own pan/zoom wins and
             a pinch scrolls the page instead of zooming the timeline. */
        className="relative h-14 w-full touch-none select-none overflow-hidden rounded-md border border-border bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:h-16"
      >
        {/* Recorded footage. */}
        <div className="absolute inset-x-0 top-4 h-6 bg-brand/25" />

        {/*
          ⚠️ Gaps, hatched and to scale. A gap is not styled like "less data" — it is styled like
          an absence, because that is what it is.
        */}
        {session.gaps.map((gap, index) => {
          const from = (Date.parse(gap.startedAt) - startedAtMs) / 1000;
          const to = (Date.parse(gap.endedAt) - startedAtMs) / 1000;
          const left = pct(from);
          const width = pct(to) - left;
          if (left > 100 || left + width < 0) return null;
          return (
            <Tooltip key={`${gap.startedAt}-${index}`}>
              <TooltipTrigger asChild>
                <div
                  data-testid="timeline-gap"
                  className="absolute top-4 h-6 border-x border-critical/50 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgb(from_var(--color-critical)_r_g_b/0.35)_4px,rgb(from_var(--color-critical)_r_g_b/0.35)_8px)]"
                  style={{ left: `${left}%`, width: `${Math.max(0.4, width)}%` }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-medium">No recording</p>
                <p className="text-[11px] text-text-subtle">{gap.reason}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}

        {/*
          ⚠️ At density, pins are the wrong representation — and only a screenshot showed it.
          Clustering bounded 4,000 bookmarks to ~67 drawn elements, which is the performance
          property this needed, and the result was still unreadable: 67 counted pins abutting each
          other render as a solid band of icons and numerals across the whole track, hiding the
          footage, the gaps and the playhead underneath them. The count was right and the picture
          was useless.

          So past the point where pins stop being distinguishable the timeline draws a **density
          band** instead: one bar per cluster, height proportional to how many bookmarks are in it.
          It says the true thing — "this is where the marks are concentrated, zoom in to work with
          them" — without pretending 67 overlapping icons are individually clickable.
        */}
        {dense
          ? clusters.map((cluster) => (
              <button
                key={cluster.key}
                type="button"
                data-testid="timeline-density-bar"
                data-count={cluster.count}
                aria-label={`${cluster.count} bookmarks around ${cluster.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSeek?.(cluster.offsetSeconds);
                }}
                /*
                 * ⚠️ Narrow and translucent on purpose. The band is an *index* to the bookmarks,
                 * not the subject of the timeline — the footage, the gaps and the playhead have to
                 * stay readable underneath it. Bars wide enough to touch each other reproduce the
                 * solid smear this replaced.
                 */
                className="absolute top-0 w-[2px] bg-warning/60 hover:bg-warning focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning"
                style={{
                  left: `${cluster.percent}%`,
                  /* 3–14 px, so a single mark is still visible and a dense one is not off the top. */
                  height: `${3 + Math.round((cluster.count / densityPeak) * 11)}px`,
                }}
              />
            ))
          : clusters.map((cluster) => (
              <Tooltip key={cluster.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-testid="timeline-bookmark"
                    data-count={cluster.count}
                    aria-label={
                      cluster.count === 1
                        ? `Jump to ${cluster.label}`
                        : `Jump to ${cluster.count} bookmarks around ${cluster.label}`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onSeek?.(cluster.offsetSeconds);
                    }}
                    className="absolute top-0 -ml-2 flex size-4 items-center justify-center text-warning transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning"
                    style={{ left: `${cluster.percent}%` }}
                  >
                    <Bookmark className="size-3 fill-current" aria-hidden />
                    {cluster.count > 1 ? (
                      <span className="absolute -right-1.5 -top-0.5 rounded-full bg-warning px-1 font-mono text-[8px] leading-tight text-black">
                        {cluster.count > 99 ? '99+' : cluster.count}
                      </span>
                    ) : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {cluster.count === 1 ? (
                    cluster.label
                  ) : (
                    <>
                      <p className="font-medium">{cluster.count} bookmarks here</p>
                      <p className="text-[11px] text-text-subtle">
                        Zoom in to separate them — nearest is “{cluster.label}”
                      </p>
                    </>
                  )}
                </TooltipContent>
              </Tooltip>
            ))}

        {/* Playhead. */}
        <div
          data-testid="timeline-playhead"
          className="pointer-events-none absolute top-3 h-8 w-px bg-text"
          style={{ left: `${Math.min(100, Math.max(0, pct(positionSeconds)))}%` }}
        />

        {/* Axis. */}
        {ticks.map((tick) => {
          const left = pct(tick);
          /*
           * ⚠️ Edge labels are dropped, not clipped. A centred label at 0% or 100% is half outside
           * the track and reads as a truncated time — "02:4" is worse than no label at all.
           */
          if (left < 4 || left > 96) return null;
          return (
            <div
              key={tick}
              className="pointer-events-none absolute bottom-0 flex h-4 flex-col justify-end"
              style={{ left: `${left}%` }}
            >
              <span className="-translate-x-1/2 whitespace-nowrap px-1 font-mono text-[9px] tabular-nums text-text-subtle">
                {formatTick(tick, session.startedAt, step)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ⚠️ Memoised: the timeline redraws only when the session, the head or the bookmarks change. Left
 * unmemoised it would re-render on every workspace state change, and a timeline over a day of
 * footage is the most expensive thing on the screen.
 */
export const PlaybackTimeline = memo(PlaybackTimelineImpl);
