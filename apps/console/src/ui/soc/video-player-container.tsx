import type { ReactNode } from 'react';
import { VideoOff } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Aspect ratios a surveillance surface actually has (P-5.5).
 *
 * ⚠️ `auto` exists because a stream's real ratio is not knowable until metadata loads, and locking
 * a portrait stream into 16:9 either letterboxes it into a stripe or crops the part somebody is
 * looking for. `auto` lets the media size itself inside a bounded stage.
 */
export type PlayerAspect = 'video' | 'classic' | 'portrait' | 'auto';

const ASPECT: Record<PlayerAspect, string> = {
  /** 16:9 — the default for modern IP cameras. */
  video: 'aspect-video',
  /** 4:3 — a great deal of installed CCTV. */
  classic: 'aspect-4/3',
  /** 9:16 — a corridor-mode or phone-sourced upload. */
  portrait: 'aspect-9/16 mx-auto max-w-[min(100%,56vh)]',
  /** Bounded stage, media sizes itself. */
  auto: 'max-h-[70vh]',
};

export interface VideoPlayerContainerProps {
  /** The media element (an <img> MJPEG/snapshot for live, or <video> for a clip). */
  children?: ReactNode;
  /** Overlay layer (e.g. DetectionOverlay) rendered above the media. */
  overlay?: ReactNode;
  /** Top-left / top-right / bottom bars (name, status, FPS/latency, controls). */
  topLeft?: ReactNode;
  topRight?: ReactNode;
  bottomBar?: ReactNode;
  /** Show the "no signal" placeholder instead of media. */
  offline?: boolean;
  /** ⚠️ Defaults to 16:9 so every existing caller is unchanged. */
  aspect?: PlayerAspect;
  className?: string;
}

/**
 * Aspect-locked (16:9) shell for any video/snapshot surface. Provides a `relative`
 * stage for the overlay + chrome slots; the media itself is passed as children.
 */
export function VideoPlayerContainer({
  children,
  overlay,
  topLeft,
  topRight,
  bottomBar,
  offline = false,
  aspect = 'video',
  className,
}: VideoPlayerContainerProps) {
  return (
    <div
      className={cn(
        'relative w-full overflow-hidden rounded-lg border border-border bg-black',
        ASPECT[aspect],
        className,
      )}
    >
      {offline ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 text-text-subtle">
          <VideoOff className="size-6" aria-hidden />
          <span className="text-xs">No signal</span>
        </div>
      ) : (
        children
      )}

      {!offline && overlay}

      {topLeft ? (
        <div className="absolute left-2 top-2 flex items-center gap-2">{topLeft}</div>
      ) : null}
      {topRight ? (
        <div className="absolute right-2 top-2 flex items-center gap-2">{topRight}</div>
      ) : null}
      {bottomBar ? (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
          {bottomBar}
        </div>
      ) : null}
    </div>
  );
}
