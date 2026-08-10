import { useMemo, useState } from 'react';
import { Ruler } from 'lucide-react';
import type { BehaviourPrimitivesView, BehaviourReading, BehaviourTimelineView } from '@vip/contracts';
import { Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui';
import { EvidenceTag, Incompleteness, SeekControl, Seconds, type RecordingClock } from './parts';
import { timelineKindLabel } from './vocabulary';

/**
 * **The Primitive Inspector** (Phase 2.4 slice 2.8): every primitive, the evidence behind it, the
 * parameters it was computed at, and the frame it originated from.
 *
 * ### ⭐ The parameters are the product
 *
 * "Lingered" is a claim about a person. It means *stationary within 0.08 of the frame width for at
 * least 15 s* and nothing else, and until this panel existed the only way to learn that was to read
 * `behaviour_primitives.py`. The runtime has published `readings` on every primitives response since
 * slice 2.3; nothing rendered them. An operator who cannot see the threshold cannot tell a defensible
 * finding from a badly-tuned one, and neither can the customer they are explaining it to.
 *
 * ### ⛔ There is no confidence per primitive, and this panel says so rather than inventing one
 *
 * A primitive is a geometric measurement against the published threshold above: it met the threshold
 * or it did not. There is no probability to report. What the platform *does* have is the detector's
 * confidence for the observation each fact was evidenced by — that belongs to the detection and is
 * shown in the identity history, labelled as such. A "78 %" beside the word "lingered" would be read
 * as a likelihood by every person who ever saw it, and this layer has no basis to claim one.
 */
export interface PrimitiveInspectorPanelProps {
  primitives: BehaviourPrimitivesView | undefined;
  timeline: BehaviourTimelineView | undefined;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  selectedIdentity: string | undefined;
  onSelectIdentity: (identityId: string | undefined) => void;
  isLoading?: boolean;
}

export function PrimitiveInspectorPanel({
  primitives,
  timeline,
  clock,
  onSeek,
  selectedIdentity,
  onSelectIdentity,
  isLoading = false,
}: PrimitiveInspectorPanelProps) {
  const [openKind, setOpenKind] = useState<string | undefined>();
  const view = primitives?.primitives;

  const notes: string[] = [];
  if (view?.zoneMembership === 'absent') {
    notes.push(
      'No upstream ever supplied zone membership for this run, so every zone primitive was inert. "Nobody entered a zone" is a different answer, and this is not it.',
    );
  }
  if (view?.lineGeometry === 'absent') {
    notes.push(
      'No line geometry reached this read, so the crossing primitive was inert. Nothing here says whether anybody crossed a line.',
    );
  }
  if (view?.lineGeometry === 'invalid') {
    notes.push(
      '⛔ This camera has line geometry that could not be read, so no crossing was evaluated. That is a configuration fault rather than a quiet scene — check the zone in the Zone Editor.',
    );
  }
  /*
   * ⭐ **The finding that makes a silent tripwire explainable** (slice 2.9).
   *
   * ⛔ A correctly-drawn line and one drawn too short both report nothing. Measured on the
   * deployment: a vertical line from y = 0.05 to y = 0.95 caught a person walking straight across it
   * zero times, because a crossing is anchored at the FOOT point and feet sit at y ≈ 0.95 — the walk
   * went around the bottom end. The geometry was right and the operator had no way to know.
   */
  for (const line of view?.lineDiagnostics ?? []) {
    if (line.missedTheSegment > 0 && line.crossings === 0) {
      notes.push(
        `Line ${line.lineId}: ${String(line.missedTheSegment)} subject(s) changed side without passing through it, and nobody crossed it. People are walking PAST this line rather than through it — it is very likely drawn too short. A crossing is anchored at the subject's feet, which sit near the bottom of the picture, so a tripwire has to reach the frame edges.`,
      );
    } else if (line.missedTheSegment > 0) {
      notes.push(
        `Line ${line.lineId}: ${String(line.crossings)} crossing(s), and ${String(line.missedTheSegment)} side change(s) that passed around an end of it rather than through it.`,
      );
    }
  }
  if (view?.relational?.truncated === true) {
    notes.push(
      `Only ${String(view.relational.identitiesConsidered)} of this run's subjects were examined for relations (the limit is ${String(view.relational.maxIdentities)}), so proximity, follow, approach and grouping were never computed for the rest.`,
    );
  }
  for (const [module, reason] of Object.entries(view?.moduleFailures ?? {})) {
    notes.push(`The ${module} module failed on this run and contributed nothing: ${reason}`);
  }

  /** Facts of each kind, from the timeline — the same computation, keyed for the inspector. */
  const byKind = useMemo(() => {
    const map = new Map<string, BehaviourTimelineView['entries']>();
    for (const entry of timeline?.entries ?? []) {
      if (selectedIdentity !== undefined && entry.identityId !== selectedIdentity) continue;
      const found = map.get(entry.kind);
      if (found === undefined) map.set(entry.kind, [entry]);
      else found.push(entry);
    }
    return map;
  }, [timeline?.entries, selectedIdentity]);

  const kinds = useMemo(() => {
    const counts = timeline?.countsByKind ?? {};
    return Object.keys(counts)
      .filter((k) => (counts[k] ?? 0) > 0)
      .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b));
  }, [timeline?.countsByKind]);

  if (isLoading) return <p className="text-sm text-muted-foreground">Recomputing the primitives…</p>;

  return (
    <section className="space-y-3" data-testid="primitive-inspector">
      <Incompleteness notes={notes} />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {Object.keys(view?.identities ?? {}).length} subject(s) ·{' '}
          {(view?.modules ?? []).length} module(s) ·{' '}
          {view?.observedIntervalSeconds === undefined
            ? 'observed interval not reported'
            : `${view.observedIntervalSeconds.toFixed(1)} s observed`}
        </span>
        {selectedIdentity === undefined ? null : (
          <Button size="sm" variant="ghost" onClick={() => onSelectIdentity(undefined)}>
            Show everyone
          </Button>
        )}
      </div>

      {kinds.length === 0 ? (
        <EmptyState
          icon={Ruler}
          title="This run established no primitive"
          description="Nobody was tracked long enough for a single geometric fact to hold. That is a statement about the footage, not about the read."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Primitive</TableHead>
              <TableHead>Count</TableHead>
              <TableHead>Mechanism</TableHead>
              <TableHead>Parameters</TableHead>
              <TableHead>What it means</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {kinds.map((kind) => {
              const reading = readingFor(view?.readings ?? {}, kind);
              const shown = byKind.get(kind) ?? [];
              const open = openKind === kind;
              return (
                <>
                  <TableRow
                    key={kind}
                    className="cursor-pointer"
                    data-testid="primitive-row"
                    data-kind={kind}
                    onClick={() => setOpenKind(open ? undefined : kind)}
                  >
                    <TableCell>
                      <Badge variant="brand">{timelineKindLabel(kind)}</Badge>
                    </TableCell>
                    <TableCell className="tabular">{timeline?.countsByKind[kind] ?? 0}</TableCell>
                    <TableCell className="text-xs">{reading?.mechanism ?? '—'}</TableCell>
                    <TableCell className="text-2xs tabular">
                      {/* ⭐ The thresholds the word above was computed at, from the runtime's own
                          published table. Not a copy kept in the console. */}
                      {reading === undefined ? (
                        <span className="text-muted-foreground">not parameterised</span>
                      ) : (
                        parameters(reading).join(' · ') || '—'
                      )}
                    </TableCell>
                    <TableCell className="text-2xs text-muted-foreground">
                      {reading?.means ?? '—'}
                    </TableCell>
                  </TableRow>
                  {open ? (
                    <TableRow key={`${kind}-detail`} data-testid="primitive-detail">
                      <TableCell colSpan={5} className="bg-muted/30">
                        <div className="space-y-2 py-1">
                          <p className="text-2xs text-muted-foreground">
                            {shown.length === 0
                              ? `No fact of this kind is in the current timeline read${selectedIdentity === undefined ? ' — it may have been filtered out or displaced by the entry cap' : ' for this subject'}.`
                              : `${String(shown.length)} of ${String(timeline?.countsByKind[kind] ?? shown.length)} shown, each with the frame that established it.`}
                          </p>
                          <ul className="space-y-1">
                            {shown.slice(0, 25).map((entry, index) => (
                              <li
                                key={`${entry.identityId}-${String(entry.atSeconds)}-${String(index)}`}
                                className="flex flex-wrap items-center gap-2 text-xs"
                                data-testid="primitive-instance"
                              >
                                <button
                                  type="button"
                                  className="hover:underline"
                                  onClick={() => onSelectIdentity(entry.identityId)}
                                >
                                  {entry.identityId}
                                </button>
                                <span className="tabular">{entry.atSeconds.toFixed(1)} s</span>
                                <Seconds value={entry.seconds} />
                                <EvidenceTag evidence={entry.evidence} />
                                <SeekControl
                                  footageSeconds={entry.footageSeconds}
                                  clock={clock}
                                  onSeek={onSeek}
                                  size="xs"
                                />
                              </li>
                            ))}
                          </ul>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/**
 * The published reading for a timeline kind.
 *
 * ⚠️ The two vocabularies are not identical — the timeline says `groupMerge` where the reading table
 * says `group_merge`, and `zoneVisit` has no reading of its own because membership is supplied
 * rather than measured. An unmapped kind returns `undefined` and renders as "not parameterised",
 * which is the truth: no threshold decided it.
 */
const READING_OF_KIND: Record<string, string> = {
  gap: 'gap',
  proximity: 'proximity',
  idle: 'idle',
  linger: 'linger',
  queue: 'queue',
  follow: 'follow',
  approach: 'approach',
  recede: 'recede',
  groupMerge: 'group_merge',
  groupSplit: 'group_split',
  lineCross: 'cross_line',
  zoneEntry: 'enter_zone',
  zoneExit: 'exit_zone',
  carried: 'carry_object',
  picked: 'pick_object',
  dropped: 'drop_object',
  objectMissing: 'object_missing',
  objectReturned: 'object_returned',
  handover: 'handover',
};

export function readingFor(
  readings: Record<string, BehaviourReading>,
  kind: string,
): BehaviourReading | undefined {
  const name = READING_OF_KIND[kind];
  return name === undefined ? undefined : readings[name];
}

/** Every numeric parameter of a reading, as `name value` pairs. ⚠️ Order is the table's own. */
export function parameters(reading: BehaviourReading): string[] {
  return Object.entries(reading)
    .filter(([key, value]) => key !== 'mechanism' && key !== 'means' && typeof value === 'number')
    .map(([key, value]) => `${humanise(key)} ${String(value)}`);
}

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
