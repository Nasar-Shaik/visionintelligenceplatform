import { useMemo, useState } from 'react';
import type { AnalysisTimeline } from '@vip/contracts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui';
import { epochSecondsOf, type RecordingClock } from './footage';
import {
  useBehaviourGraph,
  useBehaviourPrimitives,
  useBehaviourTimeline,
  useTrackHistory,
} from './useBehaviour';
import { BehaviourTimelinePanel } from './BehaviourTimelinePanel';
import { BehaviourGraphPanel } from './BehaviourGraphPanel';
import { IdentityHistoryPanel } from './IdentityHistoryPanel';
import { PrimitiveInspectorPanel } from './PrimitiveInspectorPanel';
import { ReasoningPanel } from './ReasoningPanel';

/**
 * **The investigation behaviour surface** (Phase 2.4 slice 2.8).
 *
 *     video ◀──▶ timeline ◀──▶ behaviour ◀──▶ graph ◀──▶ candidate ◀──▶ reasoning chain
 *                       one selected subject · one seek · one clock
 *
 * ### ⭐ Selection and seeking are held HERE, once
 *
 * Five panels show the same run. Clicking a person on the graph must filter the timeline, open their
 * history and narrow the inspector — otherwise each tab is a separate investigation of the same
 * footage, and an operator has to re-find their subject four times. So `selectedIdentity`, the kind
 * filter and the seek callback live on this component and are passed down; no panel owns any of them.
 *
 * ### ⛔ One computation, four reads, no fifth
 *
 * The timeline, graph and primitives are three shapes of a single pass over track history; the
 * fourth read is that history itself, which is the only source of per-frame position. Nothing here
 * derives a behaviour fact — the browser's whole arithmetic is placing a fact in the video
 * (`footage.ts`) and tallying facts it was given (`identity.ts`).
 */
export interface BehaviourPanelProps {
  /** The RUN. ⚠️ `ases_…`, not the analysis id — track history is keyed per run (ADR-0047). */
  streamId: string | undefined;
  /** The analysis timeline, for the footage clock and for attributing incidents. */
  analysisTimeline: AnalysisTimeline | undefined;
  durationSeconds?: number | undefined;
  onSeek: (offsetSeconds: number) => void;
  /** Set to true only once the run is finished — a partial run's behaviour changes under the reader. */
  enabled: boolean;
}

export function BehaviourPanel({
  streamId,
  analysisTimeline,
  durationSeconds,
  onSeek,
  enabled,
}: BehaviourPanelProps) {
  const [tab, setTab] = useState('timeline');
  const [kinds, setKinds] = useState<string[]>([]);
  const [selectedIdentity, setSelectedIdentity] = useState<string | undefined>();
  const [highlightEdgeIds, setHighlightEdgeIds] = useState<string[]>([]);

  const timeline = useBehaviourTimeline(streamId, kinds, enabled);
  /* ⚠️ Fetched only when their tab is open. Each is a full recompute in the runtime — 563 ms for a
   * 62-identity camera — and three of them on mount would make opening the page cost all three. */
  const graph = useBehaviourGraph(streamId, enabled && (tab === 'graph' || tab === 'reasoning'));
  const primitives = useBehaviourPrimitives(streamId, enabled && tab === 'primitives');
  const history = useTrackHistory(streamId, selectedIdentity, enabled && tab === 'identity');

  /**
   * ⛔ The recording's own clock. Without `footageStartedAt` a behaviour fact cannot be placed in the
   * video at all, and `SeekControl` refuses rather than guessing — see `footage.ts`.
   */
  const clock: RecordingClock = useMemo(
    () => ({
      startedAtSeconds: epochSecondsOf(analysisTimeline?.footageStartedAt),
      durationSeconds: analysisTimeline?.durationSeconds ?? durationSeconds,
    }),
    [analysisTimeline?.footageStartedAt, analysisTimeline?.durationSeconds, durationSeconds],
  );

  /** Every subject in the run, from the graph when it is loaded and the timeline otherwise. */
  const identities = useMemo(() => {
    const fromGraph = (graph.data?.graph?.nodes ?? [])
      .filter((n) => n.kind === 'identity')
      .map((n) => n.id);
    if (fromGraph.length > 0) return [...new Set(fromGraph)].sort();
    return [...new Set((timeline.data?.entries ?? []).map((e) => e.identityId))].sort();
  }, [graph.data?.graph?.nodes, timeline.data?.entries]);

  /** Zone and object vocabulary for the rule composer, taken from what this run actually contains. */
  const zoneIds = useMemo(
    () =>
      [...new Set((graph.data?.graph?.nodes ?? []).filter((n) => n.kind === 'zone').map((n) => n.label))].sort(),
    [graph.data?.graph?.nodes],
  );
  const objectLabels = useMemo(
    () =>
      [...new Set((graph.data?.graph?.nodes ?? []).filter((n) => n.kind === 'object').map((n) => n.label))].sort(),
    [graph.data?.graph?.nodes],
  );

  if (!enabled) {
    return (
      <section className="space-y-2" data-testid="behaviour-panel">
        <h2 className="text-sm font-semibold">Behaviour</h2>
        <p className="text-sm text-muted-foreground">
          {/* ⚠️ Stated rather than shown empty. A run still in flight has a behaviour answer that
              changes under the reader, and a half-answer presented as a whole one is the failure this
              project keeps meeting. */}
          Behaviour is recomputed from the movement paths a finished run stored. Run the analysis to
          the end and this surface will describe it.
        </p>
      </section>
    );
  }

  const unavailable =
    timeline.data?.enabled === false ? (timeline.data.detail ?? 'the runtime keeps no track history') : undefined;

  return (
    <section className="space-y-3" data-testid="behaviour-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Behaviour</h2>
        <p className="text-2xs text-muted-foreground">
          Recomputed on read from stored movement paths. Nothing on this surface is persisted, so a
          corrected formula corrects history rather than being unable to reach it.
        </p>
      </div>

      {unavailable === undefined ? null : (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-500" role="alert">
          {/* ⛔ "The runtime keeps no history" and "nobody did anything" are opposite facts that
              render identically as an empty list. */}
          Behaviour cannot be read for this run: {unavailable}
        </p>
      )}

      {timeline.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {timeline.error instanceof Error ? timeline.error.message : 'The behaviour read failed.'}
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="identity">Identity</TabsTrigger>
          <TabsTrigger value="primitives">Primitives</TabsTrigger>
          <TabsTrigger value="reasoning">Reasoning</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline">
          <BehaviourTimelinePanel
            view={timeline.data}
            clock={clock}
            onSeek={onSeek}
            kinds={kinds}
            onKindsChange={setKinds}
            selectedIdentity={selectedIdentity}
            onSelectIdentity={setSelectedIdentity}
            isLoading={timeline.isPending}
          />
        </TabsContent>

        <TabsContent value="graph">
          <BehaviourGraphPanel
            view={graph.data}
            clock={clock}
            onSeek={onSeek}
            selectedIdentity={selectedIdentity}
            onSelectIdentity={setSelectedIdentity}
            highlightEdgeIds={highlightEdgeIds}
            isLoading={graph.isPending}
          />
        </TabsContent>

        <TabsContent value="identity">
          <IdentityHistoryPanel
            identityId={selectedIdentity}
            history={history.data}
            timeline={timeline.data}
            analysisTimeline={analysisTimeline}
            clock={clock}
            onSeek={onSeek}
            onSelectIdentity={setSelectedIdentity}
            identities={identities}
            isLoading={history.isPending && selectedIdentity !== undefined}
          />
        </TabsContent>

        <TabsContent value="primitives">
          <PrimitiveInspectorPanel
            primitives={primitives.data}
            timeline={timeline.data}
            clock={clock}
            onSeek={onSeek}
            selectedIdentity={selectedIdentity}
            onSelectIdentity={setSelectedIdentity}
            isLoading={primitives.isPending}
          />
        </TabsContent>

        <TabsContent value="reasoning">
          <ReasoningPanel
            streamId={streamId}
            clock={clock}
            onSeek={onSeek}
            onSelectIdentity={(id) => {
              setSelectedIdentity(id);
            }}
            onHighlightEdges={(ids) => {
              setHighlightEdgeIds(ids);
              /* ⭐ A chain that highlights edges nobody is looking at explains nothing. */
              if (ids.length > 0) setTab('graph');
            }}
            zoneIds={zoneIds}
            objectLabels={objectLabels}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
