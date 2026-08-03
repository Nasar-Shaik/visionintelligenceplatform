/**
 * The investigation playback timeline (P-5.5).
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
 * footage costs the same number of DOM nodes as a minute of it (requirement 4, virtualisation).
 */
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { PlaybackBookmark, PlaybackSession } from '@vip/contracts';
import { Bookmark, Minus, Plus, ZoomIn } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import { cn } from '@/lib/cn';
import { MAX_TICKS, tickStep } from './scale';

/** Zoom bounds. ⚠️ Both ends are real limits, not preferences — see `scale.ts`. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 240;

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

  /* Bookmarks land by wall clock, never by a stored offset — `at` is the authority. */
  const marks = useMemo(
    () =>
      bookmarks
        .map((bookmark) => ({
          bookmark,
          offsetSeconds: (Date.parse(bookmark.at) - startedAtMs) / 1000,
        }))
        .filter((m) => m.offsetSeconds >= 0 && m.offsetSeconds <= total),
    [bookmarks, startedAtMs, total],
  );

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect === undefined || onSeek === undefined) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      onSeek(start + ratio * visible);
    },
    [onSeek, start, visible],
  );

  /** ⚠️ Wheel zoom anchors on the pointer, so the frame under the cursor stays put. */
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (session.durationSeconds === 0) return;
      event.preventDefault();
      const rect = trackRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const anchor = start + ratio * visible;
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)),
      );
      const nextVisible = total / nextZoom;
      setZoom(nextZoom);
      setOffset(Math.max(0, Math.min(anchor - ratio * nextVisible, total - nextVisible)));
    },
    [zoom, start, visible, total, session.durationSeconds],
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
            className="size-7"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 2))}
          >
            <Minus className="size-3" aria-hidden />
          </Button>
          <span className="w-12 text-center font-mono text-[11px] tabular-nums text-text-subtle">
            {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 2))}
          >
            <Plus className="size-3" aria-hidden />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-1 text-text-subtle">
                <ZoomIn className="size-3" aria-hidden />
              </span>
            </TooltipTrigger>
            <TooltipContent>Scroll over the track to zoom around the pointer</TooltipContent>
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
        aria-valuetext={`${Math.round(positionSeconds)} seconds`}
        onWheel={onWheel}
        onClick={(event) => seekFromEvent(event.clientX)}
        onKeyDown={(event) => {
          if (onSeek === undefined) return;
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, positionSeconds - step));
          if (event.key === 'ArrowRight') onSeek(Math.min(total, positionSeconds + step));
        }}
        className="relative h-14 w-full cursor-pointer overflow-hidden rounded-md border border-border bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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

        {/* Bookmarks — click to jump. */}
        {marks.map(({ bookmark, offsetSeconds }) => {
          const left = pct(offsetSeconds);
          if (left < 0 || left > 100) return null;
          return (
            <Tooltip key={bookmark.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-testid="timeline-bookmark"
                  aria-label={`Jump to ${bookmark.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSeek?.(offsetSeconds);
                  }}
                  className="absolute top-0 -ml-1.5 flex size-4 items-center justify-center text-warning"
                  style={{ left: `${left}%` }}
                >
                  <Bookmark className="size-3 fill-current" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>{bookmark.label}</TooltipContent>
            </Tooltip>
          );
        })}

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
