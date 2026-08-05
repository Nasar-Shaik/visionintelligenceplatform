import { Radar, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  MetricCard,
  PageHeader,
  PageSkeleton,
  QueryBoundary,
} from '@/ui';
import { useTrackingOverview, type TrackingEngine, type TrackingStats } from './useTracking';
import { asMs, asRatio, asSeconds, measured, unavailableReason } from './trackPresentation';

/**
 * Runtime Track Statistics — how the tracking engine is behaving (P-8 Phase 4).
 *
 * ### ⚠️ Every derived figure is "Not measured" until it is measured
 *
 * The same rule as the AI Runtime page, for the same reason. `0.00 ms average tracking time` and
 * "this runtime has not tracked anything" render identically as a number and mean opposite things —
 * and the second one is the answer during an outage.
 *
 * ### ⚠️ Fragmentation is not an accuracy score, and the page says so
 *
 * It is tracks created per confirmed track. An engine that splits one person into six identities
 * scores 6.0. But proving that two identities were genuinely **swapped** requires ground truth the
 * runtime does not have — a live camera cannot tell you who it was looking at. Naming this
 * "accuracy" would be the single most misleading thing on the page, so it is named for the symptom
 * it actually measures and the limit is printed underneath it.
 */
export function TrackStatisticsPage() {
  const canRead = usePermission('track:read');
  const query = useTrackingOverview();
  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <PageHeader title="Track statistics" description="How the tracking engine is behaving." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Tracking is available to roles holding track:read."
        />
      </div>
    );
  }

  const unavailable = unavailableReason(query.data);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="Track statistics"
        description="What the tracking engine has done since this runtime started. Every value is measured from the running deployment."
        breadcrumbs={[{ label: 'Live Tracks', href: '/tracking' }, { label: 'Statistics' }]}
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
        ) : query.data?.stats !== undefined ? (
          <Statistics
            stats={query.data.stats}
            {...(query.data.engine === undefined ? {} : { engine: query.data.engine })}
          />
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function Statistics({ stats, engine }: { stats: TrackingStats; engine?: TrackingEngine }) {
  const trackingMs = measured(stats.averageTrackingMs, asMs);
  const lifetime = measured(stats.averageTrackLifetimeSeconds, asSeconds);
  const hits = measured(stats.averageTrackHits, asRatio);
  const fragmentation = measured(stats.fragmentation, asRatio);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Cameras tracked" value={String(stats.camerasTracked)} />
        <MetricCard label="Active identities" value={String(stats.activeTracks)} />
        <MetricCard label="Confirmed" value={String(stats.confirmedTracks)} />
        <MetricCard label="Lost" value={String(stats.lostTracks)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>
            What has happened to identities over this runtime&apos;s life.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Created" value={String(stats.createdTracks)} />
            <Stat label="Ended" value={String(stats.removedTracks)} />
            <Stat
              label="Re-entered"
              value={String(stats.recoveredTracks)}
              hint="Identities linked back across a gap. The track id is always new."
            />
            <Stat label="Average lifetime" value={lifetime.text} measured={lifetime.measured} />
            <Stat label="Average detections per track" value={hits.text} measured={hits.measured} />
            <Stat
              label="Fragmentation"
              value={fragmentation.text}
              measured={fragmentation.measured}
              hint="Tracks created per confirmed track. 1.00 is ideal."
            />
          </dl>
          <p className="mt-4 text-xs text-text-subtle">
            ⚠️ <strong>Fragmentation is not accuracy.</strong> It shows how often the engine splits
            one object into several identities. It cannot tell you whether two identities were
            <em> swapped</em> — proving that needs ground truth about who was actually in frame,
            which a live camera does not provide. Identity-swap behaviour is verified against
            authored scenarios in the nightly run, not inferred from this number.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cost</CardTitle>
          <CardDescription>What tracking adds to each analysed frame.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Frames tracked" value={String(stats.framesTracked)} />
            <Stat
              label="Average tracking time"
              value={trackingMs.text}
              measured={trackingMs.measured}
              hint="Association and lifecycle only — not inference."
            />
            <Stat
              label="Out-of-order frames"
              value={String(stats.outOfOrderFrames ?? 0)}
              hint="Frames that arrived older than one already processed, and were skipped rather than tracked backwards."
            />
          </dl>
        </CardContent>
      </Card>

      {engine !== undefined ? (
        <Card>
          <CardHeader>
            <CardTitle>Engine</CardTitle>
            <CardDescription>
              How this runtime is configured. ⚠️ Reported, not editable — these are deployment
              settings, and a control here would configure nothing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Associator" value={engine.associator} />
              <Stat label="Overlap floor" value={asRatio(engine.minIou)} />
              <Stat
                label="Overlap floor (coasting)"
                value={asRatio(engine.minIouLost)}
                hint="Stricter: a predicted position is a guess."
              />
              <Stat label="Detections to confirm" value={String(engine.minHits)} />
              <Stat
                label="Frames held when lost"
                value={String(engine.maxAgeFrames)}
                hint="At 2 fps this is about half as many seconds."
              />
              <Stat label="Path points kept" value={String(engine.historyMax)} />
              <Stat label="Re-entry window" value={`${engine.reentryGapSeconds}s`} />
              <Stat label="Re-entry radius" value={`${engine.reentryDistance} fw`} />
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  measured: isMeasured = true,
}: {
  label: string;
  value: string;
  hint?: string;
  measured?: boolean;
}) {
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
