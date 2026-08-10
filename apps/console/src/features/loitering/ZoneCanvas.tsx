import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { DetectionZone, Point2D } from '@vip/contracts';

/** The minimum a subject needs for this canvas to draw it. */
export interface TrackBox {
  trackId: string;
  bbox: readonly [number, number, number, number];
  identityId?: string | undefined;
}

/**
 * The zone canvas — where an operator draws a polygon, and where the demonstration shows a subject
 * standing in one (P-8 Phase 7 §Zones, Architect recs 6 + 7).
 *
 * ### ⚠️ Normalised `[0,1]` coordinates throughout, and no pixels anywhere
 *
 * A zone is stored in the image plane's normalised space, so it survives a camera being reconfigured
 * to a different resolution. This component therefore renders an SVG with `viewBox="0 0 1 1"` and
 * never converts to pixels: the browser scales, and a zone drawn on a laptop matches the same zone
 * evaluated on the server to the last decimal. Converting to pixels and back is where a zone editor
 * acquires a rounding error that moves an incident boundary.
 *
 * ### ⚠️ There is no video frame behind it, and the component says so
 *
 * The platform has no endpoint that serves a camera's latest frame as an image — recording writes
 * MP4 segments and playback serves ranges, neither of which is a still. Rather than invent one for
 * this milestone, the canvas draws the **live tracked subjects** over a labelled grid, which is the
 * real spatial information the platform actually has. An operator sees where people are and draws
 * around them.
 *
 * That is a genuine limitation and it is recorded as such rather than papered over with a grey
 * rectangle that looks like a camera that is offline. See KNOWN_LIMITATIONS.
 */

export interface ZoneCanvasProps {
  /** Zones to render. The one being edited is passed separately in `draft`. */
  zones: readonly DetectionZone[];
  /** The polygon under construction, if any — rendered differently from a saved zone. */
  draft?: readonly Point2D[];
  /** ⚠️ `line` draws the draft open and unfilled — see the rendering note below. */
  draftKind?: 'area' | 'line' | undefined;
  /**
   * Live tracked subjects, drawn as boxes with their floor-contact anchor marked.
   *
   * ⚠️ Typed structurally rather than as `Track`, so the demonstration can feed it the small subset
   * it has (a box and an identity) without fabricating the twenty other fields a `Track` carries.
   */
  tracks?: readonly TrackBox[];
  /** Zone ids to highlight — the ones a rule watches, or the one an incident names. */
  highlight?: readonly string[];
  /** When set, clicking the canvas appends a point. Absent ⇒ read-only. */
  onAddPoint?: (point: Point2D) => void;
  /** Ids of subjects currently accumulating dwell, so the demonstration can mark them. */
  dwelling?: ReadonlySet<string>;
  label?: string;
}

/** ⚠️ Two decimals. A zone vertex placed to six is precision the operator did not intend. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function toPath(points: readonly Point2D[]): string {
  if (points.length === 0) return '';
  return `${points.map(([x, y]) => `${x},${y}`).join(' ')}`;
}

export function ZoneCanvas({
  zones,
  draft,
  draftKind,
  tracks,
  highlight,
  onAddPoint,
  dwelling,
  label,
}: ZoneCanvasProps): ReactElement {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Point2D | null>(null);
  const highlighted = useMemo(() => new Set(highlight ?? []), [highlight]);

  /**
   * Convert a click to normalised coordinates.
   *
   * ⚠️ Uses `getBoundingClientRect`, not the event's offset, because the SVG is scaled by CSS and
   * `offsetX` would be in the element's own coordinate system on some browsers and the page's on
   * others. A zone that landed in a different place depending on the browser would be the worst
   * possible defect here: invisible to whoever drew it, and wrong for everyone else.
   */
  const positionOf = useCallback((event: { clientX: number; clientY: number }): Point2D | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return null;
    const x = round((event.clientX - rect.left) / rect.width);
    const y = round((event.clientY - rect.top) / rect.height);
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [x, y];
  }, []);

  const drawing = onAddPoint !== undefined;

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-surface-2">
      <svg
        ref={svgRef}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        role={drawing ? 'application' : 'img'}
        aria-label={label ?? 'Detection zones'}
        className={`block h-full w-full ${drawing ? 'cursor-crosshair' : ''}`}
        style={{ aspectRatio: '16 / 9' }}
        onClick={(event) => {
          if (!drawing) return;
          const point = positionOf(event);
          if (point !== null) onAddPoint(point);
        }}
        onMouseMove={(event) => {
          if (!drawing) return;
          setHover(positionOf(event));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {/* A grid, so an operator can judge position without a frame behind it. */}
        <defs>
          <pattern id="zone-grid" width="0.1" height="0.1" patternUnits="userSpaceOnUse">
            <path
              d="M 0.1 0 L 0 0 0 0.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.002"
              className="text-border"
            />
          </pattern>
        </defs>
        <rect width="1" height="1" fill="url(#zone-grid)" />

        {/* Saved zones. ⚠️ A disabled zone is drawn dashed and dim — present, not evaluated. */}
        {zones.map((zone) => {
          const on = highlighted.size === 0 || highlighted.has(zone.id);
          const live = zone.enabled && on;
          /*
           * ⛔ **A line is drawn OPEN, and it is never filled** (slice 2.9).
           *
           * `<polygon>` closes the path implicitly, so a two-point tripwire drawn as one renders as
           * a degenerate sliver and a bent line renders as a shaded triangle nobody drew. Worse, the
           * shading reads as an *area* — and the platform's answer for a line is a crossing, not a
           * membership. A picture that implies an inside for a shape that has none is the editor
           * teaching an operator the wrong model of what they configured.
           */
          const isLine = zone.kind === 'line';
          return (
            <g key={zone.id} data-testid={`zone-${zone.id}`} data-kind={zone.kind}>
              {isLine ? (
                <>
                  <polyline
                    points={toPath(zone.geometry.points)}
                    fill="none"
                    stroke={live ? 'rgb(52 211 153)' : 'rgb(148 163 184)'}
                    strokeWidth="0.008"
                    strokeLinecap="round"
                    strokeDasharray={zone.enabled ? undefined : '0.02 0.01'}
                  />
                  {/* ⭐ The first vertex, marked. Which side is `left` is decided by the order the
                      operator drew the points and by nothing else, so the direction of the line has
                      to be visible — a rule naming a direction is bound to it. */}
                  <circle
                    cx={zone.geometry.points[0]?.[0] ?? 0}
                    cy={zone.geometry.points[0]?.[1] ?? 0}
                    r="0.014"
                    fill={live ? 'rgb(52 211 153)' : 'rgb(148 163 184)'}
                  />
                </>
              ) : (
                <polygon
                  points={toPath(zone.geometry.points)}
                  fill={live ? 'rgb(56 189 248 / 0.18)' : 'rgb(148 163 184 / 0.08)'}
                  stroke={live ? 'rgb(56 189 248)' : 'rgb(148 163 184)'}
                  strokeWidth="0.004"
                  strokeDasharray={zone.enabled ? undefined : '0.02 0.01'}
                />
              )}
              {/*
               * ⚠️ **No text inside the SVG.** `preserveAspectRatio="none"` is what makes the
               * geometry correct — a zone at x = 0.5 must sit at 50% of the width whatever the
               * element's shape — and it stretches glyphs by the same factor, which rendered
               * "Checkout Queue" across half the frame in letters wider than they were tall. Names
               * go in the legend below, where the browser lays them out normally.
               */}
            </g>
          );
        })}

        {/* The polygon being drawn. Vertices are shown so a mis-click can be seen and undone. */}
        {draft !== undefined && draft.length > 0 ? (
          <g data-testid="zone-draft" data-kind={draftKind ?? 'area'}>
            {/* ⛔ The draft follows the same rule as a saved zone: a line is open and unfilled, or
                the operator is shown a shape they are not drawing. */}
            {draftKind === 'line' ? (
              <polyline
                points={toPath(draft)}
                fill="none"
                stroke="rgb(52 211 153)"
                strokeWidth="0.008"
                strokeLinecap="round"
              />
            ) : (
              <polygon
                points={toPath(draft)}
                fill="rgb(52 211 153 / 0.2)"
                stroke="rgb(52 211 153)"
                strokeWidth="0.005"
              />
            )}
            {draft.map(([x, y], i) => (
              <circle key={`${x}-${y}-${i}`} cx={x} cy={y} r="0.012" fill="rgb(52 211 153)" />
            ))}
          </g>
        ) : null}

        {/*
         * Live subjects.
         *
         * ⚠️ The **anchor dot** is drawn at the bottom centre of every box, because that is the point
         * the server actually tests against the polygon. An editor that showed only boxes would let an
         * operator draw a zone that looks right and evaluates differently — the exact
         * inference-from-appearance this platform keeps removing.
         */}
        {(tracks ?? []).map((track) => {
          const [x, y, w, h] = track.bbox;
          const anchorX = x + w / 2;
          const anchorY = y + h;
          const isDwelling = dwelling?.has(track.identityId ?? track.trackId) ?? false;
          return (
            <g key={track.trackId} data-testid={`track-${track.trackId}`}>
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill="none"
                stroke={isDwelling ? 'rgb(251 191 36)' : 'rgb(226 232 240)'}
                strokeWidth="0.004"
              />
              <circle
                cx={anchorX}
                cy={anchorY}
                r="0.01"
                fill={isDwelling ? 'rgb(251 191 36)' : 'rgb(226 232 240)'}
              />
            </g>
          );
        })}

        {hover !== null ? (
          <circle cx={hover[0]} cy={hover[1]} r="0.008" fill="rgb(52 211 153 / 0.6)" />
        ) : null}
      </svg>

      {/*
       * The legend. ⚠️ Outside the SVG for the reason above, and it doubles as the accessible name
       * list — the shapes themselves convey nothing to a screen reader.
       */}
      {zones.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs">
          {zones.map((zone) => {
            const on = highlighted.size === 0 || highlighted.has(zone.id);
            return (
              <li key={zone.id} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-sm border"
                  style={{
                    borderColor: zone.enabled && on ? 'rgb(56 189 248)' : 'rgb(148 163 184)',
                    background:
                      zone.enabled && on ? 'rgb(56 189 248 / 0.35)' : 'rgb(148 163 184 / 0.15)',
                  }}
                />
                <span className={zone.enabled ? '' : 'text-fg-muted'}>
                  {zone.name}
                  {zone.enabled ? '' : ' (off)'}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/*
       * ⚠️ Stated on the canvas, not buried in documentation. An operator drawing over a grid must
       * know they are not looking at the camera — otherwise they will assume the grid IS the frame
       * and place a zone by eye against nothing.
       */}
      <p className="border-t border-border px-3 py-1.5 text-xs text-fg-muted">
        Normalised camera coordinates (0–1). No video frame is available to draw over; live tracked
        subjects are shown instead, with a dot at the floor-contact point the server tests.
        {hover !== null ? ` · cursor ${hover[0].toFixed(2)}, ${hover[1].toFixed(2)}` : ''}
      </p>
    </div>
  );
}
