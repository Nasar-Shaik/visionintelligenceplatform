/**
 * The evidence player (P-5.5) — the surface an investigator actually watches footage on.
 *
 * ### ⚠️ Every control is offered from `session.capabilities`, never assumed
 *
 * The frozen contract declares per session what the media can do, because a still image cannot
 * seek, a clip with no declared codec cannot step accurately, and no build of this platform can
 * render a snapshot or an export yet. A control offered on a source that cannot perform it is worse
 * than an absent one: the operator presses it, nothing happens, and they learn the product is
 * unreliable. So the transport renders from capabilities, and the ones the platform has not built
 * are visibly unavailable with a reason rather than quietly missing.
 *
 * ### ⚠️ The view-mode badge is permanent, not a tooltip
 *
 * `Original` · `Enhanced` · `Redacted` · `Derived` (CONSTRAINTS §82). Anything but `original`
 * carries a persistent on-screen label, because a badge that only appears on hover is lost the
 * moment somebody screenshots the screen — which is exactly how an enhanced frame ends up in a
 * report presented as the original.
 *
 * ### ⚠️ What the player reports about itself is measured, not assumed
 *
 * Dropped frames and stall counts come from the browser's own `getVideoPlaybackQuality()`; when the
 * browser does not implement it the readout says **not measured** rather than showing zero. A
 * player that silently drops frames while the scrubber advances smoothly tells an investigator they
 * watched thirty seconds of a corridor when they saw eight frames of it.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EvidenceViewAdjustment, PlaybackSession } from '@vip/contracts';
import { isAdjusted, requiresProminentLabel, viewMode } from '@vip/contracts';
import {
  AlertTriangle,
  Camera,
  ChevronsLeft,
  ChevronsRight,
  FileWarning,
  Gauge,
  Loader2,
  Maximize2,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  Sun,
} from 'lucide-react';
import { Badge, Button, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import { cn } from '@/lib/cn';
import { VideoPlayerContainer, type PlayerAspect } from '@/ui';

const NEUTRAL: EvidenceViewAdjustment = {
  brightness: 1,
  contrast: 1,
  rotateQuarters: 0,
  zoom: 1,
};

/** What the browser told us it managed to show. `undefined` ⇒ it does not report, never zero. */
interface Quality {
  droppedFrames?: number | undefined;
  renderedFrames?: number | undefined;
  stalls: number;
}

export interface EvidencePlayerProps {
  session: PlaybackSession;
  /** A derivation, when this item is a rendered copy. Drives the Redacted / Derived badge. */
  derivation?: Parameters<typeof viewMode>[1];
  /** Called with the current offset so a timeline can follow without re-rendering the video. */
  onPositionChange?: (offsetSeconds: number) => void;
  /** Seek requests from outside (a timeline click, a bookmark jump). */
  seekToSeconds?: number | undefined;
  /** Offer a "bookmark this moment" action. */
  onBookmark?: (offsetSeconds: number) => void;
  className?: string;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * A transport button.
 *
 * ⚠️ `unavailableReason` renders the control **disabled with an explanation** rather than removing
 * it. A missing button is indistinguishable from a product that never had the feature; a disabled
 * one with "no export packager is built yet" is an answer.
 */
function Control({
  label,
  icon: Icon,
  onClick,
  shortcut,
  unavailableReason,
}: {
  label: string;
  icon: typeof Play;
  onClick?: () => void;
  shortcut?: string;
  unavailableReason?: string | undefined;
}) {
  const disabled = unavailableReason !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-disabled={disabled}
          disabled={disabled}
          onClick={onClick}
          className="size-8 text-white/90 hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          <Icon className="size-4" aria-hidden />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span>{label}</span>
        {shortcut ? <kbd className="ml-2 text-[10px] opacity-70">{shortcut}</kbd> : null}
        {unavailableReason ? (
          <p className="mt-1 max-w-56 text-[11px] text-text-subtle">{unavailableReason}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** The mode badge. ⚠️ Always rendered; only `original` is styled quietly. */
function ViewModeBadge({ mode }: { mode: ReturnType<typeof viewMode> }) {
  const prominent = requiresProminentLabel(mode);
  const copy: Record<typeof mode, string> = {
    original: 'Original',
    enhanced: 'Enhanced view',
    redacted: 'Redacted copy',
    derived: 'Derived copy',
  };
  return (
    <Badge
      data-testid="view-mode-badge"
      className={cn(
        'border font-medium uppercase tracking-wide',
        prominent
          ? 'border-warning/60 bg-warning/20 text-warning'
          : 'border-white/20 bg-black/50 text-white/80',
      )}
    >
      {prominent ? <AlertTriangle className="mr-1 size-3" aria-hidden /> : null}
      {copy[mode]}
    </Badge>
  );
}

/** Loading, while the browser resolves metadata. Shape-matched to the player it replaces. */
export function PlayerSkeleton({ aspect = 'video' }: { aspect?: PlayerAspect }) {
  return (
    <div className="space-y-2" data-testid="player-skeleton">
      <Skeleton className={cn('w-full rounded-lg', aspect === 'video' ? 'aspect-video' : 'h-64')} />
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-2 flex-1 rounded-full" />
        <Skeleton className="h-4 w-14 rounded" />
      </div>
    </div>
  );
}

function EvidencePlayerImpl({
  session,
  derivation,
  onPositionChange,
  seekToSeconds,
  onBookmark,
  className,
}: EvidencePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  const [adjustment, setAdjustment] = useState<EvidenceViewAdjustment>(NEUTRAL);
  const [showAdjust, setShowAdjust] = useState(false);
  const [quality, setQuality] = useState<Quality>({ stalls: 0 });
  const [aspect, setAspect] = useState<PlayerAspect>('video');

  const segment = session.segments[0];
  const isStill = session.durationSeconds === 0;
  const capabilities = session.capabilities;
  const mode = viewMode(adjustment, derivation);

  /*
   * ⚠️ The one place a codec is judged, and it probes the **container only**.
   *
   * The obvious version appends the manifest's codec — `video/mp4; codecs="h264"` — and it is
   * wrong in a way that fails closed on every real file. `canPlayType`'s codecs parameter is
   * RFC 6381 (`avc1.42E01E`), and this platform's manifests store the *friendly* name, because
   * `CameraCodec` is `'h264' | 'h265'`. Chromium answers `''` to the friendly form and `probably`
   * to the RFC form — so appending it would have told every operator that every H.264 clip in the
   * product was undecodable. Measured in the browser, not reasoned about.
   *
   * So: probe the container, treat `''` as genuinely unsupported, and let a real decode failure
   * surface through the error overlay. Refusing to try is the more expensive mistake — the file
   * usually plays.
   */
  const codecUnsupported = useMemo(() => {
    if (segment === undefined || isStill) return false;
    if (typeof document === 'undefined') return false;
    return document.createElement('video').canPlayType(segment.contentType) === '';
  }, [segment, isStill]);

  /** Seek requests from the timeline or a bookmark. */
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || seekToSeconds === undefined) return;
    video.currentTime = Math.max(0, Math.min(seekToSeconds, session.durationSeconds));
  }, [seekToSeconds, session.durationSeconds]);

  /* Poll decode quality while playing. ⚠️ Absent API ⇒ the fields stay undefined, never 0. */
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      const video = videoRef.current as
        | (HTMLVideoElement & {
            getVideoPlaybackQuality?: () => {
              droppedVideoFrames: number;
              totalVideoFrames: number;
            };
          })
        | null;
      const report = video?.getVideoPlaybackQuality?.();
      if (report === undefined) return;
      setQuality((prev) => ({
        ...prev,
        droppedFrames: report.droppedVideoFrames,
        renderedFrames: report.totalVideoFrames - report.droppedVideoFrames,
      }));
    }, 2000);
    return () => window.clearInterval(id);
  }, [playing]);

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (video === null) return;
    video.currentTime = Math.max(0, video.currentTime + delta);
  }, []);

  const stepFrame = useCallback((direction: 1 | -1) => {
    const video = videoRef.current;
    if (video === null) return;
    video.pause();
    /* ⚠️ A nominal frame: without a declared frame rate this is an approximation, and the control
         is only offered when `capabilities.frameStep` is true. */
    video.currentTime = Math.max(0, video.currentTime + direction * (1 / 25));
  }, []);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused)
      void video.play().catch(() => setError('Playback was blocked by the browser'));
    else video.pause();
  }, []);

  const stop = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    video.pause();
    video.currentTime = 0;
  }, []);

  const changeRate = useCallback(
    (next: number) => {
      const allowed = capabilities.rates.includes(next);
      if (!allowed) return;
      setRate(next);
      if (videoRef.current !== null) videoRef.current.playbackRate = next;
    },
    [capabilities.rates],
  );

  const fullscreen = useCallback(() => {
    void videoRef.current?.parentElement?.requestFullscreen?.().catch(() => undefined);
  }, []);

  const pip = useCallback(() => {
    const video = videoRef.current as
      | (HTMLVideoElement & {
          requestPictureInPicture?: () => Promise<unknown>;
        })
      | null;
    void video?.requestPictureInPicture?.().catch(() => undefined);
  }, []);

  /*
   * ⚠️ Keyboard handling lives here and reads the **frozen command registry's chords**, so a
   * shortcut is never invented in a component (P-5.2.0 refinement 2). The registry marks these
   * commands `available: false` until a player consumes them — this is that player.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const shift = event.shiftKey;
      const alt = event.altKey;
      switch (event.key) {
        case ' ':
          event.preventDefault();
          if (shift) stop();
          else toggle();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          if (alt) seekBy(-30);
          else if (shift) seekBy(-5);
          else if (capabilities.frameStep) stepFrame(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (alt) seekBy(30);
          else if (shift) seekBy(5);
          else if (capabilities.frameStep) stepFrame(1);
          break;
        case 'f':
        case 'F':
          if (shift) pip();
          else fullscreen();
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, stop, seekBy, stepFrame, fullscreen, pip, capabilities.frameStep]);

  /* ── unavailable: nothing to play ─────────────────────────────────────────────────────────── */
  if (segment === undefined) {
    return (
      <div
        role="status"
        data-testid="player-unavailable"
        className={cn(
          'flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 p-6 text-center',
          className,
        )}
      >
        <FileWarning className="size-6 text-text-subtle" aria-hidden />
        <p className="text-sm font-medium text-text">No recording is available</p>
        <p className="max-w-sm text-xs text-text-subtle">
          This evidence item resolved without any playable media. It may have been purged under
          retention, or capture may never have completed.
        </p>
      </div>
    );
  }

  const filter = `brightness(${adjustment.brightness}) contrast(${adjustment.contrast})`;
  const transform = `rotate(${adjustment.rotateQuarters * 90}deg) scale(${adjustment.zoom})`;

  return (
    <div className={cn('space-y-2', className)} data-testid="evidence-player">
      <VideoPlayerContainer
        aspect={aspect}
        topLeft={<ViewModeBadge mode={mode} />}
        topRight={
          buffering ? (
            <Badge className="border-white/20 bg-black/60 text-white/90" data-testid="buffering">
              <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />
              Buffering
            </Badge>
          ) : null
        }
        bottomBar={
          <div className="flex w-full items-center gap-1">
            <Control
              label={playing ? 'Pause' : 'Play'}
              icon={playing ? Pause : Play}
              shortcut="Space"
              onClick={toggle}
              unavailableReason={isStill ? 'A still image has nothing to play' : undefined}
            />
            <Control
              label="Stop"
              icon={Square}
              shortcut="Shift+Space"
              onClick={stop}
              unavailableReason={isStill ? 'A still image has nothing to play' : undefined}
            />
            <Control
              label="Back 30 seconds"
              icon={ChevronsLeft}
              shortcut="Alt+←"
              onClick={() => seekBy(-30)}
              unavailableReason={capabilities.seek ? undefined : 'This source cannot be seeked'}
            />
            <Control
              label="Back 5 seconds"
              icon={SkipBack}
              shortcut="Shift+←"
              onClick={() => seekBy(-5)}
              unavailableReason={capabilities.seek ? undefined : 'This source cannot be seeked'}
            />
            <Control
              label="Forward 5 seconds"
              icon={SkipForward}
              shortcut="Shift+→"
              onClick={() => seekBy(5)}
              unavailableReason={capabilities.seek ? undefined : 'This source cannot be seeked'}
            />
            <Control
              label="Forward 30 seconds"
              icon={ChevronsRight}
              shortcut="Alt+→"
              onClick={() => seekBy(30)}
              unavailableReason={capabilities.seek ? undefined : 'This source cannot be seeked'}
            />

            <span className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-white/80">
              {formatClock(position)} / {formatClock(session.durationSeconds)}
            </span>

            <div className="ml-auto flex items-center gap-1">
              <Control
                label={`Speed ${rate}x`}
                icon={Gauge}
                onClick={() => {
                  const rates = capabilities.rates;
                  const next = rates[(rates.indexOf(rate) + 1) % rates.length] ?? 1;
                  changeRate(next);
                }}
                unavailableReason={
                  capabilities.rates.length > 1 ? undefined : 'This source plays at one speed only'
                }
              />
              <Control
                label="Adjust brightness and contrast"
                icon={Sun}
                onClick={() => setShowAdjust((open) => !open)}
              />
              <Control
                label="Capture snapshot"
                icon={Camera}
                shortcut="Mod+Shift+S"
                unavailableReason="No snapshot renderer is built yet — the contract is frozen and nothing produces one."
              />
              <Control
                label="Picture in picture"
                icon={PictureInPicture2}
                shortcut="Shift+F"
                onClick={pip}
              />
              <Control label="Fullscreen" icon={Maximize2} shortcut="F" onClick={fullscreen} />
            </div>
          </div>
        }
      >
        {codecUnsupported ? (
          <div
            className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center"
            data-testid="player-codec"
            role="alert"
          >
            <FileWarning className="size-6 text-warning" aria-hidden />
            <p className="text-sm font-medium text-white">This browser cannot decode this file</p>
            <p className="max-w-md text-xs text-white/70">
              The recording is <span className="font-mono">{segment.contentType}</span>
              {segment.codec ? (
                <>
                  {' '}
                  (<span className="font-mono">{segment.codec}</span>)
                </>
              ) : null}
              . The evidence is intact — only this browser lacks the decoder. Download the original
              to review it elsewhere.
            </p>
          </div>
        ) : error !== null ? (
          <div
            className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center"
            data-testid="player-error"
            role="alert"
          >
            <AlertTriangle className="size-6 text-critical" aria-hidden />
            <p className="text-sm font-medium text-white">Playback failed</p>
            <p className="max-w-md text-xs text-white/70">{error}</p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-1"
              onClick={() => {
                setError(null);
                videoRef.current?.load();
              }}
            >
              <RotateCcw className="mr-1 size-3" aria-hidden />
              Try again
            </Button>
          </div>
        ) : isStill ? (
          <img
            src={segment.url}
            alt="Evidence snapshot"
            className="size-full object-contain"
            style={{ filter, transform }}
            onLoad={(event) => {
              const img = event.currentTarget;
              setMetadataReady(true);
              setAspect(img.naturalHeight > img.naturalWidth ? 'portrait' : 'video');
            }}
            onError={() =>
              setError('The image could not be loaded. The signed link may have expired.')
            }
          />
        ) : (
          <video
            ref={videoRef}
            src={segment.url}
            className="size-full object-contain"
            style={{ filter, transform }}
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setMetadataReady(true);
              /* ⚠️ Adaptive: the real ratio is only knowable now. */
              const ratio = video.videoWidth / Math.max(1, video.videoHeight);
              setAspect(ratio < 0.9 ? 'portrait' : ratio < 1.5 ? 'classic' : 'video');
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onWaiting={() => {
              setBuffering(true);
              setQuality((prev) => ({ ...prev, stalls: prev.stalls + 1 }));
            }}
            onPlaying={() => setBuffering(false)}
            onTimeUpdate={(event) => {
              const next = event.currentTarget.currentTime;
              setPosition(next);
              onPositionChange?.(next);
            }}
            onError={() =>
              setError('The media could not be loaded. The signed link may have expired.')
            }
          />
        )}
      </VideoPlayerContainer>

      {/* Scrubber — separate from the video element so dragging it never re-renders the media. */}
      {!isStill && capabilities.seek ? (
        <label className="flex items-center gap-2">
          <span className="sr-only">Playback position</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, session.durationSeconds)}
            step={0.1}
            value={position}
            aria-label="Playback position"
            onChange={(event) => {
              const next = Number(event.target.value);
              setPosition(next);
              if (videoRef.current !== null) videoRef.current.currentTime = next;
            }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-brand"
          />
        </label>
      ) : null}

      {showAdjust ? (
        <div
          className="rounded-lg border border-border bg-surface-2 p-3"
          data-testid="adjust-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-text">Display adjustments</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setAdjustment(NEUTRAL)}
              disabled={!isAdjusted(adjustment)}
            >
              Reset
            </Button>
          </div>
          {/*
            ⚠️ The disclosure, stated in the panel that causes it. These controls change what is on
            the screen and never the stored bytes — and the badge above says `Enhanced` the moment
            any of them moves.
          */}
          <p className="mb-3 text-[11px] leading-relaxed text-text-subtle">
            Adjustments affect this view only. The original evidence is never modified, and the view
            is marked <span className="font-medium text-warning">Enhanced</span> while any
            adjustment is applied.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              ['Brightness', 'brightness', 0.5, 2] as const,
              ['Contrast', 'contrast', 0.5, 2] as const,
              ['Zoom', 'zoom', 1, 4] as const,
            ].map(([label, key, min, max]) => (
              <label key={key} className="block">
                <span className="mb-1 flex items-center justify-between text-[11px] text-text-muted">
                  {label}
                  <span className="font-mono tabular-nums">{adjustment[key].toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={0.05}
                  value={adjustment[key]}
                  aria-label={label}
                  onChange={(event) =>
                    setAdjustment((prev) => ({ ...prev, [key]: Number(event.target.value) }))
                  }
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-brand"
                />
              </label>
            ))}
            <div className="flex items-end">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  setAdjustment((prev) => ({
                    ...prev,
                    rotateQuarters: ((prev.rotateQuarters + 1) % 4) as 0 | 1 | 2 | 3,
                  }))
                }
              >
                <RotateCcw className="mr-1 size-3" aria-hidden />
                Rotate 90°
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Honest quality readout. ⚠️ "Not measured" is a real value here. */}
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-subtle">
        <div className="flex gap-1">
          <dt>Dropped frames</dt>
          <dd className="font-mono tabular-nums text-text-muted">
            {quality.droppedFrames ?? 'not measured'}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Stalls</dt>
          <dd className="font-mono tabular-nums text-text-muted">{quality.stalls}</dd>
        </div>
        {onBookmark ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={() => onBookmark(position)}
          >
            Bookmark this moment
          </Button>
        ) : null}
      </dl>

      {!metadataReady && !codecUnsupported && error === null ? (
        <p className="text-[11px] text-text-subtle" role="status">
          Resolving media…
        </p>
      ) : null}
    </div>
  );
}

/**
 * ⚠️ Memoised on purpose. The workspace re-renders whenever a side panel changes — a comment
 * arrives, an assignment updates, the timeline scrubs. Re-rendering the `<video>` element for any
 * of those would restart the media, which is a bug an operator experiences as the footage jumping
 * back to the start while they are watching it.
 */
export const EvidencePlayer = memo(EvidencePlayerImpl);
