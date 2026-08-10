import { useCallback, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, Camera, Loader2, MonitorPlay, Play } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageHeader,
  Progress,
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
  useCancelRun,
  useInvestigation,
  usePlayback,
  useSnapshot,
  useStartRun,
  useTimeline,
} from './useInvestigations';
import { AnalysisPlayer } from './AnalysisPlayer';
import { AnalysisDetailsPanel } from './AnalysisDetailsPanel';
import { TimelineLanes } from './TimelineLanes';
import { ExportReportButton } from './ExportReportButton';
import { formatOffset } from './format';
import { BehaviourPanel } from '../behaviour/BehaviourPanel';

/** Terminal session states — a run in one of these will never change again. */
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];

/**
 * One investigation: the recording, its runs, and every lane the timeline computes (P-8.6).
 *
 * ⭐ **A run is selected explicitly and never merged.** Two runs of one recording are two answers,
 * possibly under different rules or a different model; overlaying them would show a picture
 * describing no run that ever happened.
 *
 * ⚠️ **This page shows STORED data, and its job is to be clear about the difference between "not
 * detected" and "not kept."** The measured funnel on a real recording is 67 frames → 285 detections
 * → 24 events → 10 tracks → 4 incidents; the lanes and the player each carry that caveat where it
 * would otherwise mislead.
 */
export function InvestigationDetailPage() {
  const { id = '' } = useParams();
  const detail = useInvestigation(id);
  const startRun = useStartRun(id);
  const cancelRun = useCancelRun(id);
  const snapshot = useSnapshot(id);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [focusTrack, setFocusTrack] = useState<string | undefined>();

  const sessions = detail.data?.sessions ?? [];
  const selected = sessions.find((s) => s.id === sessionId) ?? sessions[0];
  const ready = selected !== undefined && TERMINAL.includes(selected.state);
  const timeline = useTimeline(id, selected?.id, ready);
  const analysis = detail.data?.analysis;
  const playback = usePlayback(id, analysis?.state === 'ready');

  /*
   * ⚠️ A nonce rather than a bare number: seeking to the offset you are already at must still move
   * the playhead, and an effect keyed on the value alone would not fire for a repeat click.
   */
  /*
   * ⚠️ Which of the two actions is in flight, from the mutation's own input. `speed: 1` is the
   * real-time demonstration; anything else is the fast analysis. See the buttons for why this
   * matters rather than reusing `isPending` for both.
   */
  const demonstrating = startRun.isPending && startRun.variables?.speed === 1;
  const analysing = startRun.isPending && !demonstrating;

  const nonce = useRef(0);
  const [seekTo, setSeekTo] = useState<{ offsetSeconds: number; nonce: number }>();
  const seek = useCallback((offsetSeconds: number) => {
    nonce.current += 1;
    setSeekTo({ offsetSeconds, nonce: nonce.current });
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title={analysis?.label ?? 'Investigation'}
        {...(detail.data === undefined
          ? {}
          : {
              description: `${detail.data.analysis.cameraName ?? detail.data.analysis.cameraId} · footage from ${formatTimestamp(detail.data.analysis.footageStartedAt)}`,
            })}
        actions={
          <div className="flex flex-wrap gap-2">
            {/* ⭐ P-8.6: the export endpoint has existed since slice 7 with no way to reach it. */}
            <ExportReportButton
              analysisId={id}
              sessionId={selected?.id}
              label={analysis?.label}
              disabled={!ready}
            />
            {/*
              ⭐ **Demonstration Mode** (slice 9) — and it is one parameter, not a second pipeline.
              `speed: 1` paces the recording to real time, so it plays through the *live* runtime,
              tracker, rules and event path at the rate a camera would produce it.
            */}
            {/*
              ⭐ **Both buttons say they are working.** Starting a run is a round trip that claims a
              worker slot, and on a busy host it is not instant; a button that only greys out is
              indistinguishable from one that did nothing, so an operator clicks again. The spinner
              and the changed label are what stop a second run being queued by accident.
            */}
            <Button
              variant="outline"
              onClick={() => startRun.mutate({ speed: 1 })}
              disabled={startRun.isPending || analysis?.state !== 'ready'}
              title="Plays the recording through the live pipeline at real time"
            >
              {/*
                ⚠️ **Only the button that was clicked says "Starting…".** Both disable — a run claims
                one worker slot and the second request would be refused — but labelling both would
                tell an operator who asked for a fast analysis that a real-time demonstration is
                starting, which is a different thing that takes as long as the recording.
              */}
              {demonstrating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <MonitorPlay className="mr-2 h-4 w-4" aria-hidden />
              )}
              {demonstrating ? 'Starting…' : 'Demonstrate at real time'}
            </Button>
            <Button
              onClick={() => startRun.mutate({})}
              disabled={startRun.isPending || analysis?.state !== 'ready'}
              title="Analyses as fast as the runtime allows"
            >
              {analysing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Play className="mr-2 h-4 w-4" aria-hidden />
              )}
              {analysing ? 'Starting…' : 'Run analysis'}
            </Button>
          </div>
        }
      />

      {/* --- the recording itself --------------------------------------------------------- */}
      {analysis === undefined ? null : (
        <AnalysisPlayer
          url={playback.data?.url}
          contentType={playback.data?.contentType}
          playbackWarning={playback.data?.playbackWarning}
          entries={timeline.data?.entries ?? []}
          analysisFrameRate={selected?.analysisFrameRate ?? 2}
          width={analysis.asset?.width}
          height={analysis.asset?.height}
          seekTo={seekTo}
          focusTrack={focusTrack}
        />
      )}

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
                <TableHead />
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
                  <TableCell>
                    <div className="space-y-1">
                      <span className="flex items-center gap-1.5">
                        {TERMINAL.includes(s.state) ? null : (
                          <Loader2 className="h-3 w-3 animate-spin text-brand" aria-hidden />
                        )}
                        {s.state}
                      </span>
                      {/*
                        ⭐ **How far through the FOOTAGE the run is** — `mediaOffsetSeconds` against
                        the recording's duration. Both numbers have always been carried and neither
                        reached a screen, so a four-hour analysis showed "running" and nothing else
                        for the whole of it.

                        ⛔ Indeterminate when the container declared no duration: a bar computed
                        against an unknown total would be a fabricated percentage (ADR-0039).
                      */}
                      {TERMINAL.includes(s.state) ? null : (
                        <Progress
                          value={runFraction(s.progress.mediaOffsetSeconds, analysis?.asset?.durationSeconds)}
                          label={`Run #${String(s.sequence)} progress`}
                        />
                      )}
                    </div>
                  </TableCell>
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
                  <TableCell>
                    {/*
                      ⛔ **A wedged run blocks the whole analysis, and this is the only way out.**
                      `start` refuses while a session is non-terminal — "already retrying for this
                      analysis — cancel it before starting another" — so before this button an
                      operator whose run stuck had no route forward inside the product at all. The
                      endpoint has existed since slice 3; nothing called it.
                    */}
                    {TERMINAL.includes(s.state) ? null : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancelRun.isPending}
                        onClick={(e) => {
                          /* ⚠️ The row itself selects a run; cancelling must not also re-select. */
                          e.stopPropagation();
                          cancelRun.mutate(s.id);
                        }}
                      >
                        {cancelRun.isPending ? 'Cancelling…' : 'Cancel'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/*
            ⛔ Findings are shown next to the run that produced them, not tucked away. A run that
            examined nothing must not be read as a run that found nothing.
          */}
          {/*
            ⛔ **The run's own error, which no screen has ever shown.** The session carries `error`
            — e.g. "ffmpeg exited with code 234 while decoding …" — and this page rendered only
            `findings`. A run stuck in `retrying` therefore presented as an unexplained spinner
            while the reason sat one field away in the payload it had already fetched. Reported by
            the Architect, 2026-08-08.

            ⚠️ Amber while the run may still recover, red once it cannot. The same sentence means
            "this is being retried" and "this is why it stopped" depending only on the state.
          */}
          {selected?.error === undefined ? null : (
            <p
              className={
                TERMINAL.includes(selected.state)
                  ? 'rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'
                  : 'rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-500'
              }
              role="alert"
              data-testid="run-error"
            >
              {selected.error}
            </p>
          )}

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

      {/* --- what the run was, in full ---------------------------------------------------- */}
      {analysis === undefined ? null : (
        <AnalysisDetailsPanel analysis={analysis} session={selected} />
      )}

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
          {timeline.data === undefined ? null : (
            <TimelineLanes
              timeline={timeline.data}
              session={selected}
              onSeek={seek}
              onCaptureStill={(offsetSeconds, incidentId) =>
                snapshot.mutate(
                  incidentId === undefined ? { offsetSeconds } : { offsetSeconds, incidentId },
                )
              }
              captureDisabled={snapshot.isPending}
              focusTrack={focusTrack}
              onFocusTrack={setFocusTrack}
            />
          )}

          {snapshot.data !== undefined ? (
            <figure className="space-y-1">
              <img
                src={snapshot.data.url}
                alt={`Frame at ${formatOffset(snapshot.data.offsetSeconds)} of the recording`}
                className="max-w-full rounded-md border border-border"
              />
              <figcaption className="space-y-0.5 text-xs text-muted-foreground">
                {/* ⭐ What the still is a picture OF — footage time, not when it was taken. */}
                <span>
                  {formatOffset(snapshot.data.offsetSeconds)} into the recording ·{' '}
                  {formatTimestamp(snapshot.data.occurredAt)}
                </span>
                {/*
                  ⭐ "Which frame generated this evidence?" — the still names its own offset, its
                  size, and ⛔ whether it is under evidence custody. `registeredAsEvidence: false`
                  means it will not survive retention (TD-15), and a customer must not learn that
                  from a support ticket.
                */}
                <span className="block text-2xs">
                  {snapshot.data.width} × {snapshot.data.height} ·{' '}
                  {snapshot.data.registeredAsEvidence
                    ? 'under evidence custody'
                    : '⚠️ not registered as evidence — no retention or chain of custody (TD-15)'}
                </span>
                <Button size="sm" variant="ghost" onClick={() => seek(snapshot.data.offsetSeconds)}>
                  Play from here
                </Button>
              </figcaption>
            </figure>
          ) : null}
        </QueryBoundary>
      ) : null}

      {/*
        --- behaviour ---------------------------------------------------------------------------
        ⭐ **Slice 2.8.** Everything above describes what was *detected*; this describes what was
        *done* — the primitives, the graph they assemble into, one subject's history, the thresholds
        every business word was computed at, and rules over the whole of it with a WHY chain.

        ⚠️ It reads the same run the lanes above do, and every seek lands on the same player. Two
        surfaces of one recording that disagreed about where a moment is would be worse than one.

        ⛔ **`selected.id`, not `id`.** Track history is keyed by the analysis SESSION (`ases_…`)
        because ADR-0047 makes two runs of one recording two independent answers; passing the
        analysis id would return nothing at all, which is indistinguishable from a quiet run.
      */}
      <BehaviourPanel
        streamId={selected?.id}
        analysisTimeline={timeline.data}
        durationSeconds={analysis?.asset?.durationSeconds}
        onSeek={seek}
        enabled={ready}
      />
    </div>
  );
}

/**
 * How far through the recording a run has read, or `null` when that cannot be known.
 *
 * ⛔ **`null` rather than 0 when the duration is unknown** (ADR-0039). A container that declared no
 * duration makes the denominator unavailable, not zero — and a bar parked at the left edge reads as
 * "stuck", which is a different and much more alarming claim than "running, distance unknown".
 */
export function runFraction(
  mediaOffsetSeconds: number | null | undefined,
  durationSeconds: number | undefined,
): number | null {
  if (durationSeconds === undefined || durationSeconds <= 0) return null;
  if (mediaOffsetSeconds === null || mediaOffsetSeconds === undefined) return null;
  return Math.min(1, Math.max(0, mediaOffsetSeconds / durationSeconds));
}
