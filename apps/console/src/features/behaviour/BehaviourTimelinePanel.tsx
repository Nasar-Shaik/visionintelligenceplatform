import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { BehaviourTimelineEntry, BehaviourTimelineView } from '@vip/contracts';
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui';
import { Activity } from 'lucide-react';
import { EvidenceTag, Incompleteness, SeekControl, Seconds, type RecordingClock } from './parts';
import { KIND_GROUPS, groupOfKind, timelineKindLabel } from './vocabulary';

/**
 * **The behaviour timeline** (Phase 2.4 slice 2.8): every primitive this run produced, in footage
 * order, each one clickable back to the frame that established it.
 *
 * ### ⛔ The filter narrows the QUERY, not the rendered list
 *
 * On a live camera 1207 of the 2000 entries the runtime's cap allows were `gap` — so every merge,
 * queue and crossing later in the run had already been cut before the browser saw anything, and the
 * list looked complete. Filtering what arrived would hide the noise and recover none of the loss.
 * So a kind selection is sent to the runtime, which applies it *before* the cap. `countsByKind` is
 * counted over the whole run either way, which is what makes the loss visible at all.
 *
 * ### ⚠️ There is no confidence column, and that is a decision
 *
 * A primitive is a geometric measurement against a published threshold: it met the threshold or it
 * did not. The platform has no probability for "lingered" and inventing one — a normalised duration,
 * a distance ratio — would be read as a likelihood by every person who saw it. What *is* available
 * is the detector's confidence for the observation the fact was evidenced by, and that is shown in
 * the identity history where the observation itself is. See the Primitive Inspector for the
 * thresholds each word was computed at.
 */
export interface BehaviourTimelinePanelProps {
  view: BehaviourTimelineView | undefined;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  /** Kinds currently asked for; empty means everything. Owned by the parent so tabs share it. */
  kinds: string[];
  onKindsChange: (kinds: string[]) => void;
  selectedIdentity: string | undefined;
  onSelectIdentity: (identityId: string | undefined) => void;
  isLoading?: boolean;
}

export function BehaviourTimelinePanel({
  view,
  clock,
  onSeek,
  kinds,
  onKindsChange,
  selectedIdentity,
  onSelectIdentity,
  isLoading = false,
}: BehaviourTimelinePanelProps) {
  const [expanded, setExpanded] = useState<string | undefined>();

  const counts = view?.countsByKind ?? {};
  const entries = useMemo(() => {
    const all = view?.entries ?? [];
    /* ⚠️ The only client-side narrowing, and it is a *selection* rather than a filter: an operator
     * who clicked a person is asking about that person, and the counts above still describe the run. */
    return selectedIdentity === undefined ? all : all.filter((e) => e.identityId === selectedIdentity);
  }, [view?.entries, selectedIdentity]);

  const notes: string[] = [];
  if (view?.truncated === true) {
    notes.push(
      `This run produced more facts than one read returns, so the list stops early. Narrow it by kind — the filter is applied in the runtime, before the cap, so it recovers what is missing here.`,
    );
  }
  if (view?.relational?.truncated === true) {
    notes.push(
      `More subjects were in this scene than the pairwise families examine (${String(view.relational.identitiesConsidered)} of them were considered, the limit is ${String(view.relational.maxIdentities)}). Proximity, following, approach and grouping were never computed for the rest — their absence below means nothing.`,
    );
  }
  if ((view?.excludedByKind ?? 0) > 0) {
    notes.push(
      `${String(view?.excludedByKind ?? 0)} fact(s) of other kinds were excluded by the filter. This list is not the whole run.`,
    );
  }

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <section className="space-y-3" data-testid="behaviour-timeline">
      <Incompleteness notes={notes} />

      {/* --- what the run produced, and the filter that narrows the query ------------------- */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {/* ⭐ Counted over the WHOLE run, before the filter and before the cap. */}
            {total} fact(s) across {Object.keys(counts).length} kind(s)
            {view?.entries.length === undefined ? null : ` · showing ${String(entries.length)}`}
          </span>
          {kinds.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onKindsChange([])}>
              Clear filter
            </Button>
          ) : null}
          {selectedIdentity === undefined ? null : (
            <Button size="sm" variant="ghost" onClick={() => onSelectIdentity(undefined)}>
              Show everyone
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-3">
          {Object.entries(KIND_GROUPS).map(([group, entry]) => {
            const present = entry.kinds.filter((k) => (counts[k] ?? 0) > 0);
            if (present.length === 0) return null;
            return (
              <div key={group} className="space-y-1">
                <p className="text-2xs uppercase tracking-wide text-muted-foreground">{entry.label}</p>
                <div className="flex flex-wrap gap-1">
                  {present.map((kind) => {
                    const on = kinds.includes(kind);
                    return (
                      <Button
                        key={kind}
                        size="sm"
                        variant={on ? 'primary' : 'outline'}
                        className="h-6 px-2 text-2xs"
                        data-testid={`kind-filter-${kind}`}
                        aria-pressed={on}
                        onClick={() =>
                          onKindsChange(on ? kinds.filter((k) => k !== kind) : [...kinds, kind])
                        }
                      >
                        {timelineKindLabel(kind)} · {counts[kind] ?? 0}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* --- the facts --------------------------------------------------------------------- */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Recomputing this run's behaviour…</p>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={
            total === 0
              ? 'This run produced no behaviour facts'
              : 'No facts match the current filter'
          }
          description={
            total === 0
              ? 'Nobody was tracked for long enough to establish a single primitive. That is an answer about the footage, not a failure of the read.'
              : 'Every fact this run produced is counted above. Clear the filter to see them.'
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>At</TableHead>
              <TableHead>Fact</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Evidence</TableHead>
              <TableHead>Seek</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry, index) => {
              const id = rowId(entry, index);
              const open = expanded === id;
              return (
                <TimelineRow
                  key={id}
                  id={id}
                  entry={entry}
                  open={open}
                  clock={clock}
                  onSeek={onSeek}
                  onToggle={() => setExpanded(open ? undefined : id)}
                  onSelectIdentity={onSelectIdentity}
                />
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** ⚠️ Index included: two facts of one kind about one subject can share an instant legitimately. */
function rowId(entry: BehaviourTimelineEntry, index: number): string {
  return `${entry.kind}:${entry.identityId}:${String(entry.atSeconds)}:${String(index)}`;
}

function TimelineRow({
  id,
  entry,
  open,
  clock,
  onSeek,
  onToggle,
  onSelectIdentity,
}: {
  id: string;
  entry: BehaviourTimelineEntry;
  open: boolean;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  onToggle: () => void;
  onSelectIdentity: (identityId: string | undefined) => void;
}) {
  const group = groupOfKind(entry.kind);
  return (
    <>
      <TableRow data-testid="behaviour-row" data-kind={entry.kind} data-identity={entry.identityId}>
        <TableCell className="tabular">
          {/* ⭐ Offset from the run's first observation — the readable clock. `footageSeconds` is
              the joinable one and travels on the seek button, not on the screen. */}
          {entry.atSeconds.toFixed(1)} s
        </TableCell>
        <TableCell>
          <button
            type="button"
            className="flex items-center gap-1 text-left hover:underline"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`${id}-detail`}
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Badge variant={group === 'presence' ? 'neutral' : 'brand'}>
              {timelineKindLabel(entry.kind)}
            </Badge>
          </button>
        </TableCell>
        <TableCell>
          <button
            type="button"
            className="text-left text-xs hover:underline"
            onClick={() => onSelectIdentity(entry.identityId)}
            title="Show only this subject"
          >
            {entry.identityId}
          </button>
        </TableCell>
        <TableCell>
          <Seconds value={entry.seconds} />
        </TableCell>
        <TableCell>
          <EvidenceTag evidence={entry.evidence} />
        </TableCell>
        <TableCell>
          <SeekControl footageSeconds={entry.footageSeconds} clock={clock} onSeek={onSeek} size="xs" />
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow id={`${id}-detail`} data-testid="behaviour-row-detail">
          <TableCell colSpan={6} className="bg-muted/30">
            <div className="space-y-2 py-1">
              {/* ⭐ The runtime's own sentence, verbatim. The console does not rewrite it: the
                  summary states the measurement and the number, and a paraphrase is where a motive
                  gets added by accident. */}
              <p className="text-sm">{entry.summary}</p>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-2xs sm:grid-cols-4">
                <Detail label="Kind" value={entry.kind} />
                <Detail label="Camera" value={entry.cameraId} />
                <Detail label="Run" value={entry.streamId ?? '—'} />
                <Detail
                  label="Footage clock"
                  /* ⚠️ Shown so a reader can join to a history point or an event. Labelled as the
                     absolute clock so nobody reads 1.79e9 as a position in the video. */
                  value={`${entry.footageSeconds.toFixed(3)} s`}
                />
                {Object.entries(entry.attributes ?? {}).map(([key, value]) => (
                  <Detail key={key} label={key} value={String(value)} />
                ))}
              </dl>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}
