import { Link, useParams } from 'react-router-dom';
import { Radar, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { formatTimestamp } from '@/lib/format';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  PageSkeleton,
  QueryBoundary,
  Timeline,
  type TimelineItem,
} from '@/ui';
import { useTrackDetail, type TrackTimelineEntry } from './useTracking';
import { STATE_DESCRIPTION, STATE_LABEL } from './trackPresentation';

/**
 * Track Timeline — the lifecycle of one identity, in order (P-8 Phase 4).
 *
 * ### ⚠️ Append-only, and the awkward entries stay
 *
 * A track that was lost and then recovered still shows that it was lost. Smoothing the gap would
 * produce a cleaner-looking page that answers **"was this the same person throughout?"** wrongly,
 * and with total confidence — which is exactly the question an investigator asks. The `lost` rows
 * are the ones that matter most on this screen, so they are never collapsed or hidden.
 *
 * ### ⚠️ Separate from Track Detail on purpose
 *
 * Detail answers "where did it go?"; this answers "what happened to the identity, and when?". They
 * are different questions asked at different moments — the second one usually while somebody is
 * deciding whether to trust the first.
 */
export function TrackTimelinePage() {
  const { trackId } = useParams<{ trackId: string }>();
  const canRead = usePermission('track:read');
  const query = useTrackDetail(trackId);
  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;
  const gone = query.error instanceof ApiRequestError && query.error.status === 404;

  const header = (
    <PageHeader
      title="Track timeline"
      description="Every lifecycle transition this identity went through, in order."
      breadcrumbs={[
        { label: 'Live Tracks', href: '/tracking' },
        ...(trackId === undefined
          ? []
          : [{ label: 'Track', href: `/tracking/${encodeURIComponent(trackId)}` }]),
        { label: 'Timeline' },
      ]}
    />
  );

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        {header}
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Tracking is available to roles holding track:read."
        />
      </div>
    );
  }

  if (gone) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        {header}
        <EmptyState
          icon={Radar}
          title="That track has ended"
          description="Live tracks are not retained after they end, so their lifecycle is no longer readable."
          action={
            <Link to="/tracking" className="text-sm text-brand hover:underline">
              Back to live tracks
            </Link>
          }
        />
      </div>
    );
  }

  const entries = query.data?.timeline ?? [];
  const track = query.data?.track;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      {header}
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        skeleton={<PageSkeleton />}
      >
        <Card>
          <CardHeader>
            <CardTitle>{track ? `${track.label} · ${track.cameraId}` : 'Lifecycle'}</CardTitle>
            <CardDescription className="font-mono text-2xs">{track?.trackId}</CardDescription>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <p className="text-sm text-text-subtle">
                No transitions recorded yet. The first appears when the identity is created.
              </p>
            ) : (
              <Timeline items={entries.map(toItem)} />
            )}
          </CardContent>
        </Card>

        {track?.precededBy !== undefined ? (
          <Card>
            <CardHeader>
              <CardTitle>Before this track</CardTitle>
              <CardDescription>
                This identity continues an earlier one. ⚠️ The earlier track kept its own id — ids
                are never reused, so a consumer holding the old one still refers to the old
                observations.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to={`/tracking/${encodeURIComponent(track.precededBy)}`}
                className="font-mono text-sm text-brand hover:underline"
              >
                {track.precededBy}
              </Link>
              <p className="mt-2 text-xs text-text-subtle">
                Linked on position, size and elapsed time. There is no appearance model behind this
                — treat it as a strong hint rather than proof of identity.
              </p>
            </CardContent>
          </Card>
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function toItem(entry: TrackTimelineEntry, index: number): TimelineItem {
  const from = entry.from == null ? null : STATE_LABEL[entry.from];
  return {
    id: `${entry.frameIndex}-${entry.to}-${index}`,
    title:
      from === null ? `Created — ${STATE_LABEL[entry.to]}` : `${from} → ${STATE_LABEL[entry.to]}`,
    description: entry.reason ?? STATE_DESCRIPTION[entry.to],
    at: formatTimestamp(entry.at),
    /*
     * ⚠️ `lost` is the only transition given weight, because it is the only one that changes what
     * the rest of the record means. Colouring every row would make the page pretty and flat.
     */
    ...(entry.to === 'lost' ? { severity: 'medium' as const } : {}),
  };
}
