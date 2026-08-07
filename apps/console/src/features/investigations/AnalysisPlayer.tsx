/**
 * The recording, with the boxes the analysis actually stored drawn on top (P-8.6, priorities 1–2).
 *
 * ⛔ **This player draws stored data. It does not re-run detection, and it must never look as though
 * it does.** The P-8.5 capability audit measured the gap it has to be honest about: 67 frames were
 * analysed, 285 detections were returned, and **24 events across 9 distinct offsets** were persisted
 * — one per track per ten-second dedup bucket ([L-57]). So for most of the recording's runtime there
 * is no stored box, and the reason is *retention*, not absence of people.
 *
 * A player that simply showed nothing in those gaps would be read as "the AI missed them". So the
 * overlay states which analysed frame it is drawing and — when there is nothing within tolerance —
 * says so in words, and the transport offers "next analysed frame" rather than only a scrubber.
 *
 * ⭐ Reuses `VideoPlayerContainer` and `DetectionOverlay` unchanged. Both existed before this
 * milestone and were wired only into the design-system gallery.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { AnalysisTimeline } from '@vip/contracts';
import { Button, DetectionOverlay, Switch, VideoPlayerContainer, type PlayerAspect } from '@/ui';
import { formatOffset } from './format';
import { OVERLAY_SAMPLE_MS, analysedInstants, boxesAt, overlayStatus } from './overlay';

export interface AnalysisPlayerProps {
  url: string | undefined;
  contentType: string | undefined;
  /** ⚠️ TD-29: an `hev1` recording analyses fine and plays on nothing Safari or iOS owns. */
  playbackWarning?: string | undefined;
  entries: AnalysisTimeline['entries'];
  /** Frames per second the RUN analysed at — sets how wide "this frame" is. */
  analysisFrameRate: number;
  width?: number | undefined;
  height?: number | undefined;
  /** Seek requests from the timeline, as `{ offsetSeconds, nonce }` so repeats re-fire. */
  seekTo?: { offsetSeconds: number; nonce: number } | undefined;
  /** ⭐ When set, only this subject is outlined — "Which person is Track 7?" answered visually. */
  focusTrack?: string | undefined;
  onTimeUpdate?: (seconds: number) => void;
}

/**
 * ⚠️ `auto` rather than 16:9 by default, and `portrait` when the source is taller than it is wide.
 * The first real upload was 2160×4096; locking that into `aspect-video` renders a person as a
 * letterboxed stripe about eighty pixels tall, which is unusable for the thing this page is for.
 */
export function aspectFor(width?: number, height?: number): PlayerAspect {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return 'auto';
  return height > width ? 'portrait' : 'video';
}

/**
 * Scroll the player into view and start it — the two halves of V-16.
 *
 * ⚠️ Both calls are wrapped because **jsdom implements neither**: `scrollIntoView` is absent and
 * `play()` throws `Not implemented`. Letting either escape would break the seek itself, which is the
 * part that already worked. `play()` also rejects under a browser's autoplay policy when the click
 * that caused this is too far in the past — the seek is still correct in that case, so the rejection
 * is swallowed rather than surfaced.
 */
export function revealAndPlay(el: Pick<HTMLVideoElement, 'scrollIntoView' | 'play'>): void {
  try {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    /* no layout in jsdom — the seek below is what matters */
  }
  try {
    void el.play().catch(() => undefined);
  } catch {
    /* no media element in jsdom, and autoplay may be refused in a browser */
  }
}

export function AnalysisPlayer({
  url,
  contentType,
  playbackWarning,
  entries,
  analysisFrameRate,
  width,
  height,
  seekTo,
  focusTrack,
  onTimeUpdate,
}: AnalysisPlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);

  const { boxes, inFrame, sample } = useMemo(
    () => boxesAt(entries, at, analysisFrameRate, focusTrack),
    [entries, at, analysisFrameRate, focusTrack],
  );
  const instants = useMemo(() => analysedInstants(entries), [entries]);

  /*
   * ⚠️ Seeks come from the timeline. The nonce is what lets the same offset be re-requested.
   *
   * ⛔ **"Play from here" moved the playhead and did nothing else** (V-16). Two independent
   * omissions, and either alone was enough to make the button read as broken:
   *
   *   1. It never called `play()`. A button whose label is a verb has to do the verb.
   *   2. The player sits above the runs table, the details panel and the funnel, so by the time an
   *      operator reaches the timeline lanes it is **~1000 px off the top of the scroll container**
   *      (measured in Chrome on the reported recording: `getBoundingClientRect().top === -1031`).
   *      The seek worked perfectly, off-screen, where nobody could see it.
   *
   * Reported as "'play from here' button is not working", which is exactly what it looks like.
   */
  useEffect(() => {
    const el = video.current;
    if (seekTo === undefined || el === null) return;
    el.currentTime = seekTo.offsetSeconds;
    setAt(seekTo.offsetSeconds);
    revealAndPlay(el);
  }, [seekTo]);

  /*
   * ⭐ **While it plays, read the clock on a timer rather than waiting to be told** (V-17).
   *
   * `timeupdate` is the natural event and it is far too coarse: 266 ms between ticks against a
   * 500 ms tolerance window means a stored box was painted for one tick, sometimes two, sometimes —
   * when the ticks straddled the window — for no frame at all. See `OVERLAY_SAMPLE_MS`.
   *
   * ⚠️ Runs only while playing. A paused player cannot move its own clock, so a timer would be 20
   * renders a second describing a number that is not changing.
   */
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const el = video.current;
      if (el !== null) setAt(el.currentTime);
    }, OVERLAY_SAMPLE_MS);
    return () => clearInterval(id);
  }, [playing]);

  const step = useCallback(
    (direction: -1 | 1) => {
      const next =
        direction === 1
          ? instants.find((o) => o > at + 1e-6)
          : [...instants].reverse().find((o) => o < at - 1e-6);
      if (next === undefined || video.current === null) return;
      video.current.currentTime = next;
      setAt(next);
    },
    [instants, at],
  );

  if (url === undefined) {
    return (
      <section className="space-y-2" data-testid="analysis-player">
        <h2 className="text-sm font-semibold">Recording</h2>
        <VideoPlayerContainer offline aspect={aspectFor(width, height)} />
        <p className="text-xs text-muted-foreground">
          The recording is not available for playback yet.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2" data-testid="analysis-player">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Recording</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Crosshair className="h-3.5 w-3.5" aria-hidden />
          <span>Detection overlay</span>
          <Switch
            checked={showOverlay}
            onCheckedChange={setShowOverlay}
            aria-label="Detection overlay"
          />
        </label>
      </div>

      <VideoPlayerContainer
        aspect={aspectFor(width, height)}
        overlay={showOverlay && boxes.length > 0 ? <DetectionOverlay detections={boxes} /> : null}
        topLeft={
          <span className="rounded-xs bg-black/70 px-1.5 py-0.5 text-2xs tabular text-white">
            {formatOffset(at)} / {formatOffset(duration)}
          </span>
        }
        topRight={
          showOverlay ? (
            <span
              className="rounded-xs bg-black/70 px-1.5 py-0.5 text-2xs text-white"
              data-testid="overlay-status"
            >
              {/*
                ⛔ **The overlay says what it is drawing and what it is not.** "No boxes" and "no
                analysed frame at this instant" are different statements, and only the second is
                true here — see this file's header for the 285 → 24 measurement. V-17: and when it
                is the second, it now names the nearest stored frame instead of stopping there.
              */}
              {overlayStatus(boxes.length, inFrame, sample, at)}
            </span>
          ) : null
        }
      >
        <video
          ref={video}
          src={url}
          data-content-type={contentType ?? ''}
          className="size-full object-contain"
          preload="metadata"
          playsInline
          controls
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            setDuration(Number.isFinite(d) ? d : 0);
          }}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setAt(t);
            onTimeUpdate?.(t);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </VideoPlayerContainer>

      {/*
        ⭐ **Where the stored moments ARE** (V-17). Until this strip existed the only way to find
        them was the tables three sections down the page; on screen the recording looked like an
        ordinary video that occasionally flickered a box. Now the 5 moments in 19 seconds are
        visible as 5 marks, the playhead moves against them, and each one is a click away.
      */}
      <div
        className="relative h-6 w-full rounded-xs border bg-muted/40"
        data-testid="analysed-moments"
        aria-label={`${String(instants.length)} analysed moments in this recording`}
      >
        {duration > 0 &&
          instants.map((offset) => (
            <button
              key={offset}
              type="button"
              className="absolute top-0 h-full w-1.5 -translate-x-1/2 rounded-xs bg-brand hover:w-2 focus-visible:outline-2"
              style={{ left: `${String((offset / duration) * 100)}%` }}
              title={`Play from ${formatOffset(offset)}`}
              aria-label={`Play from ${formatOffset(offset)}`}
              onClick={() => {
                const el = video.current;
                if (el === null) return;
                el.currentTime = offset;
                setAt(offset);
                revealAndPlay(el);
              }}
            />
          ))}
        {duration > 0 && (
          <div
            className="pointer-events-none absolute top-0 h-full w-px bg-foreground"
            style={{ left: `${String(Math.min(100, (at / duration) * 100))}%` }}
            data-testid="playhead"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const el = video.current;
            if (el === null) return;
            if (el.paused) void el.play();
            else el.pause();
          }}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          <span className="ml-1">{playing ? 'Pause' : 'Play'}</span>
        </Button>
        {/*
          ⭐ **Jump between ANALYSED frames, not seconds.** Scrubbing by time in a recording whose
          detections sit at 9 of 67 frames means hunting; these two land on the frames that have
          something stored, which is what an investigator is actually looking for.
        */}
        <Button size="sm" variant="outline" onClick={() => step(-1)} title="Previous analysed frame">
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => step(1)} title="Next analysed frame">
          <SkipForward className="h-4 w-4" />
        </Button>
        <p className="text-xs text-muted-foreground">
          Boxes are drawn only on frames this run stored a detection for —{' '}
          <strong>{instants.length}</strong> moment(s) in this recording. Gaps are retention, not
          blindness.
        </p>
      </div>

      {playbackWarning === undefined ? null : (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-500">
          {playbackWarning}
        </p>
      )}
    </section>
  );
}
