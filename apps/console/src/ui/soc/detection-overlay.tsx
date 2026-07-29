import { cn } from '@/lib/cn';

/** Normalized [0,1] bounding box (as produced by the perception `Detection` contract). */
export interface DetectionBox {
  id: string;
  label: string;
  confidence: number;
  /** Normalized coordinates in [0,1]. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectionOverlayProps {
  detections: DetectionBox[];
  className?: string;
}

/**
 * Absolutely-positioned bbox layer over a video/snapshot. Normalized coords → % so it
 * scales with the container. Sits inside a `relative` VideoPlayerContainer.
 */
export function DetectionOverlay({ detections, className }: DetectionOverlayProps) {
  return (
    <div className={cn('pointer-events-none absolute inset-0', className)} aria-hidden>
      {detections.map((d) => (
        <div
          key={d.id}
          className="absolute rounded-xs border-2 border-brand"
          style={{
            left: `${d.x * 100}%`,
            top: `${d.y * 100}%`,
            width: `${d.width * 100}%`,
            height: `${d.height * 100}%`,
          }}
        >
          <span className="absolute -top-5 left-0 whitespace-nowrap rounded-xs bg-brand px-1 text-2xs font-medium text-primary-foreground tabular">
            {d.label} {Math.round(d.confidence * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}
