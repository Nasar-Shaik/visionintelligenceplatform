import type { ReactNode } from 'react';
import { Radio } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/ui/badge';
import { StatusIndicator } from './status-indicator';
import { VideoPlayerContainer } from './video-player-container';
import type { StatusKind } from '@/lib/status';

export interface CameraTileProps {
  name: string;
  status: StatusKind;
  /** Media element (MJPEG <img> / snapshot); omitted → offline placeholder. */
  media?: ReactNode;
  overlay?: ReactNode;
  live?: boolean;
  fps?: number;
  latencyMs?: number;
  onClick?: () => void;
  className?: string;
}

/** Camera monitoring tile — media + overlay + name/status/FPS chrome (DESIGN_SYSTEM §6). */
export function CameraTile({
  name,
  status,
  media,
  overlay,
  live = false,
  fps,
  latencyMs,
  onClick,
  className,
}: CameraTileProps) {
  const offline = status === 'error' || !media;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('group block w-full rounded-lg text-left focus-ring', className)}
    >
      <VideoPlayerContainer
        offline={offline}
        overlay={overlay}
        topLeft={
          live && !offline ? (
            <Badge variant="critical" className="gap-1">
              <Radio className="size-3 animate-[vip-pulse-dot_1.4s_infinite]" aria-hidden />
              LIVE
            </Badge>
          ) : null
        }
        topRight={
          <StatusIndicator
            status={status}
            label=""
            className="rounded-full bg-black/50 px-1.5 py-1"
          />
        }
        bottomBar={
          <>
            <span className="truncate text-xs font-medium text-white">{name}</span>
            {fps !== undefined || latencyMs !== undefined ? (
              <span className="tabular shrink-0 text-2xs text-white/80">
                {fps !== undefined ? `${fps} fps` : ''}
                {fps !== undefined && latencyMs !== undefined ? ' · ' : ''}
                {latencyMs !== undefined ? `${latencyMs} ms` : ''}
              </span>
            ) : null}
          </>
        }
        className="transition-colors group-hover:border-border-strong"
      >
        {media}
      </VideoPlayerContainer>
    </button>
  );
}
