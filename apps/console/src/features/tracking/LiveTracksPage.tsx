import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Radar, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { timeAgo } from '@/lib/format';
import {
  Badge,
  Card,
  CardContent,
  EmptyState,
  PageHeader,
  PageSkeleton,
  QueryBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui';
import { useLiveTracks, useTrackingOverview, type Track } from './useTracking';
import { TrackStateBadge } from './TrackStateBadge';
import { asDistance, asSpeed, headingText, unavailableReason } from './trackPresentation';

const STATES = ['all', 'confirmed', 'tentative', 'lost'] as const;

/**
 * Live Tracks — what the tracking engine is following right now (P-8 Phase 4).
 *
 * ### ⚠️ Read-only, and the page says so rather than implying it
 *
 * There is no control here that starts, stops, resets or reassigns anything, and no rule editing, no
 * incident creation and no acknowledgement. Tracking is a *consequence* of frames arriving, not
 * something an operator steers — and P-8 Phase 4 deliberately ships the visibility before any of the
 * actions that will eventually sit on top of it. A control that configured nothing would be worse
 * than an absent one.
 *
 * ### ⚠️ "Not measured", never a confident zero
 *
 * A track that has been seen once has no speed and no direction, and this page prints "Not measured"
 * for both. `0.000 fw/s ↦ right` would be a claim about a stationary object travelling rightwards,
 * which is two assertions the platform has no basis for.
 *
 * ### ⚠️ Every distance is a fraction of the frame
 *
 * Speed is **frame widths per second** and the unit is on every reading. Metres per second needs
 * camera calibration this platform does not have, and a bare "1.2" on a CCTV page will be read as
 * m/s by the next person who sees it.
 */
export function LiveTracksPage() {
  const canRead = usePermission('track:read');
  const [state, setState] = useState<(typeof STATES)[number]>('all');
  const overview = useTrackingOverview();
  const query = useLiveTracks(state === 'all' ? {} : { state });
  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <PageHeader title="Live Tracks" description="Objects the platform is following." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Tracking is available to roles holding track:read. This restriction says nothing about whether tracking is working."
        />
      </div>
    );
  }

  const unavailable = unavailableReason(overview.data);
  const tracks = query.data?.tracks ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <PageHeader
        title="Live Tracks"
        description="Objects the tracking engine is following right now. Read-only — this page reports, it does not steer."
      />

      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        skeleton={<PageSkeleton />}
      >
        {unavailable !== null ? (
          <EmptyState
            icon={Radar}
            title={unavailable.title}
            description={unavailable.description}
          />
        ) : (
          <>
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Filter by state"
            >
              {STATES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setState(option)}
                  aria-pressed={state === option}
                  className={
                    state === option
                      ? 'rounded-sm border border-brand-border bg-brand-muted px-2 py-1 text-xs text-brand'
                      : 'rounded-sm border border-border bg-surface-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {option === 'all' ? 'All' : option}
                </button>
              ))}
              <span className="ml-auto text-xs text-text-subtle">
                {tracks.length} track{tracks.length === 1 ? '' : 's'} ·{' '}
                {query.data?.stats?.camerasTracked ?? 0} camera
                {(query.data?.stats?.camerasTracked ?? 0) === 1 ? '' : 's'}
              </span>
            </div>

            {tracks.length === 0 ? (
              <EmptyState
                icon={Radar}
                title="Nothing is being tracked"
                /*
                 * ⚠️ Deliberately distinguished from "tracking is off" and "the runtime is down",
                 * which are handled above. This state means the engine is running and has seen
                 * nobody — a normal answer for a quiet site, and a very different one from a fault.
                 */
                description="The engine is running and no object is in view. Tracking state appears for a camera the moment a frame from it produces a detection."
              />
            ) : (
              <Card>
                <CardContent className="p-0">
                  <Table density="compact">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Track</TableHead>
                        <TableHead>Camera</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead className="text-right">Seen</TableHead>
                        <TableHead className="text-right">Duration</TableHead>
                        <TableHead className="text-right">Travelled</TableHead>
                        <TableHead className="text-right">Speed</TableHead>
                        <TableHead>Direction</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tracks.map((track) => (
                        <TrackRow key={track.trackId} track={track} />
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            <p className="text-xs text-text-subtle">
              ⚠️ Speed and travelled distance are in <strong>frame widths</strong>, not metres.
              Converting to real-world units needs camera calibration this platform does not have,
              so a person walking towards the lens covers very little distance here while covering
              real ground.
            </p>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

function TrackRow({ track }: { track: Track }) {
  const motion = track.motion;
  const rejoined = track.precededBy !== undefined;
  return (
    <TableRow>
      <TableCell>
        <Link
          to={`/tracking/${encodeURIComponent(track.trackId)}`}
          className="font-medium text-brand hover:underline"
        >
          {track.label}
        </Link>
        <span className="ml-2 text-2xs text-text-subtle">{shortId(track.trackId)}</span>
        {rejoined ? (
          <Badge
            variant="outline"
            className="ml-2"
            title={`Re-entered from ${track.precededBy}. The identity is linked; the track id is new, because ids are never reused.`}
          >
            re-entered ×{track.recoveries ?? 1}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="text-muted-foreground">{track.cameraId}</TableCell>
      <TableCell>
        <TrackStateBadge state={track.state} />
      </TableCell>
      <TableCell className="tabular text-right text-muted-foreground">
        {timeAgo(track.lastSeen.at)}
      </TableCell>
      <TableCell className="tabular text-right">
        {motion === undefined ? notMeasured() : `${motion.durationSeconds.toFixed(1)}s`}
      </TableCell>
      <TableCell className="tabular text-right">
        {motion === undefined ? notMeasured() : asDistance(motion.pathLengthNormalized)}
      </TableCell>
      <TableCell className="tabular text-right">
        {motion === undefined ? notMeasured() : asSpeed(motion.currentSpeedNormalized)}
      </TableCell>
      <TableCell className="text-muted-foreground">{headingText(motion)}</TableCell>
    </TableRow>
  );
}

/** ⚠️ Rendered as words, so it can never be mistaken for a measured zero at a glance. */
function notMeasured() {
  return <span className="text-text-subtle">Not measured</span>;
}

/** Track ids carry tenant, camera and session; the tail is what distinguishes them on screen. */
function shortId(trackId: string): string {
  const parts = trackId.split('_');
  return parts.length > 1 ? `#${parts[parts.length - 1]}` : trackId;
}
