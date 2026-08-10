import { useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import type { BehaviourGraphView } from '@vip/contracts';
import { Badge, Button, EmptyState } from '@/ui';
import { EvidenceTag, Incompleteness, SeekControl, type RecordingClock } from './parts';
import { edgeKindLabel, nodeStyle } from './vocabulary';
import { DEFAULT_MAX_NODES, layoutGraph, type LaidOutEdge } from './graph-layout';
import { sinceOrigin } from './footage';

/**
 * **The behaviour graph, drawn** (Phase 2.4 slice 2.8) — identity, zone, object, group and line
 * nodes with the relations between them.
 *
 * ### ⛔ Every line is an interval, and clicking it opens the intervals
 *
 * A graph edge here is not an abstraction over the timeline; it *is* a timeline entry, reshaped
 * (`behaviour_graph.py` is built from `timeline_for`'s entries and nothing else). So every line
 * carries the frames its facts came from and every fact seeks the video. A diagram whose nodes could
 * not be opened would be the prettiest thing on this page and the least useful — a picture of an
 * investigation rather than a way into one.
 *
 * ### ⚠️ Nothing here is a "reasoning edge"
 *
 * A reasoning chain is not drawn on this diagram, and the omission is deliberate. A chain is an
 * *ordered path* over these edges chosen by a rule the operator wrote; drawing it as another line
 * type would make a tenant's rule look like a fact the platform observed. The chain is rendered
 * where it belongs — beside the rule that produced it — and it highlights the edges it used.
 */
export interface BehaviourGraphPanelProps {
  view: BehaviourGraphView | undefined;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  selectedIdentity: string | undefined;
  onSelectIdentity: (identityId: string | undefined) => void;
  /** Edge ids a reasoning chain matched, highlighted so the WHY is visible on the diagram. */
  highlightEdgeIds?: readonly string[];
  isLoading?: boolean;
}

export function BehaviourGraphPanel({
  view,
  clock,
  onSeek,
  selectedIdentity,
  onSelectIdentity,
  highlightEdgeIds = [],
  isLoading = false,
}: BehaviourGraphPanelProps) {
  const [openEdge, setOpenEdge] = useState<string | undefined>();
  const graph = view?.graph;

  const layout = useMemo(
    () => layoutGraph(graph, { focus: selectedIdentity, maxNodes: DEFAULT_MAX_NODES }),
    [graph, selectedIdentity],
  );

  const highlight = useMemo(() => new Set(highlightEdgeIds), [highlightEdgeIds]);
  const origin = graph?.originSeconds ?? 0;

  const notes: string[] = [];
  if (graph?.truncated?.nodes === true) notes.push('More nodes existed than the graph returns; some subjects are missing from this diagram.');
  if (graph?.truncated?.edges === true) notes.push('More relations existed than the graph returns; some lines are missing from this diagram.');
  if (graph?.truncated?.relational === true) {
    notes.push(
      `Only ${String(graph.truncated.identitiesConsidered)} subject(s) were examined for relations (the limit is ${String(graph.truncated.maxIdentities ?? 0)}). Proximity, following and grouping were never computed for the rest, so their absence from this diagram means nothing.`,
    );
  }
  if (layout.nodesShown < layout.nodesTotal) {
    notes.push(
      `${String(layout.nodesShown)} of ${String(layout.nodesTotal)} nodes are drawn, most-connected first. ${selectedIdentity === undefined ? 'Select a subject to see their own graph.' : ''}`,
    );
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Building the behaviour graph…</p>;

  if (graph === undefined || layout.nodesTotal === 0) {
    return (
      <EmptyState
        icon={Network}
        title="This run has no behaviour graph"
        description={
          view?.enabled === false
            ? (view.detail ?? 'The runtime is not keeping track history, so nothing can be assembled.')
            : 'No identity was tracked long enough to establish a relation with a place, a thing or another person.'
        }
      />
    );
  }

  const open = layout.edges.find((e) => e.key === openEdge);

  return (
    <section className="space-y-3" data-testid="behaviour-graph">
      <Incompleteness notes={notes} />

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span data-testid="graph-counts">
          {layout.nodesShown}/{layout.nodesTotal} nodes · {layout.edgesShown}/{layout.edgesTotal}{' '}
          relations
          {/* ⭐ Bundling is stated. "40 near-intervals drawn as one line" is more information than
              forty overlapping strokes, but only if the reader is told which they are looking at. */}
          {layout.bundles > 0 ? ` · ${String(layout.bundles)} line(s) bundle repeated facts` : ''}
        </span>
        {selectedIdentity === undefined ? null : (
          <Button size="sm" variant="ghost" onClick={() => onSelectIdentity(undefined)}>
            Show the whole graph
          </Button>
        )}
        <span className="flex flex-wrap gap-2">
          {['identity', 'zone', 'object', 'group', 'line'].map((kind) => (
            <span key={kind} className={`inline-flex items-center gap-1 ${nodeStyle(kind).text}`}>
              <svg width="10" height="10" aria-hidden>
                <circle cx="5" cy="5" r="4" className={`${nodeStyle(kind).fill} ${nodeStyle(kind).ring}`} />
              </svg>
              {kind}
            </span>
          ))}
        </span>
      </div>

      <div className="overflow-auto rounded-md border border-border bg-surface-2">
        <svg
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={`Behaviour graph: ${String(layout.nodesShown)} nodes and ${String(layout.edgesShown)} relations. Places on the left, people in the middle, things on the right.`}
          data-testid="behaviour-graph-svg"
        >
          {layout.edges.map((edge) => {
            const lit = edge.edges.some((e) => highlight.has(e.id));
            return (
              <g key={edge.key}>
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  className={
                    lit
                      ? 'stroke-brand'
                      : edge.key === openEdge
                        ? 'stroke-foreground'
                        : 'stroke-border-strong'
                  }
                  strokeWidth={lit ? 3 : Math.min(4, 1 + Math.log10(edge.count + 1) * 2)}
                  strokeOpacity={lit ? 1 : 0.7}
                />
                {/* ⚠️ A generous invisible hit area: a 1 px line is not clickable with a mouse and
                    entirely unreachable with a touch device. */}
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke="transparent"
                  strokeWidth={12}
                  className="cursor-pointer"
                  data-testid="graph-edge"
                  data-kind={edge.kind}
                  data-count={edge.count}
                  onClick={() => setOpenEdge(edge.key === openEdge ? undefined : edge.key)}
                />
                {edge.count > 1 ? (
                  <text
                    x={(edge.x1 + edge.x2) / 2}
                    y={(edge.y1 + edge.y2) / 2 - 4}
                    className="fill-muted-foreground text-[9px]"
                    textAnchor="middle"
                  >
                    ×{edge.count}
                  </text>
                ) : null}
              </g>
            );
          })}
          {layout.nodes.map((node) => {
            const style = nodeStyle(node.kind);
            const chosen = node.id === selectedIdentity;
            return (
              <g
                key={node.id}
                className="cursor-pointer"
                data-testid="graph-node"
                data-kind={node.kind}
                data-node-id={node.id}
                onClick={() => onSelectIdentity(chosen ? undefined : node.id)}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={chosen ? 11 : 8}
                  className={`${style.fill} ${style.ring}`}
                  strokeWidth={chosen ? 3 : 1.5}
                />
                <text x={node.x + 14} y={node.y + 3} className="fill-foreground text-[10px]">
                  {node.label}
                </text>
                <text x={node.x + 14} y={node.y + 14} className="fill-muted-foreground text-[8px]">
                  {node.id.length > 26 ? `${node.id.slice(0, 26)}…` : node.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {open === undefined ? (
        <p className="text-xs text-muted-foreground">
          Click a line to see the facts behind it, or a node to narrow the diagram to one subject.
        </p>
      ) : (
        <EdgeDetail edge={open} origin={origin} clock={clock} onSeek={onSeek} />
      )}

      {/* ⭐ Node attributes are the facts a subject established ALONE — idle, linger, time in view.
          They are not self-edges, because an edge from a node to itself is a drawing problem in
          every renderer and a lie in every traversal. */}
      {selectedIdentity === undefined ? null : (
        <NodeAttributes node={layout.nodes.find((n) => n.id === selectedIdentity)} />
      )}
    </section>
  );
}

function EdgeDetail({
  edge,
  origin,
  clock,
  onSeek,
}: {
  edge: LaidOutEdge;
  origin: number;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="graph-edge-detail">
      <p className="text-sm">
        <strong>{edge.source}</strong> {edgeKindLabel(edge.kind)} <strong>{edge.target}</strong> ·{' '}
        {edge.count} time(s)
      </p>
      <ul className="space-y-1">
        {edge.edges.slice(0, 40).map((one) => (
          <li key={one.id} className="flex flex-wrap items-center gap-2 text-xs">
            {/* ⛔ Rendered as an OFFSET. The edge carries the absolute footage clock and printing it
                directly is how a screen ends up saying "at 1786221387.294 s". */}
            <span className="tabular">
              {sinceOrigin(one.atSeconds, origin).toFixed(1)} s
              {one.seconds === undefined ? '' : ` · ${one.seconds.toFixed(1)} s long`}
            </span>
            <EvidenceTag evidence={one.evidence} />
            <SeekControl footageSeconds={one.atSeconds} clock={clock} onSeek={onSeek} size="xs" />
          </li>
        ))}
      </ul>
      {edge.edges.length > 40 ? (
        <p className="text-2xs text-muted-foreground">
          40 of {edge.edges.length} shown. The rest are in the timeline, filtered to this kind.
        </p>
      ) : null}
    </div>
  );
}

function NodeAttributes({ node }: { node: { label: string; attributes: Record<string, unknown> } | undefined }) {
  if (node === undefined || Object.keys(node.attributes).length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-border p-3" data-testid="graph-node-detail">
      <p className="text-xs font-semibold">What this subject did alone</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-2xs sm:grid-cols-4">
        {Object.entries(node.attributes).map(([key, value]) => (
          <div key={key}>
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="break-all">{String(value)}</dd>
          </div>
        ))}
      </dl>
      <Badge variant="neutral">node attributes, not edges</Badge>
    </div>
  );
}
