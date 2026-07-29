import type { ReactNode } from 'react';
import { VideoOff } from 'lucide-react';
import { cn } from '@/lib/cn';

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
  className,
}: VideoPlayerContainerProps) {
  return (
    <div
      className={cn(
        'relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black',
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
