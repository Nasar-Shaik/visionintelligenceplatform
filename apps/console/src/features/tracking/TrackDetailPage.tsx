import { Link, useParams } from 'react-router-dom';
import { Radar, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { formatTimestamp, timeAgo } from '@/lib/format';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  PageSkeleton,
  QueryBoundary,
} from '@/ui';
import { useTrackDetail, type Track } from './useTracking';
import {
  TrackStateBadge,
  asDistance,
  asPercent,
  asSeconds,
  asSpeed,
  headingText,
} from './trackPresentation';
import { TrackPath } from './TrackPath';

/**
 * Track Detail — one identity, everything measured about it (P-8 Phase 4).
 *
 * ### ⚠️ The identity chain is shown, not smoothed
 *
 * When an object leaves and comes back, the returning track gets a **new** `trackId` and a link to
 * the old one. This page shows both. Presenting the chain as a single unbroken identity would be the
 * flattering reading, and it would answer "was this the same person throughout?" with a confidence
 * the platform has not earned — the link is geometric (position, size, elapsed time), with no
 * appearance model behind it.
 *
 * ### ⚠️ Nothing here is a judgement
 *
 * Dwell is geometry: seconds during which the centroid barely moved. It is not loitering, and this
 * page never uses that word. Assigning meaning is the Rule Engine's job, and it does not exist yet.
 */
export function TrackDetailPage() {
  const { trackId } = useParams<{ trackId: string }>();
  const canRead = usePermission('track:read');
  const query = useTrackDetail(trackId);
  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;
  const gone = query.error instanceof ApiRequestError && query.error.status === 404;

  if (!canRead || forbidden) {
    return (
      <Shell>
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Tracking is available to roles holding track:read."
        />
      </Shell>
    );
  }

  if (gone) {
    return (
      <Shell>
        <EmptyState
          icon={Radar}
          title="That track has ended"
          /*
           * ⚠️ Not an error. A track ending while somebody reads its page is the ordinary case on a
           * live scene — the person walked out of shot. Saying so plainly, with a way back, beats a
           * red banner that implies something broke.
           */
          description="The identity was closed because the object was out of view for longer than the engine holds one open. Live tracks are not retained after they end."
          action={
            <Link to="/tracking" className="text-sm text-brand hover:underline">
              Back to live tracks
            </Link>
          }
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        skeleton={<PageSkeleton />}
      >
        {query.data ? <Detail track={query.data.track} /> : null}
      </QueryBoundary>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="Track"
        description="One identity, and everything measured about how it moved."
        breadcrumbs={[{ label: 'Live Tracks', href: '/tracking' }, { label: 'Track' }]}
      />
      {children}
    </div>
  );
}

function Detail({ track }: { track: Track }) {
  const motion = track.motion;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{track.label}</CardTitle>
            <TrackStateBadge state={track.state} />
            <Badge variant="outline" title="Camera this identity belongs to">
              {track.cameraId}
            </Badge>
            <Link
              to={`/tracking/${encodeURIComponent(track.trackId)}/timeline`}
              className="ml-auto text-sm text-brand hover:underline"
            >
              Lifecycle timeline →
            </Link>
          </div>
          <CardDescription className="font-mono text-2xs">{track.trackId}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {track.precededBy !== undefined ? (
            <Alert variant="info" title="This identity was re-entered">
              The object left view and came back. It was linked to{' '}
              <Link
                to={`/tracking/${encodeURIComponent(track.precededBy)}`}
                className="text-brand hover:underline"
              >
                {track.precededBy}
              </Link>{' '}
              after {track.recoveries ?? 1} gap{(track.recoveries ?? 1) === 1 ? '' : 's'}.
              {/*
               * ⚠️ Stated as a limit rather than left to be assumed. The link is geometric — where
               * it vanished, where one reappeared, how long it took, how big it was. There is no
               * appearance model, so two similar people passing through the same doorway inside the
               * gap window are indistinguishable to this logic.
               */}
              <p className="mt-2 text-sm">
                The link is based on position, size and elapsed time — not on appearance. Treat it
                as a strong hint, not as proof that this is the same person.
              </p>
            </Alert>
          ) : null}

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="First seen" value={formatTimestamp(track.firstSeen.at)} />
            <Field label="Last seen" value={timeAgo(track.lastSeen.at)} />
            <Field label="Detections" value={String(track.hits)} />
            <Field label="Confidence" value={asPercent(track.confidence)} />
          </dl>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Headline
          label="Duration"
          value={motion ? asSeconds(motion.durationSeconds) : 'Not measured'}
          hint="First seen to last seen, including time spent lost."
        />
        <Headline
          label="Travelled"
          value={motion ? asDistance(motion.pathLengthNormalized) : 'Not measured'}
          hint="Path length in frame widths — not metres."
        />
        <Headline
          label="Average speed"
          value={motion ? asSpeed(motion.averageSpeedNormalized) : 'Not measured'}
          hint="Frame widths per second."
        />
        <Headline
          label="Dwell"
          value={motion ? asSeconds(motion.dwellSeconds) : 'Not measured'}
          hint="Seconds barely moving. Geometry only — not loitering."
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Path</CardTitle>
          <CardDescription>
            The retained trajectory in the camera&apos;s frame. History is bounded, so this is the
            recent past rather than the whole life of the track
            {motion ? ` (${motion.samples} point${motion.samples === 1 ? '' : 's'})` : ''}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrackPath track={track} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Movement</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Direction" value={headingText(motion)} />
            <Field
              label="Current speed"
              value={motion ? asSpeed(motion.currentSpeedNormalized) : 'Not measured'}
            />
            <Field
              label="Straight-line distance"
              value={motion ? asDistance(motion.displacementNormalized) : 'Not measured'}
            />
            <Field
              label="Straightness"
              value={
                motion?.straightness === undefined ? 'Not measured' : motion.straightness.toFixed(2)
              }
              hint="1.00 is a straight line; near zero is milling about."
            />
            <Field
              label="Frames coasted"
              value={
                track.quality.predictionFrames === undefined
                  ? 'Not measured'
                  : String(track.quality.predictionFrames)
              }
              hint="Frames the identity was held open with nothing detected."
            />
            <Field
              label="Frames lost"
              value={
                track.quality.lostFrames === undefined
                  ? 'Not measured'
                  : String(track.quality.lostFrames)
              }
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A headline measurement with its unit spelled out underneath.
 *
 * ⚠️ Not `MetricCard`, which carries a delta and a sparkline. Neither is meaningful for a single
 * live track — a delta needs a previous value and there is no previous track to compare against —
 * and a card with an empty trend area reads as "the trend is flat" rather than "there is no trend".
 */
function Headline({ label, value, hint }: { label: string; value: string; hint: string }) {
  const isMeasured = value !== 'Not measured';
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <p className="text-2xs uppercase tracking-wide text-text-subtle">{label}</p>
      <p
        className={
          isMeasured ? 'tabular mt-1 text-lg text-foreground' : 'mt-1 text-lg text-text-subtle'
        }
      >
        {value}
      </p>
      <p className="mt-1 text-2xs text-text-subtle">{hint}</p>
    </div>
  );
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const isMeasured = value !== 'Not measured';
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className={isMeasured ? 'tabular text-sm text-foreground' : 'text-sm text-text-subtle'}>
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-2xs text-text-subtle">{hint}</p> : null}
    </div>
  );
}
