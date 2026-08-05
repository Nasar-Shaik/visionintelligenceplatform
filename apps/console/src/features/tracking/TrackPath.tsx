import type { Track } from './useTracking';

/**
 * The travelled path, drawn in the camera's normalized frame (P-8 Phase 4).
 *
 * ### ⚠️ An empty rectangle, not a video frame
 *
 * There is no image behind this path and there deliberately is not one. Drawing a trajectory over a
 * still would mean fetching and caching a frame outside approved evidence storage, and the platform
 * does not cache evidence outside approved storage — a constraint that exists precisely so a
 * convenience feature cannot quietly become a second copy of somebody's footage.
 *
 * So the box is the frame, the axes are labelled, and the operator is told what they are looking at.
 * A path over a grey rectangle is honest; a path over a frame from three minutes ago would look far
 * better and mean something different from what it appeared to mean.
 *
 * ### ⚠️ Inline SVG, no charting library
 *
 * A polyline over eight points does not justify a dependency, and the console's bundle budget was
 * won back in P-5.3 by removing exactly this kind of import.
 */
export function TrackPath({ track }: { track: Track }) {
  const points = track.history
    .map((point) => point.centroid ?? centroidOf(point.bbox))
    .filter((p): p is [number, number] => p !== undefined);

  if (points.length < 2) {
    return (
      <p className="text-sm text-text-subtle">
        Not enough observations to draw a path. A trajectory needs at least two.
      </p>
    );
  }

  const width = 480;
  const height = 270;
  const toX = (x: number) => Math.min(Math.max(x, 0), 1) * width;
  const toY = (y: number) => Math.min(Math.max(y, 0), 1) * height;
  const path = points.map((p) => `${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join(' ');
  const start = points[0] as [number, number];
  const end = points[points.length - 1] as [number, number];
  const box = track.bbox;

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-sm border border-border bg-surface-2"
        role="img"
        aria-label={`Path of ${track.label} across ${points.length} observations, from the top-left origin of the camera frame.`}
      >
        {/* The frame itself, with a quarter grid so a position can be read off it. */}
        <g stroke="currentColor" className="text-border" strokeWidth="1">
          <line x1={width / 2} y1="0" x2={width / 2} y2={height} strokeDasharray="4 4" />
          <line x1="0" y1={height / 2} x2={width} y2={height / 2} strokeDasharray="4 4" />
        </g>
        <polyline
          points={path}
          fill="none"
          stroke="currentColor"
          className="text-brand"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Latest position, as the box the detector actually reported. */}
        <rect
          x={toX(box[0])}
          y={toY(box[1])}
          width={Math.max(2, box[2] * width)}
          height={Math.max(2, box[3] * height)}
          fill="none"
          stroke="currentColor"
          className="text-brand"
          strokeWidth="1.5"
          strokeDasharray="3 3"
        />
        <circle cx={toX(start[0])} cy={toY(start[1])} r="4" className="fill-text-subtle" />
        <circle cx={toX(end[0])} cy={toY(end[1])} r="5" className="fill-brand" />
      </svg>
      <figcaption className="text-2xs text-text-subtle">
        Camera frame, normalized. Origin is top-left; the grey dot is where the track began and the
        solid dot is where it is now. ⚠️ No video frame is drawn behind this path — evidence is
        never cached outside approved storage, so the trajectory is shown against the frame&apos;s
        geometry alone.
      </figcaption>
    </figure>
  );
}

function centroidOf(bbox: [number, number, number, number]): [number, number] {
  return [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2];
}
