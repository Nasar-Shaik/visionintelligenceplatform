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
import { analysedInstants, boxesAt } from './overlay';

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

  /* ⚠️ Seeks come from the timeline. The nonce is what lets the same offset be re-requested. */
  useEffect(() => {
    if (seekTo === undefined || video.current === null) return;
    video.current.currentTime = seekTo.offsetSeconds;
    setAt(seekTo.offsetSeconds);
  }, [seekTo]);

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
                true here — see this file's header for the 285 → 24 measurement.
              */}
              {inFrame && sample !== undefined
                ? `${String(boxes.length)} stored at ${formatOffset(sample.offsetSeconds)}`
                : 'no analysed frame at this instant'}
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
