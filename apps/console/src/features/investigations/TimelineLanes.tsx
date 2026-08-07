/**
 * All four lanes the timeline API has always computed (P-8.6, priorities 3 and 7).
 *
 * ⛔ **Before this, one of four was rendered.** `entries`, `tracks` and `density` were computed on
 * every request and displayed nowhere — recorded as V-7 / TD-69, and the largest gap the P-8.5 audit
 * found between what the platform knows and what a customer can see.
 *
 * ⚠️ **The lanes do not all count the same thing, and the UI has to say so.** From one measured run:
 * 67 frames analysed → **285 detections** → **24 events** → **10 tracks** → **4 incidents**. The
 * 285 → 24 step is the events service's dedup window ([L-57]): one event survives per track per ten
 * seconds. So `density` is a histogram of *persisted events*, never of detections, and a lane
 * labelled "detections" would overstate the platform's memory by roughly twelve to one.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Crosshair, Loader2, Play } from 'lucide-react';
import type { AnalysisTimeline, VideoAnalysisDetail } from '@vip/contracts';
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/ui';
import { formatOffset } from './format';
import { shortTrack } from './overlay';

export interface TimelineLanesProps {
  timeline: AnalysisTimeline;
  session: VideoAnalysisDetail['sessions'][number] | undefined;
  onSeek: (offsetSeconds: number) => void;
  onCaptureStill: (offsetSeconds: number, incidentId?: string) => void;
  captureDisabled: boolean;
  focusTrack: string | undefined;
  onFocusTrack: (trackId: string | undefined) => void;
}

export function TimelineLanes({
  timeline,
  session,
  onSeek,
  onCaptureStill,
  captureDisabled,
  focusTrack,
  onFocusTrack,
}: TimelineLanesProps) {
  const [tab, setTab] = useState('incidents');

  /**
   * ⭐ **The recorded link, not a guess.** `triggeredByEventId` is stored on every incident; before
   * P-8.6 the only way to answer "which event became this incident?" was to match on the footage
   * instant, which is right by coincidence rather than by record.
   */
  const triggeringEvents = useMemo(
    () => new Set(timeline.incidents.map((i) => i.triggeredByEventId).filter(isString)),
    [timeline.incidents],
  );

  const entries = useMemo(
    () =>
      focusTrack === undefined
        ? timeline.entries
        : timeline.entries.filter((e) => e.trackId === focusTrack),
    [timeline.entries, focusTrack],
  );

  const detections = session?.counts.detections ?? null;

  return (
    <section className="space-y-3" data-testid="timeline-lanes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Timeline</h2>
        {timeline.truncated ? (
          <span className="text-xs text-amber-500">
            Showing the first {timeline.entries.length} events of a longer run.
          </span>
        ) : null}
      </div>

      {/*
        ⛔ **The funnel, stated once, at the top.** "How many people were visible?" and "which
        detections became events?" are two of the seven questions this milestone exists to answer,
        and both are answered wrongly by any single number on this page taken alone.
      */}
      <dl
        className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-muted/30 p-3 text-xs"
        data-testid="funnel"
      >
        <Funnel label="Frames analysed" value={session?.counts.framesAnalysed ?? null} />
        <Funnel label="Detections returned" value={detections} />
        <Funnel
          label="Events persisted"
          value={timeline.entries.length}
          hint="one per track per 10 s (L-57)"
        />
        <Funnel label="Tracks" value={timeline.tracks.length} hint="distinct subjects followed" />
        <Funnel
          label="Incidents"
          value={timeline.incidentsAvailable ? timeline.incidents.length : null}
        />
      </dl>
      <p className="text-2xs text-muted-foreground">
        ⚠️ <strong>Tracks are not a headcount.</strong> One person who leaves the frame and returns
        may be counted twice, and two people who cross may briefly merge. It is the number of
        identities the tracker followed, which is the honest figure the platform can support.
      </p>

      {focusTrack === undefined ? null : (
        <div className="flex items-center gap-2 rounded-md border border-brand/40 bg-brand/5 p-2 text-xs">
          <Crosshair className="h-3.5 w-3.5 text-brand" aria-hidden />
          <span>
            Showing <strong>{shortTrack(focusTrack)}</strong> only — the player draws this subject
            and nothing else.
          </span>
          <Button size="sm" variant="ghost" onClick={() => onFocusTrack(undefined)}>
            Clear
          </Button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="incidents">
            Incidents ({timeline.incidentsAvailable ? timeline.incidents.length : '—'})
          </TabsTrigger>
          <TabsTrigger value="events">Events ({entries.length})</TabsTrigger>
          <TabsTrigger value="tracks">Tracks ({timeline.tracks.length})</TabsTrigger>
          <TabsTrigger value="density">Density</TabsTrigger>
        </TabsList>

        {/* ── incidents ────────────────────────────────────────────────── */}
        <TabsContent value="incidents">
          {!timeline.incidentsAvailable ? (
            /* ⚠️ The fourth state. "We could not look" is not "we looked and found none". */
            <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              Incidents could not be looked up for this run.
            </p>
          ) : timeline.incidents.length === 0 ? (
            <Empty>No rule raised an incident from this run.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>At</TableHead>
                  <TableHead>Incident</TableHead>
                  <TableHead>Raised by</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>From event</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {timeline.incidents.map((i) => (
                  <TableRow key={i.incidentId}>
                    <TableCell>
                      <SeekButton offset={i.offsetSeconds} onSeek={onSeek} />
                    </TableCell>
                    <TableCell>{i.title}</TableCell>
                    {/* ⭐ "Which rule created this incident?" — by name and version, not an id. */}
                    <TableCell className="text-xs">
                      {i.ruleName ?? i.ruleId ?? '—'}
                      {i.ruleVersion === undefined ? null : (
                        <span className="text-muted-foreground"> · v{i.ruleVersion}</span>
                      )}
                    </TableCell>
                    <TableCell>{i.status}</TableCell>
                    <TableCell className="text-2xs tabular text-muted-foreground">
                      {i.triggeredByEventId === undefined
                        ? '—'
                        : i.triggeredByEventId.slice(0, 8)}
                      {i.matchedCount === undefined || i.matchedCount <= 1 ? null : (
                        <span> (+{i.matchedCount - 1})</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/*
                        ⚠️ Capturing a still spawns ffmpeg against the recording in object storage —
                        seconds, not milliseconds. Without the spinner a disabled button is the only
                        feedback, and an operator reads that as "nothing happened".
                      */}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={captureDisabled}
                        onClick={() => onCaptureStill(i.offsetSeconds, i.incidentId)}
                      >
                        {captureDisabled ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                        ) : null}
                        {captureDisabled ? 'Capturing…' : 'Capture still'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        {/* ── events ───────────────────────────────────────────────────── */}
        <TabsContent value="events">
          <p className="pb-2 text-2xs text-muted-foreground">
            Every event this run persisted, with the box and confidence the model produced.{' '}
            {detections === null ? null : (
              <>
                The runtime returned <strong>{detections}</strong> detections; these{' '}
                <strong>{timeline.entries.length}</strong> are what survived the dedup window — the
                rest were never written.
              </>
            )}{' '}
            {/*
              ⭐ The same events in the general explorer, with paging and the full envelope. Offline
              events are excluded from every unfiltered read (ADR-0047), so naming the run is the
              only way to reach them — and the link carries it.
            */}
            <Link
              className="underline underline-offset-2 hover:text-foreground"
              to={`/events?analysisSessionId=${encodeURIComponent(timeline.sessionId)}`}
            >
              Open this run in the Events explorer →
            </Link>
          </p>
          {entries.length === 0 ? (
            <Empty>No events were persisted for this run.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>At</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Track</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Box (x, y, w, h)</TableHead>
                  <TableHead>Raised</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.eventId}>
                    <TableCell>
                      <SeekButton offset={e.offsetSeconds} onSeek={onSeek} />
                    </TableCell>
                    <TableCell className="text-xs">{e.type}</TableCell>
                    <TableCell>{e.label}</TableCell>
                    <TableCell>
                      {e.trackId === undefined ? (
                        '—'
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1 text-xs"
                          onClick={() => onFocusTrack(e.trackId)}
                        >
                          {shortTrack(e.trackId)}
                        </Button>
                      )}
                    </TableCell>
                    {/* ⛔ `null` is "—", never "0 %" — ADR-0039. */}
                    <TableCell className="tabular">
                      {e.confidence === null ? '—' : `${(e.confidence * 100).toFixed(1)} %`}
                    </TableCell>
                    <TableCell className="text-2xs tabular text-muted-foreground">
                      {e.bbox === undefined
                        ? '—'
                        : e.bbox.map((n) => n.toFixed(3)).join(', ')}
                    </TableCell>
                    <TableCell>
                      {/* ⭐ "Which events became incidents?" — from the stored link. */}
                      {triggeringEvents.has(e.eventId) ? (
                        <Badge variant="critical">incident</Badge>
                      ) : (
                        <span className="text-2xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        {/* ── tracks ───────────────────────────────────────────────────── */}
        <TabsContent value="tracks">
          <p className="pb-2 text-2xs text-muted-foreground">
            One row per identity the tracker followed. ⚠️ <strong>Observations</strong> counts the
            events that survived dedup, <em>not</em> the frames the subject was tracked in — the
            tracker sees far more than this number, and none of it is stored.
          </p>
          {timeline.tracks.length === 0 ? (
            <Empty>No subject was tracked across frames in this run.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Track</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Visible for</TableHead>
                  <TableHead>Observations</TableHead>
                  <TableHead>Peak confidence</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {timeline.tracks.map((t) => (
                  <TableRow key={t.trackId}>
                    <TableCell className="font-medium">{shortTrack(t.trackId)}</TableCell>
                    <TableCell>{t.label}</TableCell>
                    <TableCell>
                      <SeekButton offset={t.fromOffsetSeconds} onSeek={onSeek} />
                    </TableCell>
                    <TableCell>
                      <SeekButton offset={t.toOffsetSeconds} onSeek={onSeek} />
                    </TableCell>
                    <TableCell className="tabular">
                      {(t.toOffsetSeconds - t.fromOffsetSeconds).toFixed(1)} s
                    </TableCell>
                    <TableCell className="tabular">{t.observations}</TableCell>
                    <TableCell className="tabular">
                      {t.peakConfidence === null
                        ? '—'
                        : `${(t.peakConfidence * 100).toFixed(1)} %`}
                    </TableCell>
                    <TableCell>
                      {/* ⭐ "Which person is Track 7?" — seek to first sighting and isolate it. */}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          onFocusTrack(t.trackId);
                          onSeek(t.fromOffsetSeconds);
                        }}
                      >
                        Show me
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        {/* ── density ──────────────────────────────────────────────────── */}
        <TabsContent value="density">
          <DensityLane timeline={timeline} onSeek={onSeek} detections={detections} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

/**
 * ⛔ **Labelled "persisted events", and never "detections".**
 *
 * The user's brief for this milestone asked for exactly this to be spelled out, and the measurement
 * is why: on the run this was built against the two numbers are 24 and 285. A bar chart captioned
 * "detections" would misstate what the platform kept by an order of magnitude, on the one screen an
 * investigator uses to judge how busy a minute was.
 */
function DensityLane({
  timeline,
  onSeek,
  detections,
}: {
  timeline: AnalysisTimeline;
  onSeek: (s: number) => void;
  detections: number | null;
}) {
  const peak = Math.max(1, ...timeline.density.map((b) => b.count));
  const total = timeline.density.reduce((sum, b) => sum + b.count, 0);

  return (
    <div className="space-y-2" data-testid="density-lane">
      <p className="text-2xs text-muted-foreground">
        <strong>Persisted events</strong> per bucket across the recording — {timeline.density.length}{' '}
        buckets, {total} events, busiest bucket {peak}.{' '}
        {detections === null ? null : (
          <>
            ⚠️ This is <strong>not</strong> a detection histogram: the runtime returned {detections}{' '}
            detections and {total} events were written. A quiet bucket can mean a quiet minute or a
            subject already counted in the previous ten seconds.
          </>
        )}
      </p>
      <div
        className="flex h-24 items-end gap-px rounded-md border border-border bg-muted/20 p-1"
        role="img"
        aria-label={`Persisted event density: ${total} events across ${timeline.density.length} buckets`}
      >
        {timeline.density.map((b) => (
          <button
            key={b.fromOffsetSeconds}
            type="button"
            className="group relative min-w-px flex-1 bg-brand/70 hover:bg-brand"
            style={{ height: `${Math.max(2, (b.count / peak) * 100)}%` }}
            onClick={() => onSeek(b.fromOffsetSeconds)}
            title={`${formatOffset(b.fromOffsetSeconds)} — ${b.count} event(s)`}
          >
            <span className="sr-only">
              {formatOffset(b.fromOffsetSeconds)}: {b.count} events
            </span>
          </button>
        ))}
      </div>
      <div className="flex justify-between text-2xs tabular text-muted-foreground">
        <span>00:00</span>
        <span>{formatOffset(timeline.durationSeconds ?? 0)}</span>
      </div>
    </div>
  );
}

function SeekButton({ offset, onSeek }: { offset: number; onSeek: (s: number) => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 gap-1 px-1 tabular"
      onClick={() => onSeek(offset)}
      title={`Play from ${formatOffset(offset)}`}
      /*
       * ⚠️ **An explicit label, because the visible text is only "00:26".** Without it the accessible
       * name is that bare timestamp — a screen reader announces a number with no verb, and there is
       * nothing to distinguish this control from the dozen other timestamps on the page.
       */
      aria-label={`Play from ${formatOffset(offset)}`}
    >
      <Play className="h-3 w-3" aria-hidden />
      {formatOffset(offset)}
    </Button>
  );
}

function Funnel({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      {/* ⛔ `null` is an em dash. A count nobody produced is not zero. */}
      <dd className="text-base font-semibold tabular">{value === null ? '—' : value}</dd>
      {hint === undefined ? null : <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
      {children}
    </p>
  );
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
