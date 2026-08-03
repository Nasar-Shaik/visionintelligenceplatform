/**
 * The evidence player (P-5.5, hardened for production in P-5.6).
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
 *
 * ### ⚠️ P-5.6: a failure is classified before it is described
 *
 * "The media could not be loaded" was one sentence covering an expired signature, a dropped
 * connection and a truncated file — three problems with three different answers, one of which is
 * *the evidence is damaged*. `recovery.ts` classifies first; the overlay only offers a retry where
 * retrying can succeed, and an expired session refetches a **fresh signature** rather than
 * reloading a URL that is already dead.
 *
 * ### ⚠️ P-5.6: the media element is released when it detaches
 *
 * A detached `<video>` that still has a `src` keeps downloading. Measured over 60 clips opened and
 * closed as soon as their metadata arrived: **13.33 MB transferred without the release, 1.61 MB
 * with it.** The release has to hang off the ref rather than an unmount effect, and it has to be
 * deferred — see `attachVideo`, where both of those are the difference between working and silently
 * doing nothing or silently blanking the player.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraCodec, EvidenceViewAdjustment, PlaybackSession } from '@vip/contracts';
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
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import { Badge, Button, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import { cn } from '@/lib/cn';
import { VideoPlayerContainer, type PlayerAspect } from '@/ui';
import { codecVerdict } from './codecs';
import {
  classifyFailure,
  endedEarly,
  failureCopy,
  sessionClock,
  sessionExpired,
  type PlaybackFailure,
} from './recovery';
import { recall, remember, restorablePosition } from './session-memory';
import { ShortcutSheet } from './ShortcutSheet';
import { commandForEvent, isTypingTarget } from './shortcuts';

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

/** ⚠️ Two seconds. Frequent enough to be useful, rare enough that it is not a per-frame cost. */
const QUALITY_POLL_MS = 2000;

/**
 * ⚠️ Position is written to session memory at most this often.
 *
 * `timeupdate` fires ~4×/second. Serialising a JSON blob into `sessionStorage` at that rate for
 * eight hours is a measurable main-thread cost and a pointless one — nothing reads the value until
 * the clip is reopened.
 */
const MEMORY_WRITE_MS = 5000;

/** ⚠️ Two taps within this window on the video surface toggle playback. */
const DOUBLE_TAP_MS = 300;

export interface EvidencePlayerProps {
  session: PlaybackSession;
  /** Identifies the clip for session memory. Defaults to the session's own source id. */
  evidenceId?: string;
  /** A derivation, when this item is a rendered copy. Drives the Redacted / Derived badge. */
  derivation?: Parameters<typeof viewMode>[1];
  /** Called with the current offset so a timeline can follow without re-rendering the video. */
  onPositionChange?: (offsetSeconds: number) => void;
  /** Seek requests from outside (a timeline click, a bookmark jump). */
  seekToSeconds?: number | undefined;
  /** Offer a "bookmark this moment" action. */
  onBookmark?: (offsetSeconds: number) => void;
  /**
   * Fetch a **fresh** session from the server.
   *
   * ⚠️ Required for expiry recovery to work at all. Without it the player can detect that the
   * signature is dead but has nothing to do about it, and says so rather than offering a retry that
   * cannot succeed.
   */
  onRecover?: () => void;
  /** True while a recovery fetch is in flight. */
  recovering?: boolean;
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
 *
 * ⚠️ P-5.6 — the hit area is 44 px on a coarse pointer and 32 px on a fine one. The icon does not
 * change size; only the target does. A 32 px control is comfortable with a mouse and a coin-toss
 * with a thumb, and an operator on a tablet stabbing at pause three times during an incident is a
 * usability failure that reads as an unresponsive product.
 */
function Control({
  label,
  icon: Icon,
  onClick,
  shortcut,
  unavailableReason,
  active,
}: {
  label: string;
  icon: typeof Play;
  onClick?: () => void;
  shortcut?: string;
  unavailableReason?: string | undefined;
  active?: boolean;
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
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            /*
             * ⚠️ `pointer-coarse`, **not** a width breakpoint.
             *
             * The first version used `size-11 sm:size-8`, and an iPad Pro — 834 px wide and driven
             * entirely by thumbs — matched `sm:` and got every control at 32 px. Measured, on the
             * device emulation: 16 of 16 controls under the 44 px target. Screen width has never
             * been what makes a pointer imprecise; the input device is. `pointer: coarse` asks the
             * question that was actually meant.
             */
            'size-8 text-white/90 transition-colors hover:bg-white/10 hover:text-white',
            'focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-0',
            'disabled:opacity-40 pointer-coarse:size-11',
            active && 'bg-white/15 text-white',
          )}
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
  evidenceId,
  derivation,
  onPositionChange,
  seekToSeconds,
  onBookmark,
  onRecover,
  recovering = false,
  className,
}: EvidencePlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [failure, setFailure] = useState<PlaybackFailure | undefined>(undefined);
  const [metadataReady, setMetadataReady] = useState(false);
  const [adjustment, setAdjustment] = useState<EvidenceViewAdjustment>(NEUTRAL);
  const [showAdjust, setShowAdjust] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [quality, setQuality] = useState<Quality>({ stalls: 0 });
  const [aspect, setAspect] = useState<PlayerAspect>('video');
  const [offline, setOffline] = useState(false);
  /** Seconds actually decoded when the media ran out, if it ran out early. See `endedEarly`. */
  const [shortfall, setShortfall] = useState<number | undefined>(undefined);

  const segment = session.segments[0];
  const isStill = session.durationSeconds === 0;
  const capabilities = session.capabilities;
  const mode = viewMode(adjustment, derivation);
  const memoryKey = evidenceId ?? session.source.id;

  /*
   * ⚠️ Position is mirrored into a ref because the throttled memory write and the teardown effect
   * both need the *latest* value without either of them re-subscribing on every `timeupdate`. A
   * teardown that closed over a stale `position` would remember the wrong second.
   */
  const positionRef = useRef(0);
  const lastMemoryWriteRef = useRef(0);
  const lastTapRef = useRef(0);
  /** Where to resume after a recovery fetch swaps the signed URL underneath us. */
  const resumeAtRef = useRef<number | undefined>(undefined);

  /* ── the codec question, answered from measured browser behaviour ─────────────────────────── */
  const verdict = useMemo(() => {
    if (segment === undefined || isStill) {
      return { support: 'unknown' as const, probed: [] as readonly string[] };
    }
    return codecVerdict(segment.contentType, segment.codec as CameraCodec | undefined);
  }, [segment, isStill]);
  const codecUnsupported = verdict.support === 'unsupported';

  /* ── the expiry clock ─────────────────────────────────────────────────────────────────────── */
  const clock = useMemo(() => sessionClock(session), [session]);
  const [expired, setExpired] = useState(() => false);

  /**
   * ⚠️ Expiry is re-evaluated on **wake, focus, reconnect and visibility change** — never on a
   * timer. A `setTimeout` scheduled for the expiry moment does not survive a slept laptop, which is
   * the single most common way an investigator meets an expired session.
   */
  useEffect(() => {
    if (clock === undefined) return;
    const check = () => setExpired(sessionExpired(clock, new Date()));
    check();
    const events: (keyof WindowEventMap)[] = ['focus', 'online', 'pageshow'];
    for (const event of events) window.addEventListener(event, check);
    document.addEventListener('visibilitychange', check);
    /*
     * A slow heartbeat as well, so a tab left open and visible for hours still notices. One minute
     * costs nothing and bounds how long a stale session can look healthy.
     */
    const id = window.setInterval(check, 60_000);
    return () => {
      for (const event of events) window.removeEventListener(event, check);
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(id);
    };
  }, [clock]);

  /** Network state, so a dropped connection is named rather than blamed on the evidence. */
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  /* ── session memory: restore on mount, remember as we go ──────────────────────────────────── */
  useEffect(() => {
    const entry = recall(memoryKey);
    if (entry === undefined) return;
    if (entry.rate !== undefined && capabilities.rates.includes(entry.rate)) setRate(entry.rate);
    if (entry.volume !== undefined) setVolume(entry.volume);
    if (entry.muted !== undefined) setMuted(entry.muted);
    /* ⚠️ The position is applied on `loadedmetadata`, not here — seeking before the element knows
       its duration is silently ignored by every engine. */
    resumeAtRef.current = restorablePosition(entry, session.durationSeconds);
  }, [memoryKey, capabilities.rates, session.durationSeconds]);

  /**
   * ⚠️ Teardown — what it actually buys, measured, and where it has to live.
   *
   * **It is bandwidth, not memory.** The intuition is that a detached `<video>` leaks heap; the
   * measurement says otherwise. Over 250 open/close cycles in Chromium 151, retained DOM nodes and
   * JS heap were indistinguishable between releasing and not releasing (148 vs 193 nodes, 0.025 vs
   * 0.026 MB) — decoded media does not live on the JS heap, which is exactly why this is easy to
   * get wrong in both directions.
   *
   * What *does* differ is the download. Opening 60 clips and closing each as soon as its metadata
   * arrived — an operator clicking through a shift — transferred **13.33 MB when the element was
   * merely detached and 1.61 MB when its source was cleared**, because a detached element with a
   * live `src` keeps fetching: 35 of 63 requests ran to completion instead of 58 being aborted.
   * Over a working day on a VPN link that is footage nobody watched, paid for at 8× the necessary
   * rate.
   *
   * **And it has to hang off the ref.** The obvious home for this is an unmount effect, where it
   * silently does nothing: React detaches refs before passive effect cleanups run, so
   * `videoRef.current` is already `null` by then and the release is skipped every single time. A
   * ref cleanup function (React 19) runs with the node in scope at the moment it detaches, which is
   * the only place the element can still be reached.
   */
  const attachVideo = useCallback((node: HTMLVideoElement) => {
    videoRef.current = node;
    return () => {
      if (videoRef.current === node) videoRef.current = null;
      /*
       * ⚠️ Deferred, and guarded on `isConnected` — the fix for a defect that made the player a
       * black rectangle.
       *
       * React re-runs a ref callback (cleanup, then attach) on a node that is **still mounted**:
       * StrictMode does it on every mount in development, and any ref identity change does it in
       * production. Releasing eagerly therefore blanked a live element — and React never restored
       * it, because its virtual DOM still believed `src` was unchanged, so the operator was left
       * with a black frame and "Resolving media…" forever. Found by looking at the screenshot; no
       * assertion in the suite was watching the element's `src` after a re-attach.
       *
       * A microtask is long enough for React to finish re-attaching. If the node is back in the
       * document by then, this was a re-attach and there is nothing to release.
       */
      queueMicrotask(() => {
        if (node.isConnected) return;
        try {
          node.pause();
          node.removeAttribute('src');
          /* ⚠️ Required: clearing the attribute alone leaves the previous resource loaded. */
          node.load();
        } catch {
          /* An element already released by the browser throws here; nothing left to do. */
        }
      });
    };
  }, []);

  /** The final position, written where the ref cleanup cannot reach — a still image has no video. */
  useEffect(() => {
    return () => {
      if (positionRef.current > 0) remember(memoryKey, { positionSeconds: positionRef.current });
    };
  }, [memoryKey]);

  /** Seek requests from the timeline or a bookmark. */
  useEffect(() => {
    const video = videoRef.current;
    if (video === null || seekToSeconds === undefined) return;
    video.currentTime = Math.max(0, Math.min(seekToSeconds, session.durationSeconds));
  }, [seekToSeconds, session.durationSeconds]);

  /*
   * ⚠️ When a recovery fetch returns, the segment URL changes and the element reloads from zero.
   * Stash where we were so `loadedmetadata` can put us back — otherwise "resume playback" drops the
   * investigator at the start of an eight-hour recording.
   */
  const segmentUrl = segment?.url;
  useEffect(() => {
    if (segmentUrl === undefined) return;
    if (positionRef.current > 0) resumeAtRef.current = positionRef.current;
  }, [segmentUrl]);

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
    }, QUALITY_POLL_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (video === null) return;
    video.currentTime = Math.max(0, video.currentTime + delta);
  }, []);

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      if (!capabilities.frameStep) return;
      const video = videoRef.current;
      if (video === null) return;
      video.pause();
      /* ⚠️ A nominal frame: without a declared frame rate this is an approximation, and the control
           is only offered when `capabilities.frameStep` is true. */
      video.currentTime = Math.max(0, video.currentTime + direction * (1 / 25));
    },
    [capabilities.frameStep],
  );

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused)
      /*
       * ⚠️ Autoplay policy rejects this when the operator has not interacted with the document, and
       * it is a *different* failure from a media error — the file is fine, the browser refused.
       */
      void video.play().catch(() => setFailure('aborted'));
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
      if (!capabilities.rates.includes(next)) return;
      setRate(next);
      if (videoRef.current !== null) videoRef.current.playbackRate = next;
      remember(memoryKey, { rate: next });
    },
    [capabilities.rates, memoryKey],
  );

  /** Step through the declared rate ladder. ⚠️ Clamped at both ends, never wrapped: an operator
      pressing "faster" repeatedly must not silently land back on 0.25×. */
  const nudgeRate = useCallback(
    (direction: 1 | -1) => {
      const rates = capabilities.rates;
      const index = rates.indexOf(rate);
      const next = rates[Math.min(rates.length - 1, Math.max(0, index + direction))];
      if (next !== undefined) changeRate(next);
    },
    [capabilities.rates, rate, changeRate],
  );

  const changeVolume = useCallback(
    (next: number) => {
      const clamped = Math.min(1, Math.max(0, next));
      setVolume(clamped);
      /* Raising the volume from zero un-mutes: leaving it muted looks like a broken slider. */
      const nextMuted = clamped === 0;
      setMuted(nextMuted);
      if (videoRef.current !== null) {
        videoRef.current.volume = clamped;
        videoRef.current.muted = nextMuted;
      }
      remember(memoryKey, { volume: clamped, muted: nextMuted });
    },
    [memoryKey],
  );

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    if (videoRef.current !== null) videoRef.current.muted = next;
    remember(memoryKey, { muted: next });
  }, [muted, memoryKey]);

  const fullscreen = useCallback(() => {
    const container = videoRef.current?.parentElement;
    const legacy = videoRef.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (typeof container?.requestFullscreen === 'function') {
      void container.requestFullscreen().catch(() => undefined);
      return;
    }
    /* ⚠️ iOS Safari exposes fullscreen only on the media element, never on a container. */
    legacy?.webkitEnterFullscreen?.();
  }, []);

  const pip = useCallback(() => {
    const video = videoRef.current as
      (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    void video?.requestPictureInPicture?.().catch(() => undefined);
  }, []);

  const recover = useCallback(() => {
    resumeAtRef.current = positionRef.current > 0 ? positionRef.current : undefined;
    setFailure(undefined);
    onRecover?.();
  }, [onRecover]);

  /*
   * ⚠️ Keyboard handling **dispatches registry command ids**, it does not switch on `event.key`.
   * See `shortcuts.ts`: the chord table and the help sheet are the same data, so a binding cannot
   * be implemented one way and documented another.
   */
  const handlers = useMemo<Record<string, () => void>>(
    () => ({
      'playback.play-pause': toggle,
      'playback.stop': stop,
      'playback.previous-frame': () => stepFrame(-1),
      'playback.next-frame': () => stepFrame(1),
      'playback.back-5': () => seekBy(-5),
      'playback.forward-5': () => seekBy(5),
      'playback.back-30': () => seekBy(-30),
      'playback.forward-30': () => seekBy(30),
      'playback.speed-up': () => nudgeRate(1),
      'playback.speed-down': () => nudgeRate(-1),
      'playback.speed-reset': () => changeRate(1),
      'playback.fullscreen': fullscreen,
      'playback.picture-in-picture': pip,
      'playback.bookmark': () => onBookmark?.(positionRef.current),
    }),
    [toggle, stop, stepFrame, seekBy, nudgeRate, changeRate, fullscreen, pip, onBookmark],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      const command = commandForEvent(event);
      if (command === undefined) return;
      const handler = handlers[command];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);

  /** ⚠️ Double-tap toggles playback on touch. A single tap must stay free for focus and controls. */
  const onSurfacePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch') return;
      const now = Date.now();
      if (now - lastTapRef.current < DOUBLE_TAP_MS) {
        lastTapRef.current = 0;
        toggle();
      } else {
        lastTapRef.current = now;
      }
    },
    [toggle],
  );

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

  /*
   * ⚠️ Expiry outranks a reported media error, because an expired signature *causes* one. Reporting
   * the symptom would tell the operator the recording failed to load when the recording is fine.
   */
  const activeFailure: PlaybackFailure | undefined = expired
    ? 'expired'
    : offline && failure !== undefined
      ? 'network'
      : failure;
  const copy = activeFailure === undefined ? undefined : failureCopy(activeFailure);

  /*
   * ⚠️ Nothing is playing, so nothing that acts on playback is offered.
   *
   * The screenshot of the unsupported-codec state showed a fully live transport sitting under a
   * message saying the file cannot be decoded — press play, nothing happens, and the operator
   * learns the product is unreliable at exactly the moment it was being careful. This is the same
   * rule the header states about capabilities, applied to the states rather than to the media.
   */
  const blocked: string | undefined = codecUnsupported
    ? 'This browser cannot decode this recording'
    : copy !== undefined
      ? copy.title
      : isStill
        ? 'A still image has nothing to play'
        : undefined;
  const seekBlocked = blocked ?? (capabilities.seek ? undefined : 'This source cannot be seeked');

  return (
    <div className={cn('space-y-2', className)} data-testid="evidence-player">
      <VideoPlayerContainer
        aspect={aspect}
        topLeft={<ViewModeBadge mode={mode} />}
        topRight={
          <div className="flex items-center gap-1">
            {offline ? (
              <Badge
                className="border-warning/50 bg-warning/20 text-warning"
                data-testid="player-offline"
              >
                <WifiOff className="mr-1 size-3" aria-hidden />
                Offline
              </Badge>
            ) : null}
            {buffering ? (
              <Badge className="border-white/20 bg-black/60 text-white/90" data-testid="buffering">
                <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />
                Buffering
              </Badge>
            ) : null}
          </div>
        }
        bottomBar={
          <div className="flex w-full flex-wrap items-center gap-1">
            <Control
              label={playing ? 'Pause' : 'Play'}
              icon={playing ? Pause : Play}
              shortcut="Space"
              onClick={toggle}
              unavailableReason={blocked}
            />
            <Control
              label="Stop"
              icon={Square}
              shortcut="Shift+Space"
              onClick={stop}
              unavailableReason={blocked}
            />
            <Control
              label="Back 30 seconds"
              icon={ChevronsLeft}
              shortcut="Alt+←"
              onClick={() => seekBy(-30)}
              unavailableReason={seekBlocked}
            />
            <Control
              label="Back 5 seconds"
              icon={SkipBack}
              shortcut="Shift+←"
              onClick={() => seekBy(-5)}
              unavailableReason={seekBlocked}
            />
            <Control
              label="Forward 5 seconds"
              icon={SkipForward}
              shortcut="Shift+→"
              onClick={() => seekBy(5)}
              unavailableReason={seekBlocked}
            />
            <Control
              label="Forward 30 seconds"
              icon={ChevronsRight}
              shortcut="Alt+→"
              onClick={() => seekBy(30)}
              unavailableReason={seekBlocked}
            />

            <span
              className="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-white/80"
              data-testid="player-clock"
            >
              {formatClock(position)} / {formatClock(session.durationSeconds)}
            </span>

            <div className="ml-auto flex items-center gap-1">
              {/* Volume — remembered for the session. ⚠️ Hidden entirely on a still image. */}
              {isStill ? null : (
                <div
                  className="flex items-center gap-1"
                  onPointerEnter={() => setShowVolume(true)}
                  onPointerLeave={() => setShowVolume(false)}
                >
                  <Control
                    label={muted ? 'Unmute' : 'Mute'}
                    icon={muted || volume === 0 ? VolumeX : Volume2}
                    onClick={toggleMute}
                    active={muted}
                  />
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={muted ? 0 : volume}
                    aria-label="Volume"
                    aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} percent`}
                    onChange={(event) => changeVolume(Number(event.target.value))}
                    onFocus={() => setShowVolume(true)}
                    className={cn(
                      'h-1.5 cursor-pointer appearance-none rounded-full bg-white/25 accent-brand transition-all pointer-coarse:h-6',
                      /*
                       * ⚠️ Always reachable by keyboard even when visually collapsed — a control
                       * that only exists on hover is a control a keyboard user does not have.
                       *
                       * ⚠️ And **always visible on a coarse pointer**, because a touch device has
                       * no hover at all: measured on iPad and Pixel emulation, the collapsed
                       * slider was 0 px wide with no gesture that could ever reveal it. A
                       * hover-revealed control is an absent control on a tablet.
                       */
                      'pointer-coarse:w-20 pointer-coarse:opacity-100',
                      showVolume
                        ? 'w-20 opacity-100'
                        : 'w-0 opacity-0 focus:w-20 focus:opacity-100',
                    )}
                  />
                </div>
              )}
              <Control
                label={`Speed ${rate}×`}
                icon={Gauge}
                shortcut="Shift+. / Shift+,"
                onClick={() => {
                  const rates = capabilities.rates;
                  const next = rates[(rates.indexOf(rate) + 1) % rates.length] ?? 1;
                  changeRate(next);
                }}
                unavailableReason={
                  blocked ??
                  (capabilities.rates.length > 1
                    ? undefined
                    : 'This source plays at one speed only')
                }
                active={rate !== 1}
              />
              <Control
                label="Adjust brightness and contrast"
                icon={Sun}
                onClick={() => setShowAdjust((open) => !open)}
                active={showAdjust || isAdjusted(adjustment)}
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
        <div className="size-full" onPointerUp={onSurfacePointerUp}>
          {codecUnsupported ? (
            <div
              className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center"
              data-testid="player-codec"
              role="alert"
            >
              <FileWarning className="size-6 text-warning" aria-hidden />
              <p className="text-sm font-medium text-white">This browser cannot decode this file</p>
              <p className="max-w-md text-xs leading-relaxed text-white/70">{verdict.reason}</p>
              <p className="font-mono text-[10px] text-white/40">
                {segment.contentType}
                {segment.codec ? ` · ${segment.codec}` : ''}
              </p>
            </div>
          ) : copy !== undefined ? (
            <div
              className="flex size-full flex-col items-center justify-center gap-2 p-6 text-center"
              data-testid="player-error"
              data-failure={activeFailure}
              role="alert"
            >
              <AlertTriangle
                className={cn(
                  'size-6',
                  activeFailure === 'decode' ? 'text-critical' : 'text-warning',
                )}
                aria-hidden
              />
              <p className="text-sm font-medium text-white">{copy.title}</p>
              <p className="max-w-md text-xs leading-relaxed text-white/70">{copy.detail}</p>
              {copy.recoverable && onRecover !== undefined ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-1"
                  disabled={recovering}
                  onClick={recover}
                >
                  {recovering ? (
                    <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="mr-1 size-3" aria-hidden />
                  )}
                  {recovering ? 'Fetching a new link…' : (copy.action ?? 'Retry')}
                </Button>
              ) : null}
              {copy.recoverable && onRecover === undefined ? (
                /* ⚠️ No refetch was wired in, so no button is offered. Saying "try again" where
                   nothing can try is the failure this whole overlay was rewritten to remove. */
                <p className="mt-1 max-w-md text-[11px] text-white/50">
                  Reopen this evidence item to get a fresh playback link.
                </p>
              ) : null}
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
              onError={() => setFailure('network')}
            />
          ) : (
            <video
              ref={attachVideo}
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
                /* Apply remembered preferences to the element now that it exists. */
                video.playbackRate = rate;
                video.volume = volume;
                video.muted = muted;
                const resumeAt = resumeAtRef.current;
                if (resumeAt !== undefined) {
                  video.currentTime = Math.min(resumeAt, video.duration || resumeAt);
                  resumeAtRef.current = undefined;
                }
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              /*
               * ⚠️ The truncation check. A damaged recording raises no error in any engine tested —
               * it simply stops. Where it stopped, against what the record declares, is the only
               * signal there is. See `endedEarly`.
               */
              onEnded={(event) => {
                const reached = event.currentTarget.currentTime;
                setPlaying(false);
                setShortfall(endedEarly(reached, session.durationSeconds) ? reached : undefined);
              }}
              onWaiting={() => {
                setBuffering(true);
                setQuality((prev) => ({ ...prev, stalls: prev.stalls + 1 }));
              }}
              onPlaying={() => setBuffering(false)}
              onTimeUpdate={(event) => {
                const next = event.currentTarget.currentTime;
                positionRef.current = next;
                setPosition(next);
                onPositionChange?.(next);
                /* ⚠️ Throttled — see MEMORY_WRITE_MS. */
                const now = Date.now();
                if (now - lastMemoryWriteRef.current > MEMORY_WRITE_MS) {
                  lastMemoryWriteRef.current = now;
                  remember(memoryKey, { positionSeconds: next });
                }
              }}
              onError={(event) => {
                const code = event.currentTarget.error?.code;
                setFailure(classifyFailure(code, sessionExpired(clock, new Date())));
              }}
            />
          )}
        </div>
      </VideoPlayerContainer>

      {/* Scrubber — separate from the video element so dragging it never re-renders the media. */}
      {!isStill && capabilities.seek && blocked === undefined ? (
        <label className="flex items-center gap-2">
          <span className="sr-only">Playback position</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, session.durationSeconds)}
            step={0.1}
            value={position}
            aria-label="Playback position"
            /* ⚠️ A screen reader announcing "412" is useless; announce the clock. */
            aria-valuetext={`${formatClock(position)} of ${formatClock(session.durationSeconds)}`}
            onChange={(event) => {
              const next = Number(event.target.value);
              setPosition(next);
              positionRef.current = next;
              if (videoRef.current !== null) videoRef.current.currentTime = next;
            }}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:h-6"
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
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-surface-3 accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:h-6"
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

      {/*
        ⚠️ Truncation, stated persistently.
        Measured in P-5.6: a truncated or byte-corrupted H.264 file plays in Chromium, Chrome and
        Firefox **with no error of any kind** and simply stops early. Nothing else on this screen
        would tell an investigator that the footage they just watched was not all of it.
      */}
      {shortfall !== undefined ? (
        <div
          role="alert"
          data-testid="player-shortfall"
          className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-2.5"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-medium text-warning">Playback ended early</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
              The browser decoded {formatClock(shortfall)} of a recording this evidence record
              declares as {formatClock(session.durationSeconds)}. Recordings truncated by an
              interrupted write play without raising any error, so this is the only sign. Download
              the original and check it against its integrity hash before relying on what you saw.
            </p>
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
        <ShortcutSheet frameStepAvailable={capabilities.frameStep} className="ml-auto" />
        {onBookmark ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="pointer-coarse:h-11"
            onClick={() => onBookmark(position)}
          >
            Bookmark this moment
          </Button>
        ) : null}
      </dl>

      {/*
        ⚠️ One polite live region for the whole player. Screen readers get told that playback
        started, that it is buffering, or that the link expired — states a sighted operator reads
        off the badges and a blind one otherwise never learns.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {activeFailure !== undefined
          ? copy?.title
          : !metadataReady
            ? 'Resolving media'
            : buffering
              ? 'Buffering'
              : playing
                ? `Playing at ${rate} times speed`
                : 'Paused'}
      </p>

      {!metadataReady && !codecUnsupported && activeFailure === undefined ? (
        <p className="text-[11px] text-text-subtle" aria-hidden>
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
