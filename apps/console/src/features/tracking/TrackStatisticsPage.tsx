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
import {
  useCameraTracking,
  useTrackingOverview,
  type CameraTrackingStats,
  type TrackingEngine,
  type TrackingStats,
} from './useTracking';
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
 *
 * ### ⚠️ Three metrics are shown as NOT MEASURABLE, on purpose (ADR-0039)
 *
 * Identity switches, re-identification success and false recoveries all ask whether the tracker was
 * *right*, which needs ground truth. They are rendered with the reason the runtime gave, rather than
 * hidden — an absent row and an unwired metric look identical, and one of those is a bug.
 *
 * ### ⚠️ Still read-only, and there is nothing here to make it otherwise
 *
 * No control on this page changes runtime state. Per-camera rows are a *view*; the enable/disable
 * switch they obviously suggest belongs to Camera Processing Assignment, which is not built. A
 * toggle that configured nothing would be worse than no toggle.
 */
export function TrackStatisticsPage() {
  const canRead = usePermission('track:read');
  const query = useTrackingOverview();
  const cameras = useCameraTracking();
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
            {...(cameras.data?.cameras === undefined ? {} : { cameras: cameras.data.cameras })}
            {...(query.data.engine === undefined ? {} : { engine: query.data.engine })}
          />
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function Statistics({
  stats,
  engine,
  cameras,
}: {
  stats: TrackingStats;
  engine?: TrackingEngine;
  cameras?: CameraTrackingStats[];
}) {
  const trackingMs = measured(stats.averageTrackingMs, asMs);
  const lifetime = measured(stats.averageTrackLifetimeSeconds, asSeconds);
  const hits = measured(stats.averageTrackHits, asRatio);
  const age = measured(stats.averageTrackAgeFrames ?? null, asRatio);
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
            <Stat
              label="Occlusions absorbed"
              value={String(stats.occlusionsSurvived ?? 0)}
              hint="The identity went out of view and came back with the SAME track id — no consumer saw a gap."
            />
            <Stat
              label="Crossings"
              value={String(stats.crossings ?? 0)}
              hint="Times two identities occupied the same place. An opportunity for a swap, not evidence of one."
            />
            <Stat label="Average lifetime" value={lifetime.text} measured={lifetime.measured} />
            <Stat label="Average detections per track" value={hits.text} measured={hits.measured} />
            <Stat
              label="Average age"
              value={age.measured ? `${age.text} frames` : age.text}
              measured={age.measured}
              hint="Frames since first sighting — larger than detections per track by exactly the coasting."
            />
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

      <NotMeasurable stats={stats} />

      {cameras !== undefined && cameras.length > 0 ? <PerCamera cameras={cameras} /> : null}

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

/**
 * The three metrics no live runtime can produce (ADR-0039).
 *
 * ⚠️ **Rendered, not hidden.** A dashboard that silently omits an unmeasurable metric is
 * indistinguishable from one whose exporter is broken, and the operator has no way to tell which
 * they are looking at. So the rows are here, they say "Not measurable", and they carry the reason
 * the runtime itself gave — along with where the numbers DO exist.
 *
 * ⚠️ **The value is READ from the payload, never assumed — and that was a defect here.** The first
 * version hard-coded the string "Not measurable" for every row. A mutation that made the runtime
 * report `identitySwitches: 0` therefore changed nothing on screen: the page covered up a contract
 * violation and the browser verification stayed green. A page whose job is to report runtime truth
 * must not decide in advance what the truth is. If a runtime ever does send a number, this shows it
 * — and the verification then catches it, which is the whole point.
 */
function NotMeasurable({ stats }: { stats: TrackingStats }) {
  const truth = stats.groundTruth;
  if (truth === undefined || truth.available) return null;
  const labels: Record<string, string> = {
    identitySwitches: 'Identity switches',
    reidentificationSuccessRate: 'Re-identification success',
    falseRecoveries: 'False recoveries',
  };
  const reported = stats as unknown as Record<string, unknown>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Not measurable here</CardTitle>
        <CardDescription>
          Metrics that ask whether the tracker was <em>right</em>, which this deployment cannot
          answer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {truth.metrics.map((metric) => {
            const value = reported[metric];
            const isNumber = typeof value === 'number';
            return (
              <Stat
                key={metric}
                label={labels[metric] ?? metric}
                value={isNumber ? String(value) : 'Not measurable'}
                measured={isNumber}
                {...(isNumber
                  ? {
                      hint: '⚠️ The runtime reported a number for a metric it declared unmeasurable. That is a contract violation — see ADR-0039.',
                    }
                  : {})}
              />
            );
          })}
        </dl>
        <p className="mt-4 text-xs text-text-subtle">
          ⚠️ <strong>These are absent, never zero.</strong> {truth.reason} A <code>0</code> here
          would be a confident claim of a clean identity record that nothing verified.
          {truth.measuredBy === undefined ? null : (
            <>
              {' '}
              They <em>are</em> measured against authored scenarios, where the trajectories were
              written down before the run — see <code>{truth.measuredBy}</code>.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Per-camera tracking metrics.
 *
 * ⚠️ **A view, not a control.** The obvious next thing here is a per-camera enable switch. That is
 * Camera Processing Assignment (C-14c) and it is not built, so there is no switch — a control that
 * configured nothing would be worse than its absence.
 *
 * ⚠️ A row with `tracking: false` is a camera that has gone quiet: its counters are history and its
 * live counts are zero for a reason that is not "nobody is there". The table says so rather than
 * showing a row that reads as a dead camera.
 */
function PerCamera({ cameras }: { cameras: CameraTrackingStats[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Per camera</CardTitle>
        <CardDescription>
          What each camera has contributed. Counts survive a camera going quiet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-text-subtle">
                <th className="py-2 text-left font-medium">Camera</th>
                <th className="py-2 text-right font-medium">Active</th>
                <th className="py-2 text-right font-medium">Created</th>
                <th className="py-2 text-right font-medium">Ended</th>
                <th className="py-2 text-right font-medium">Re-entered</th>
                <th className="py-2 text-right font-medium">Frames</th>
                <th className="py-2 text-right font-medium">Tracking fps</th>
                <th className="py-2 text-right font-medium">Tracking time</th>
              </tr>
            </thead>
            <tbody>
              {cameras.map((camera) => {
                const fps = measured(camera.trackingFps, (v) => v.toFixed(2));
                const ms = measured(camera.averageTrackingMs, asMs);
                return (
                  <tr key={camera.cameraId} className="border-b border-border/50">
                    <td className="py-2 text-left">
                      <span className="text-foreground">{camera.cameraId}</span>
                      {camera.tracking ? null : (
                        <span className="ml-2 text-2xs text-text-subtle">
                          idle · counts are history
                        </span>
                      )}
                    </td>
                    <td className="tabular py-2 text-right">{camera.activeTracks}</td>
                    <td className="tabular py-2 text-right">{camera.createdTracks}</td>
                    <td className="tabular py-2 text-right">{camera.removedTracks}</td>
                    <td className="tabular py-2 text-right">{camera.recoveredTracks}</td>
                    <td className="tabular py-2 text-right">{camera.framesTracked}</td>
                    <td
                      className={
                        fps.measured
                          ? 'tabular py-2 text-right'
                          : 'py-2 text-right text-text-subtle'
                      }
                    >
                      {fps.text}
                    </td>
                    <td
                      className={
                        ms.measured ? 'tabular py-2 text-right' : 'py-2 text-right text-text-subtle'
                      }
                    >
                      {ms.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
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
