import { useMemo, useState } from 'react';
import type { LiveDwellTimer } from '@vip/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
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
  QueryBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui';
import { useLiveTracks } from '@/features/tracking/useTracking';
import { useZones } from './useLoitering';
import { ZoneCanvas } from './ZoneCanvas';
import { useDryRunSummaries, useLiveRuleStatus } from './useLoitering';

/**
 * **Live Rule Status** (P-8 Phase 7 §Operator UI; Architect recs 3 + 6).
 *
 * What the rule engine is doing **right now**: which rules are enabled, which zones they watch, how
 * fast events are arriving, and — the part nothing else in the platform can show — the dwell clocks
 * that are currently running.
 *
 * ### ⚠️ Every figure on this page is one node's
 *
 * A deployment running several rule processes gets whichever answered, and the node's name is
 * rendered beside the numbers. Summing across replicas would produce a figure that is wrong in a way
 * nobody could detect, which is why the contract carries `node` at all.
 *
 * ### ⚠️ A rate of `null` is rendered as "measuring…", never as zero
 *
 * ADR-0039. A node that started four seconds ago has not measured a rate; `0.0/s` would be
 * indistinguishable from a quiet estate, and only one of those is worth investigating. The same rule
 * applies to the `503` this page gets from a node that does not run the engine: it says so, rather
 * than rendering an empty dashboard that looks like a working one with nothing happening.
 */

/** How full the bar is. ⚠️ Capped at 1 — a subject past the threshold is full, not overflowing. */
function progress(timer: LiveDwellTimer): number {
  if (timer.thresholdSeconds <= 0) return 1;
  return Math.min(1, timer.elapsedSeconds / timer.thresholdSeconds);
}

function rate(value: number | null): string {
  /* ⚠️ "measuring…" rather than "0.0/s" — see the header. */
  return value === null ? 'measuring…' : `${value.toFixed(1)}/s`;
}

const STATE_VARIANT = {
  accumulating: 'neutral',
  met: 'critical',
  'cooling-down': 'warning',
} as const;

export function LiveRuleStatusPage() {
  const canRead = usePermission('rule:read');
  const status = useLiveRuleStatus();
  const dryRuns = useDryRunSummaries();
  const [cameraId, setCameraId] = useState<string>('');
  const zones = useZones(cameraId === '' ? undefined : cameraId);
  const tracks = useLiveTracks(cameraId === '' ? {} : { cameraId });

  const timers = status.data?.timers ?? [];
  /** Subjects with a running clock, so the canvas can mark them. */
  const dwelling = useMemo(() => new Set(timers.map((t) => t.subject)), [timers]);
  const watchedZones = useMemo(
    () => timers.map((t) => t.zoneId).filter((z): z is string => z !== undefined),
    [timers],
  );

  if (!canRead) {
    return (
      <Alert variant="warning" title="Not permitted">
        You do not have permission to view rule status.
      </Alert>
    );
  }

  /*
   * ⚠️ A 503 is a deployment SHAPE, not a failure. It means this node does not run the engine, and
   * saying that is far more useful than a red error box that invites somebody to restart something.
   */
  const notEvaluating =
    status.isError && status.error instanceof ApiRequestError && status.error.status === 503;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Live Rule Status"
        description="What the rule engine is doing right now, on the node that answered. Dwell clocks update every two seconds."
      />

      {notEvaluating ? (
        <Alert variant="info" title="This node does not evaluate rules">
          The rules service answered, but it is not running an engine — so it has no live status to
          report. This is a valid deployment shape (authoring and evaluation split across
          processes), not an outage.
        </Alert>
      ) : (
        <QueryBoundary
          isLoading={status.isLoading}
          isError={status.isError}
          error={status.error}
          skeleton={<div className="h-32 animate-pulse rounded bg-surface-3" />}
        >
          {status.data === undefined ? null : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Active rules" value={String(status.data.activeRules)}>
                  {status.data.dwellRules} with a dwell threshold
                  {status.data.dryRunRules > 0 ? ` · ${status.data.dryRunRules} in dry run` : ''}
                </Stat>
                <Stat label="Active zones" value={String(status.data.activeZones)}>
                  zones named by an enabled rule
                </Stat>
                <Stat label="Evaluations" value={rate(status.data.evaluationsPerSecond)}>
                  events {rate(status.data.eventsPerSecond)} · candidates{' '}
                  {rate(status.data.candidatesPerSecond)}
                </Stat>
                <Stat label="Dwell clocks" value={String(status.data.activeDwellTimers)}>
                  {status.data.dwellStateEntries} visits held of {status.data.dwellStateCapacity}
                </Stat>
              </div>

              {/*
               * ⚠️ Surfaced on the page, not only in Prometheus. A non-zero count here means a dwell
               * rule is receiving events it can never accumulate — the rule looks enabled and healthy
               * and will never fire. It is the ONE number that distinguishes "nothing is happening"
               * from "this is broken", and those are otherwise identical on this page.
               */}
              {status.data.dwellWithoutIdentity > 0 ? (
                <Alert variant="warning" title="Events are arriving without an identity">
                  {status.data.dwellWithoutIdentity} dwell evaluations were skipped because the
                  event carried neither an identity nor a track id. A dwell rule cannot accumulate
                  against those, so it will never fire for them — check that tracking is running on
                  the cameras these rules cover.
                </Alert>
              ) : null}

              {status.data.dwellStateEvicted > 0 ? (
                <Alert variant="critical" title="Dwell state is being evicted">
                  {status.data.dwellStateEvicted} visits were dropped because the store reached its
                  capacity of {status.data.dwellStateCapacity}. Those subjects' rules will not fire.
                </Alert>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle>Running dwell clocks</CardTitle>
                  <CardDescription>
                    Closest to firing first. Reported by node {status.data.node}, up{' '}
                    {Math.round(status.data.uptimeSeconds)}s.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {timers.length === 0 ? (
                    <EmptyState
                      title="No clocks running"
                      description="Nobody is currently being timed in a monitored zone. This is a live gauge — zero is a legitimate reading on a quiet site."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Subject</TableHead>
                          <TableHead>Zone</TableHead>
                          <TableHead>Dwell</TableHead>
                          <TableHead>Threshold</TableHead>
                          <TableHead>State</TableHead>
                          <TableHead>Observed</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {timers.map((timer) => (
                          <TableRow key={`${timer.ruleId}:${timer.subject}:${timer.zoneId ?? '-'}`}>
                            <TableCell>
                              <span className="font-mono text-xs">{timer.subject}</span>
                              <span className="ml-2 text-xs text-fg-muted">
                                by {timer.subjectKind}
                              </span>
                            </TableCell>
                            <TableCell>{timer.zoneName ?? timer.zoneId ?? 'whole frame'}</TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 w-24 overflow-hidden rounded bg-surface-3">
                                  <div
                                    className={
                                      timer.state === 'accumulating'
                                        ? 'h-full bg-brand'
                                        : 'h-full bg-critical'
                                    }
                                    style={{ width: `${progress(timer) * 100}%` }}
                                  />
                                </div>
                                <span className="tabular-nums">
                                  {timer.elapsedSeconds.toFixed(1)}s
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="tabular-nums">
                              {timer.thresholdSeconds}s
                            </TableCell>
                            <TableCell>
                              <Badge variant={STATE_VARIANT[timer.state]}>
                                {timer.state === 'cooling-down' &&
                                timer.cooldownRemainingSeconds !== null
                                  ? `cooling ${Math.round(timer.cooldownRemainingSeconds)}s`
                                  : timer.state}
                              </Badge>
                              {timer.dryRun ? (
                                <Badge variant="outline" className="ml-1">
                                  dry run
                                </Badge>
                              ) : null}
                            </TableCell>
                            {/*
                             * ⚠️ The two honesty fields, on the live view as well as on the candidate.
                             * An operator watching a bar fill needs to know whether the duration is
                             * being assembled from a continuous observation or across a gap.
                             */}
                            <TableCell className="text-xs text-fg-muted">
                              {timer.observations} obs
                              {timer.trackFragments > 1
                                ? ` · ${timer.trackFragments} fragments`
                                : ''}
                              {timer.longestGapSeconds >= 1
                                ? ` · gap ${timer.longestGapSeconds.toFixed(1)}s`
                                : ''}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </QueryBoundary>
      )}

      {/*
       * The visual half (Architect rec 7): zones drawn over the live subjects, with the ones being
       * timed picked out. Choosing a camera is deliberate — a tenant-wide track feed on a status page
       * would poll every camera in the estate to draw one.
       */}
      <Card>
        <CardHeader>
          <CardTitle>Zone view</CardTitle>
          <CardDescription>
            Live subjects over their camera's zones. A highlighted subject has a dwell clock
            running.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <select
            aria-label="Zone view camera"
            className="focus-ring h-9 w-full max-w-sm rounded-md border border-input bg-surface-1 px-3 text-sm"
            value={cameraId}
            onChange={(event) => setCameraId(event.target.value)}
          >
            <option value="">Select a camera…</option>
            {[
              ...new Set(timers.map((t) => t.cameraId).filter((c): c is string => c !== undefined)),
            ].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
            {(tracks.data?.tracks ?? []).length === 0 && cameraId !== '' ? null : null}
          </select>
          {cameraId === '' ? (
            <EmptyState
              title="No camera selected"
              description="Pick a camera to see its zones drawn over the subjects currently being tracked."
            />
          ) : (
            <ZoneCanvas
              zones={zones.data ?? []}
              tracks={tracks.data?.tracks ?? []}
              highlight={watchedZones}
              dwelling={dwelling}
              label={`Live zone view for ${cameraId}`}
            />
          )}
        </CardContent>
      </Card>

      {(dryRuns.data ?? []).length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Dry runs</CardTitle>
            <CardDescription>
              Candidates these rules built and deliberately did not publish. ⚠️ Since this node
              started — they are not stored.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rule</TableHead>
                  <TableHead>Withheld</TableHead>
                  <TableHead>Longest dwell</TableHead>
                  <TableHead>Last</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(dryRuns.data ?? []).map((row) => (
                  <TableRow key={row.ruleId}>
                    <TableCell>{row.ruleName}</TableCell>
                    <TableCell className="tabular-nums">{row.withheld}</TableCell>
                    <TableCell className="tabular-nums">
                      {row.maxDurationSeconds === undefined
                        ? '—'
                        : `${Math.round(row.maxDurationSeconds)}s`}
                    </TableCell>
                    <TableCell>{row.lastAt ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {children === undefined ? null : <p className="mt-1 text-xs text-fg-muted">{children}</p>}
      </CardContent>
    </Card>
  );
}
