import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Camera, MonitorPlay, Play } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageHeader,
  QueryBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from '@/ui';
import { formatTimestamp } from '@/lib/format';
import {
  useInvestigation,
  useSnapshot,
  useStartRun,
  useTimeline,
} from './useInvestigations';

/** Terminal session states — a run in one of these will never change again. */
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];

/**
 * One investigation: its runs, the timeline of the selected run, and the incidents it raised.
 *
 * ⭐ **A run is selected explicitly and never merged.** Two runs of one recording are two answers,
 * possibly under different rules or a different model; overlaying them would show a picture
 * describing no run that ever happened.
 */
export function InvestigationDetailPage() {
  const { id = '' } = useParams();
  const detail = useInvestigation(id);
  const startRun = useStartRun(id);
  const snapshot = useSnapshot(id);
  const [sessionId, setSessionId] = useState<string | undefined>();

  const sessions = detail.data?.sessions ?? [];
  const selected = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const ready = selected !== undefined && TERMINAL.includes(selected.state);
  const timeline = useTimeline(id, selected?.id, ready);

  return (
    <div className="space-y-6">
      <PageHeader
        title={detail.data?.analysis.label ?? 'Investigation'}
        {...(detail.data === undefined
          ? {}
          : {
              description: `${detail.data.analysis.cameraName ?? detail.data.analysis.cameraId} · footage from ${formatTimestamp(detail.data.analysis.footageStartedAt)}`,
            })}
        actions={
          <div className="flex gap-2">
            {/*
              ⭐ **Demonstration Mode** (slice 9) — and it is one parameter, not a second pipeline.
              `speed: 1` paces the recording to real time, so it plays through the *live* runtime,
              tracker, rules and event path at the rate a camera would produce it. What an audience
              watches is the production pipeline, not a simulation of it.

              ⚠️ The parity run is what lets this be offered at all: 1× and 8× were measured to
              produce byte-identical event streams, identical track identities and identical
              confidences. A demonstration therefore shows exactly what an investigation would find.
            */}
            <Button
              variant="outline"
              onClick={() => startRun.mutate({ speed: 1 })}
              disabled={startRun.isPending || detail.data?.analysis.state !== 'ready'}
              title="Plays the recording through the live pipeline at real time"
            >
              <MonitorPlay className="mr-2 h-4 w-4" />
              Demonstrate at real time
            </Button>
            <Button
              onClick={() => startRun.mutate({})}
              disabled={startRun.isPending || detail.data?.analysis.state !== 'ready'}
              title="Analyses as fast as the runtime allows"
            >
              <Play className="mr-2 h-4 w-4" />
              Run analysis
            </Button>
          </div>
        }
      />

      {/* --- runs ------------------------------------------------------------------------- */}
      <QueryBoundary
        isLoading={detail.isPending}
        isError={detail.isError}
        error={detail.error}
        isEmpty={sessions.length === 0}
        skeleton={<TableSkeleton rows={3} />}
        emptyState={
          <EmptyState
            icon={Play}
            title="This recording has not been analysed yet"
            description="Run the analysis to push it through the same runtime, tracking and rules your live cameras use."
          />
        }
      >
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Runs</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>State</TableHead>
                {/*
                  ⛔ **Seven cells, and for one release only six headers.** The row below has always
                  rendered pacing AND measured speed as separate cells; the header row named only
                  one of them, so every column from here rightwards was captioned by its
                  left-hand neighbour's title — "Detections" sat over the frame count and the model
                  id had no header at all. Nothing failed: HTML lays out a row with more cells than
                  headers without complaint, and the assertions on this page all matched text rather
                  than the column it appeared under. A customer reading their first real analysis
                  found it in seconds. `table-arity.test.ts` now counts these against the row.
                */}
                <TableHead>Pacing</TableHead>
                <TableHead>Speed</TableHead>
                <TableHead>Frames</TableHead>
                <TableHead>Detections</TableHead>
                <TableHead>Model</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow
                  key={s.id}
                  className={s.id === selected?.id ? 'bg-muted/50' : 'cursor-pointer'}
                  onClick={() => setSessionId(s.id)}
                >
                  <TableCell>#{s.sequence}</TableCell>
                  <TableCell>{s.state}</TableCell>
                  {/*
                    ⚠️ What was ASKED for, beside what was MEASURED in the next column. A demo that
                    could not keep up shows "real time" here and less than 1.0× there — which is the
                    honest reading, and the reason both are on screen.
                  */}
                  <TableCell>{s.speed === null ? 'As fast as possible' : `${s.speed}× real time`}</TableCell>
                  <TableCell>
                    {/*
                      ⚠️ `null` is rendered as "—", never as 0. A queued run has not been slow; it
                      has not been measured, and "0×" on screen reads as "stalled".
                    */}
                    {s.progress.speedFactor === null
                      ? '—'
                      : `${s.progress.speedFactor.toFixed(1)}× real time`}
                  </TableCell>
                  <TableCell>
                    {s.counts.framesAnalysed} / {s.counts.framesDecoded}
                  </TableCell>
                  <TableCell>{s.counts.detections}</TableCell>
                  <TableCell>{s.provenance.modelId ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/*
            ⛔ Findings are shown next to the run that produced them, not tucked away. A run that
            examined nothing must not be read as a run that found nothing.
          */}
          {(selected?.findings.length ?? 0) > 0 ? (
            <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              {selected?.findings.map((f, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>{f.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </QueryBoundary>

      {/* --- timeline -------------------------------------------------------------------- */}
      {ready ? (
        <QueryBoundary
          isLoading={timeline.isPending}
          isError={timeline.isError}
          error={timeline.error}
          isEmpty={(timeline.data?.entries.length ?? 0) === 0}
          skeleton={<TableSkeleton rows={4} />}
          emptyState={
            <EmptyState
              icon={Camera}
              title="Nothing was detected in this recording"
              description="The run completed and the pipeline found nothing to report."
            />
          }
        >
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Timeline</h2>
              {timeline.data?.truncated === true ? (
                /* ⛔ A partial timeline says so. "The first 2 000 events" is not "the events". */
                <span className="text-xs text-amber-500">
                  Showing the first {timeline.data.entries.length} events of a longer run.
                </span>
              ) : null}
            </div>

            {/* Incidents — the lane an investigator reads first. */}
            {timeline.data?.incidentsAvailable === false ? (
              /*
                ⚠️ The fourth state, not an empty list. "We could not look" and "we looked and found
                none" are opposite answers to the customer's question.
              */
              <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                Incidents could not be looked up for this run.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>At</TableHead>
                    <TableHead>Incident</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(timeline.data?.incidents ?? []).map((i) => (
                    <TableRow key={i.incidentId}>
                      {/* ⭐ Position in the FOOTAGE, which is what an operator scrubs to. */}
                      <TableCell>{formatOffset(i.offsetSeconds)}</TableCell>
                      <TableCell>{i.title}</TableCell>
                      <TableCell>{i.status}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={snapshot.isPending}
                          onClick={() =>
                            snapshot.mutate({
                              offsetSeconds: i.offsetSeconds,
                              incidentId: i.incidentId,
                            })
                          }
                        >
                          Capture still
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {snapshot.data !== undefined ? (
              <figure className="space-y-1">
                <img
                  src={snapshot.data.url}
                  alt={`Frame at ${formatOffset(snapshot.data.offsetSeconds)} of the recording`}
                  className="max-w-full rounded-md border border-border"
                />
                <figcaption className="text-xs text-muted-foreground">
                  {/* ⭐ What the still is a picture OF — footage time, not when it was taken. */}
                  {formatOffset(snapshot.data.offsetSeconds)} into the recording ·{' '}
                  {formatTimestamp(snapshot.data.occurredAt)}
                </figcaption>
              </figure>
            ) : null}
          </section>
        </QueryBoundary>
      ) : null}
    </div>
  );
}

/** `mm:ss` from the start of the recording — the number a scrubber and an evidence clip both use. */
export function formatOffset(seconds: number): string {
  const whole = Math.floor(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
