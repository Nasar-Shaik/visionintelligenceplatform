import { useMemo } from 'react';
import { UserSearch } from 'lucide-react';
import type {
  AnalysisTimeline,
  BehaviourTimelineView,
  TrackHistoryPointView,
  TrackHistoryView,
} from '@vip/contracts';
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui';
import { SeekControl, type RecordingClock } from './parts';
import { historyPointSeconds, placeInRecording } from './footage';
import { timelineKindLabel } from './vocabulary';
import { centreOf, detectionConfidence, incidentsForIdentity, summariseIdentity, zonesOf } from './identity';
import { formatOffset } from '../investigations/format';

/**
 * **One subject's history** (Phase 2.4 slice 2.8): where they went, what they did, and what this run
 * raised because of them.
 *
 * ### ⛔ The trajectory is drawn over an empty frame, on purpose
 *
 * There is no still image behind the path and there deliberately is not one. Caching a frame to draw
 * over would put a copy of somebody's footage outside approved evidence storage — a constraint that
 * exists precisely so a convenience feature cannot quietly become a second copy of a customer's
 * video. `TrackPath` made the same decision for the same reason. A path over a grey rectangle is
 * honest; a path over a frame from three minutes ago looks better and means something else.
 *
 * ### ⛔ Incidents are attached by the RECORDED link, never by the clock
 *
 * See `identity.ts`. An incident that cannot be resolved to a track is counted as unattributable
 * rather than pinned on whoever was in shot at the time.
 */
export interface IdentityHistoryPanelProps {
  identityId: string | undefined;
  history: TrackHistoryView | undefined;
  timeline: BehaviourTimelineView | undefined;
  analysisTimeline: AnalysisTimeline | undefined;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  onSelectIdentity: (identityId: string | undefined) => void;
  /** Every identity in the run, so a subject can be chosen without going back to the timeline. */
  identities: readonly string[];
  isLoading?: boolean;
}

export function IdentityHistoryPanel({
  identityId,
  history,
  timeline,
  analysisTimeline,
  clock,
  onSeek,
  onSelectIdentity,
  identities,
  isLoading = false,
}: IdentityHistoryPanelProps) {
  const record = useMemo(() => {
    if (identityId === undefined) return undefined;
    const all = [...(history?.records ?? []), ...(history?.live ?? [])];
    return all.find((r) => r.identityId === identityId);
  }, [history, identityId]);

  const facts = useMemo(
    () => (identityId === undefined ? [] : summariseIdentity(timeline?.entries ?? [], identityId)),
    [timeline?.entries, identityId],
  );
  const zones = useMemo(() => zonesOf(record), [record]);
  const confidence = useMemo(() => detectionConfidence(record), [record]);
  const incidents = useMemo(
    () => incidentsForIdentity(analysisTimeline, record?.trackIds ?? []),
    [analysisTimeline, record?.trackIds],
  );

  if (identityId === undefined) {
    return (
      <EmptyState
        icon={UserSearch}
        title={identities.length === 0 ? 'This run tracked nobody' : 'Choose a subject'}
        description={
          identities.length === 0
            ? 'No identity survived long enough to be assembled, so there is no history to show. That is an answer about the footage.'
            : "Pick one of this run's identities to see where they went, what they did, and what was raised because of them."
        }
        action={
          <div className="flex max-h-64 flex-wrap justify-center gap-1 overflow-auto">
            {identities.map((id) => (
              <Button
                key={id}
                size="sm"
                variant="outline"
                data-testid="identity-choice"
                onClick={() => onSelectIdentity(id)}
              >
                {id}
              </Button>
            ))}
          </div>
        }
      />
    );
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Reading the movement path…</p>;

  return (
    <section className="space-y-4" data-testid="identity-history">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{identityId}</h3>
        {record === undefined ? null : <Badge variant="neutral">{record.label}</Badge>}
        {record?.closed === false ? <Badge variant="warning">still in view</Badge> : null}
        {/* ⭐ More than one track id means a gap was bridged (ADR-0041) and an investigator can see
            exactly where. One unbroken bar across an occlusion would be a claim the footage does not
            support. */}
        {(record?.trackIds.length ?? 0) > 1 ? (
          <Badge variant="warning">assembled from {record?.trackIds.length} tracks</Badge>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onSelectIdentity(undefined)}>
          Choose another
        </Button>
      </div>

      {record === undefined ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-500">
          {/* ⛔ Stated. A missing movement path and a subject who never moved are different facts. */}
          No stored movement path was returned for this identity, so no trajectory, zone membership or
          detection confidence can be shown. The behaviour facts below still come from this run.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Trajectory record={record} onSeek={onSeek} clock={clock} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 self-start text-xs">
            <Stat label="Observations" value={String(record.points.length)} />
            <Stat label="Tracks" value={record.trackIds.join(', ') || '—'} />
            <Stat
              label="Detector confidence"
              /* ⛔ Named as the DETECTOR's, and never presented as the primitive's. A primitive met a
                 published threshold or it did not; there is no probability to report for one. */
              value={
                confidence === null
                  ? '—'
                  : `${(confidence.mean * 100).toFixed(0)}% mean (${(confidence.min * 100).toFixed(0)}–${(confidence.max * 100).toFixed(0)}%)`
              }
            />
            <Stat
              label="Zone membership"
              value={
                zones.unsettledPoints === 0
                  ? `${String(zones.settledPoints)} settled observation(s)`
                  : /* ⛔ Undecided is not "outside". Collapsing them ends a visit that never ended. */
                    `${String(zones.settledPoints)} settled · ${String(zones.unsettledPoints)} never decided`
              }
            />
            <Stat
              label="Zones entered"
              value={
                zones.zones.length === 0
                  ? zones.settledPoints === 0
                    ? 'nothing ever resolved membership for this subject'
                    : 'none'
                  : zones.zones.map((z) => `${z.zoneId} (${String(z.observations)})`).join(', ')
              }
            />
            <Stat
              label="Zone geometry version"
              /* ⭐ ADR-0053: which polygon set decided this, so a correction is visible. */
              value={record.zoneVersion === undefined ? 'not recorded' : `v${String(record.zoneVersion)}`}
            />
          </dl>
        </div>
      )}

      {/* --- what they did ---------------------------------------------------------------- */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold">Behaviour summary</h4>
        {facts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No behaviour fact in the current timeline read names this subject. ⚠️ If the timeline is
            filtered by kind, this counts only the kinds asked for.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1" data-testid="identity-facts">
            {facts.map((fact) => (
              <Badge key={fact.kind} variant="brand">
                {timelineKindLabel(fact.kind)} × {fact.count}
                {fact.seconds === undefined ? '' : ` · ${fact.seconds.toFixed(1)} s`}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* --- what was raised -------------------------------------------------------------- */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold">Associated incidents</h4>
        {analysisTimeline === undefined ? (
          <p className="text-xs text-muted-foreground">
            The analysis timeline has not been read, so incidents cannot be attributed.
          </p>
        ) : incidents.attributed.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No incident this run raised resolves to one of this subject's tracks.
            {incidents.unattributable > 0
              ? ` ⚠️ ${String(incidents.unattributable)} incident(s) recorded no triggering track at all, so they could not be attributed to anyone — they are not evidence that this subject caused nothing.`
              : ''}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>At</TableHead>
                <TableHead>Incident</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Seek</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.attributed.map((incident) => (
                <TableRow key={incident.incidentId} data-testid="identity-incident">
                  <TableCell className="tabular">{formatOffset(incident.offsetSeconds)}</TableCell>
                  <TableCell>{incident.title}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {incident.ruleName ?? incident.ruleId ?? '—'}
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => onSeek(incident.offsetSeconds)}>
                      {formatOffset(incident.offsetSeconds)}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

/**
 * The travelled path in the camera's normalised frame.
 *
 * ⚠️ Inline SVG and no charting library — a polyline over N points does not justify a dependency,
 * and the console's bundle budget was won back by removing exactly this kind of import.
 *
 * ⚠️ **Bounded.** A long run holds thousands of points; drawing every one produces a path element no
 * browser lays out quickly and no eye can read. Every Nth point is drawn and the sampling is stated,
 * because a *simplified* path and a *sparse* observation record look identical on screen.
 */
const MAX_PATH_POINTS = 400;

function Trajectory({
  record,
  clock,
  onSeek,
}: {
  record: { points: TrackHistoryPointView[] };
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
}) {
  const stride = Math.max(1, Math.ceil(record.points.length / MAX_PATH_POINTS));
  const sampled = record.points.filter((_, i) => i % stride === 0);
  const points = sampled.map((p) => centreOf(p.bbox));

  const width = 480;
  const height = 270;
  const toX = (x: number) => Math.min(Math.max(x, 0), 1) * width;
  const toY = (y: number) => Math.min(Math.max(y, 0), 1) * height;

  if (points.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        Not enough observations to draw a path. A trajectory needs at least two.
      </p>
    );
  }

  const path = points.map((p) => `${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`).join(' ');
  const first = sampled[0]!;
  const last = sampled[sampled.length - 1]!;

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="w-full rounded-sm border border-border bg-surface-2"
        role="img"
        aria-label={`Path across ${String(points.length)} observations, in the camera's normalised frame.`}
        data-testid="identity-trajectory"
      >
        <polyline points={path} className="fill-none stroke-brand" strokeWidth={2} />
        {/*
          ⭐ **Every drawn observation is a seek.** The path is where somebody went; the question an
          investigator asks of it is "what does that look like", and the only answer is the frame.
        */}
        {sampled.map((point, index) => {
          const centre = points[index]!;
          const placed = placeInRecording(historyPointSeconds(point.at), clock);
          return (
            <circle
              key={`${String(point.frameIndex)}-${String(index)}`}
              cx={toX(centre[0])}
              cy={toY(centre[1])}
              r={4}
              className={
                placed.offsetSeconds === null
                  ? 'fill-transparent'
                  : 'cursor-pointer fill-transparent hover:fill-brand/40'
              }
              data-testid="trajectory-point"
              data-frame={point.frameIndex}
              onClick={() => {
                if (placed.offsetSeconds !== null) onSeek(placed.offsetSeconds);
              }}
            >
              <title>{`frame ${String(point.frameIndex)}`}</title>
            </circle>
          );
        })}
        <circle cx={toX(points[0]![0])} cy={toY(points[0]![1])} r={5} className="fill-success" />
        <circle
          cx={toX(points[points.length - 1]![0])}
          cy={toY(points[points.length - 1]![1])}
          r={5}
          className="fill-critical"
        />
      </svg>
      <figcaption className="space-y-1 text-2xs text-muted-foreground">
        <span className="block">
          Green is the first observation, red the last. ⚠️ Normalised image coordinates, not metres —
          converting needs camera calibration this platform does not have.
        </span>
        {stride > 1 ? (
          <span className="block">
            {/* ⚠️ A simplified path and a sparse observation record look identical on screen. */}
            Every {stride}
            {ordinal(stride)} observation is drawn ({points.length} of {record.points.length}), so the
            line is simplified rather than sparse.
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-2">
          <SeekControl
            footageSeconds={historyPointSeconds(first.at) ?? undefined}
            clock={clock}
            onSeek={onSeek}
            size="xs"
            label={`first · frame ${String(first.frameIndex)}`}
          />
          <SeekControl
            footageSeconds={historyPointSeconds(last.at) ?? undefined}
            clock={clock}
            onSeek={onSeek}
            size="xs"
            label={`last · frame ${String(last.frameIndex)}`}
          />
        </span>
      </figcaption>
    </figure>
  );
}

function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return 'st';
  if (n % 10 === 2 && n % 100 !== 12) return 'nd';
  if (n % 10 === 3 && n % 100 !== 13) return 'rd';
  return 'th';
}
