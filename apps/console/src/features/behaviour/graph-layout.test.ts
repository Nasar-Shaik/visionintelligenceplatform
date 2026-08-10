import { describe, expect, it } from 'vitest';
import type { BehaviourGraphEdge, BehaviourGraphNode } from '@vip/contracts';
import { bundle, layoutGraph } from './graph-layout';

const node = (id: string, kind: string, label = kind): BehaviourGraphNode => ({
  id,
  kind,
  label,
  attributes: {},
});

const edge = (
  id: string,
  kind: string,
  source: string,
  target: string,
  atSeconds: number,
  endSeconds?: number,
): BehaviourGraphEdge => ({
  id,
  kind,
  source,
  target,
  atSeconds,
  ...(endSeconds === undefined ? {} : { endSeconds, seconds: endSeconds - atSeconds }),
  attributes: {},
  evidence: { frameIndex: Math.round(atSeconds), trackId: source },
});

describe('bundling repeated relations', () => {
  it('groups edges of one kind between one pair, keeping every underlying fact', () => {
    const bundles = bundle([
      edge('e1', 'near', 'a', 'b', 10, 12),
      edge('e2', 'near', 'a', 'b', 20, 23),
      edge('e3', 'near', 'a', 'b', 5, 6),
    ]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.count).toBe(3);
    /* ⚠️ Time-ordered, so the span is the real one rather than the arrival order's. */
    expect(bundles[0]!.firstAtSeconds).toBe(5);
    expect(bundles[0]!.lastAtSeconds).toBe(23);
    expect(bundles[0]!.edges.map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
  });

  /**
   * ⛔ `followed(a → b)` and `followed(b → a)` are different claims about two people. Collapsing
   * them into one undirected line would state something neither edge says.
   */
  it('keeps direction', () => {
    const bundles = bundle([edge('e1', 'followed', 'a', 'b', 1), edge('e2', 'followed', 'b', 'a', 2)]);
    expect(bundles).toHaveLength(2);
  });

  it('keeps different relations between one pair apart', () => {
    const bundles = bundle([edge('e1', 'near', 'a', 'b', 1), edge('e2', 'followed', 'a', 'b', 2)]);
    expect(bundles.map((b) => b.kind).sort()).toEqual(['followed', 'near']);
  });
});

describe('laying the graph out', () => {
  const graph = {
    nodes: [
      node('i1', 'identity', 'person'),
      node('i2', 'identity', 'person'),
      node('z_till', 'zone', 'z_till'),
      node('o1', 'object', 'bottle'),
    ],
    edges: [
      edge('e1', 'visited', 'i1', 'z_till', 1, 5),
      edge('e2', 'near', 'i1', 'i2', 2, 4),
      edge('e3', 'carried', 'i1', 'o1', 3, 8),
    ],
  };

  it('places places left, people centre and things right', () => {
    const layout = layoutGraph(graph);
    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.x;
    expect(x('z_till')).toBeLessThan(x('i1'));
    expect(x('i1')).toBeLessThan(x('o1'));
  });

  /** ⚠️ The same graph must draw the same picture twice — a screenshot in a report is evidence. */
  it('is deterministic', () => {
    expect(layoutGraph(graph)).toEqual(layoutGraph(graph));
  });

  it('reports shown against total for nodes and edges', () => {
    const layout = layoutGraph(graph, { maxNodes: 2 });
    expect(layout.nodesTotal).toBe(4);
    expect(layout.nodesShown).toBe(2);
    expect(layout.edgesTotal).toBe(3);
    /* ⚠️ A line to a node that was capped away points at nothing, so it is not drawn. */
    expect(layout.edgesShown).toBeLessThan(3);
  });

  it('keeps the most-connected nodes when it has to drop some', () => {
    const layout = layoutGraph(graph, { maxNodes: 1 });
    expect(layout.nodes.map((n) => n.id)).toEqual(['i1']);
  });

  it('narrows to one subject and its neighbours when focused', () => {
    const layout = layoutGraph(graph, { focus: 'i2' });
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(['i1', 'i2']);
    /* ⛔ The counts still describe the whole graph — a narrowed view must not read as the picture. */
    expect(layout.nodesTotal).toBe(4);
    expect(layout.edgesTotal).toBe(3);
  });

  it('answers for an absent graph without throwing', () => {
    const layout = layoutGraph(undefined);
    expect(layout.nodesTotal).toBe(0);
    expect(layout.edges).toEqual([]);
  });

  it('counts how many lines stand for more than one fact', () => {
    const repeated = {
      nodes: [node('i1', 'identity'), node('i2', 'identity')],
      edges: [edge('e1', 'near', 'i1', 'i2', 1), edge('e2', 'near', 'i1', 'i2', 5)],
    };
    const layout = layoutGraph(repeated);
    expect(layout.edgesShown).toBe(1);
    expect(layout.edgesTotal).toBe(2);
    expect(layout.bundles).toBe(1);
  });
});
