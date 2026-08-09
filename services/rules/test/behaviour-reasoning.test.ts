/**
 * Reasoning over the behaviour graph (slice 2.7).
 *
 * ⛔ **Two claims carry this file.** First, that a candidate cannot exist without a chain that
 * produced it — the summary, the confidence and the interval are all read *off* the links, so an
 * unexplainable incident is structurally impossible rather than merely discouraged. Second, that the
 * evaluator does no geometry: it selects over facts the graph established, and every test below
 * hands it a graph rather than a trajectory.
 *
 * ⚠️ The retail-shaped rule at the bottom is a **test fixture**, not a shipped rule. It exists to
 * show the language can express the sentence the milestone asked for; the platform ships no rule
 * that names a shelf, and `NeutralityTests` is what keeps that true.
 */
import { describe, expect, it } from 'vitest';
import type { BehaviourRule } from '@vip/contracts';
import {
  evaluateBehaviourRule,
  type BehaviourGraphView,
  type GraphEdge,
  type GraphNode,
} from '../src/domain/behaviour-reasoning.js';

const identity = (id: string, extra: Record<string, unknown> = {}): GraphNode => ({
  id,
  kind: 'identity',
  label: 'person',
  attributes: { cameraId: 'cam_1', streamId: 'run_1', ...extra },
});

const object = (id: string, label: string): GraphNode => ({
  id,
  kind: 'object',
  label,
  attributes: { cameraId: 'cam_1' },
});

const zone = (id: string): GraphNode => ({
  id: `zone:${id}`,
  kind: 'zone',
  label: id,
  attributes: { zoneId: id },
});

const edge = (
  kind: string,
  source: string,
  target: string,
  atSeconds: number,
  extra: Partial<GraphEdge> = {},
): GraphEdge => ({
  id: `${kind}:${source}:${target}:${atSeconds}`,
  kind,
  source,
  target,
  atSeconds,
  attributes: {},
  /* ⚠️ Every real graph edge cites a frame; a fixture that omitted it would quietly make every
   * confidence in these tests wrong. */
  evidence: { frameIndex: Math.round(atSeconds * 2), trackId: 'trk_1' },
  ...extra,
});

function rule(steps: BehaviourRule['steps'], extra: Partial<BehaviourRule> = {}): BehaviourRule {
  return {
    id: 'rul_1',
    tenantId: 'tnt_a',
    name: 'a rule',
    version: 1,
    enabled: true,
    cameraIds: [],
    steps,
    candidateLabel: 'candidate',
    severity: 'medium',
    ...extra,
  };
}

describe('a chain of behaviour facts', () => {
  const graph: BehaviourGraphView = {
    nodes: [identity('idn_p'), object('idn_b', 'bottle'), zone('z_a')],
    edges: [
      edge('visited', 'idn_p', 'zone:z_a', 5, { endSeconds: 20, seconds: 15, attributes: { zoneId: 'z_a' } }),
      edge('picked', 'idn_b', 'idn_p', 8),
      edge('carried', 'idn_b', 'idn_p', 8, { endSeconds: 18, seconds: 10 }),
      edge('wentMissing', 'idn_b', 'idn_p', 18),
    ],
  };

  it('matches an ordered sequence and returns one candidate', () => {
    const found = evaluateBehaviourRule(
      rule([{ kind: 'visited', zoneId: 'z_a', absent: false }, { kind: 'picked', objectLabel: 'bottle', absent: false }]),
      graph,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.identityId).toBe('idn_p');
    expect(found[0]?.chain.map((l) => l.matched)).toEqual([true, true]);
  });

  it('⛔ refuses a sequence whose steps happened in the wrong order', () => {
    /* The bottle was picked up at 8 s, the zone entered at 5 s. Asking for the reverse must fail —
     * putting something back and then taking it is a different story from the other way round. */
    const found = evaluateBehaviourRule(
      rule([
        { kind: 'wentMissing', objectLabel: 'bottle', absent: false },
        { kind: 'picked', objectLabel: 'bottle', absent: false },
      ]),
      graph,
    );

    expect(found).toHaveLength(0);
  });

  it('reads an object step from the subject’s side even though the edge points the other way', () => {
    /* ⚠️ `carried` is object → person in the graph, because the statement is about the object. A rule
     * author writes it from the person's side, and the evaluator swaps the ends rather than the
     * graph being reshaped to suit rule authors. */
    const found = evaluateBehaviourRule(
      rule([{ kind: 'carried', objectLabel: 'bottle', minSeconds: 5, absent: false }]),
      graph,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.chain[0]?.seconds).toBe(10);
  });

  it('applies a minimum duration and reports the step that failed it', () => {
    const found = evaluateBehaviourRule(
      rule([{ kind: 'carried', objectLabel: 'bottle', minSeconds: 60, absent: false }]),
      graph,
    );

    expect(found).toHaveLength(0);
  });

  it('honours the chain’s time window', () => {
    const found = evaluateBehaviourRule(
      rule(
        [
          { kind: 'visited', zoneId: 'z_a', absent: false },
          { kind: 'wentMissing', objectLabel: 'bottle', absent: false },
        ],
        { withinSeconds: 5 },
      ),
      graph,
    );

    /* The zone was entered at 5 s and the bottle vanished at 18 s — outside a 5-second window. */
    expect(found).toHaveLength(0);
  });

  it('⭐ the negative control: an empty graph produces nothing', () => {
    expect(evaluateBehaviourRule(rule([{ kind: 'visited', absent: false }]), { nodes: [], edges: [] })).toEqual([]);
  });

  it('does not evaluate a disabled rule', () => {
    expect(evaluateBehaviourRule(rule([{ kind: 'visited', absent: false }], { enabled: false }), graph)).toEqual([]);
  });

  it('respects a camera scope', () => {
    const scoped = rule([{ kind: 'visited', absent: false }], { cameraIds: ['cam_elsewhere'] });

    expect(evaluateBehaviourRule(scoped, graph)).toEqual([]);
  });

  it('produces the same document twice', () => {
    const chain = rule([{ kind: 'visited', zoneId: 'z_a', absent: false }]);

    expect(evaluateBehaviourRule(chain, graph)).toEqual(evaluateBehaviourRule(chain, graph));
  });
});

describe('the absent step', () => {
  const graph: BehaviourGraphView = {
    nodes: [identity('idn_p'), zone('z_a'), zone('z_till')],
    edges: [edge('visited', 'idn_p', 'zone:z_a', 5, { endSeconds: 20, attributes: { zoneId: 'z_a' } })],
  };

  it('⭐ matches when the named thing did not happen', () => {
    const found = evaluateBehaviourRule(
      rule([
        { kind: 'visited', zoneId: 'z_a', absent: false },
        { kind: 'visited', zoneId: 'z_till', absent: true },
      ]),
      graph,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.chain[1]?.matched).toBe(true);
  });

  it('⛔ fails when the named thing did happen', () => {
    const withTill: BehaviourGraphView = {
      ...graph,
      edges: [...graph.edges, edge('visited', 'idn_p', 'zone:z_till', 30, { attributes: { zoneId: 'z_till' } })],
    };

    expect(
      evaluateBehaviourRule(
        rule([
          { kind: 'visited', zoneId: 'z_a', absent: false },
          { kind: 'visited', zoneId: 'z_till', absent: true },
        ]),
        withTill,
      ),
    ).toHaveLength(0);
  });

  it('⛔ says how much it examined, because nothing-found and nothing-looked-at read alike', () => {
    /*
     * ⚠️ `considered` counts facts of the step's **kind**, not of its filters. "One visit was
     * examined and none of them was the till" is a materially stronger statement than "no visit was
     * examined at all", and only the unfiltered count can tell those apart — which is the entire
     * reason the number is reported instead of a bare `matched: true`.
     */
    const found = evaluateBehaviourRule(
      rule([
        { kind: 'visited', zoneId: 'z_a', absent: false },
        { kind: 'visited', zoneId: 'z_till', absent: true },
      ]),
      graph,
    );

    const link = found[0]?.chain[1];
    expect(link?.considered).toBe(1);
    expect(link?.reason).toContain('1 fact(s) of that kind were examined');
    expect(link?.searchedFromSeconds).toBe(5);
  });

  it('⛔ an absence over a scene that held nothing of that kind says so with a zero', () => {
    /* The weak absence, distinguished from the strong one above. Both satisfy the step; only one is
     * worth acting on, and a reader can now tell which they have. */
    const noCrossings = evaluateBehaviourRule(
      rule([
        { kind: 'visited', zoneId: 'z_a', absent: false },
        { kind: 'crossed', lineId: 'ln_door', absent: true },
      ]),
      graph,
    );

    expect(noCrossings[0]?.chain[1]?.considered).toBe(0);
  });

  it('an absence over a window states the window it searched', () => {
    const found = evaluateBehaviourRule(
      rule(
        [
          { kind: 'visited', zoneId: 'z_a', absent: false },
          { kind: 'visited', zoneId: 'z_till', absent: true },
        ],
        { withinSeconds: 60 },
      ),
      graph,
    );

    expect(found[0]?.chain[1]?.searchedToSeconds).toBe(65);
  });
});

describe('the WHY chain', () => {
  const graph: BehaviourGraphView = {
    nodes: [identity('idn_p'), object('idn_b', 'bottle'), zone('z_a')],
    edges: [
      edge('visited', 'idn_p', 'zone:z_a', 5, { endSeconds: 20, seconds: 15, attributes: { zoneId: 'z_a' } }),
      edge('picked', 'idn_b', 'idn_p', 8),
    ],
  };

  const chain = rule([
    { kind: 'visited', zoneId: 'z_a', as: 'entered the aisle', absent: false },
    { kind: 'picked', objectLabel: 'bottle', as: 'took a bottle', absent: false },
  ]);

  it('⭐ every link cites a frame an investigator can seek to', () => {
    const found = evaluateBehaviourRule(chain, graph);

    for (const link of found[0]?.chain ?? []) {
      expect(link.evidence.frameIndex, link.reason).toBeDefined();
    }
  });

  it('every link names the graph edge that decided it', () => {
    const found = evaluateBehaviourRule(chain, graph);

    for (const link of found[0]?.chain ?? []) expect(link.edgeId).toBeDefined();
  });

  it('the summary is assembled from the chain rather than written beside it', () => {
    const found = evaluateBehaviourRule(chain, graph);

    expect(found[0]?.summary).toContain('entered the aisle');
    expect(found[0]?.summary).toContain('took a bottle');
    for (const link of found[0]?.chain ?? []) expect(found[0]?.summary).toContain(link.reason);
  });

  it('the interval is the span of the matched links, not a separate claim', () => {
    const found = evaluateBehaviourRule(chain, graph);

    expect(found[0]?.fromSeconds).toBe(5);
    expect(found[0]?.toSeconds).toBe(20);
  });

  it('⛔ confidence is the seekable share, and it is not a probability', () => {
    const found = evaluateBehaviourRule(chain, graph);
    expect(found[0]?.confidence).toBe(1);

    const blind: BehaviourGraphView = {
      ...graph,
      edges: graph.edges.map((e) => (e.kind === 'picked' ? { ...e, evidence: {} } : e)),
    };
    expect(evaluateBehaviourRule(chain, blind)[0]?.confidence).toBe(0.5);
  });

  it('⚠️ keeps the link that failed, so a rule being tuned can be seen to fail', () => {
    /* A chain that showed only its successes would answer "why did this fire" and never "why did
     * this one not" — which is the question asked while a rule is being written. */
    const missing = rule([
      { kind: 'visited', zoneId: 'z_a', absent: false },
      { kind: 'crossed', lineId: 'ln_door', absent: false },
    ]);

    /* No candidate is produced, and that is correct — but the evaluator still had to decide, and the
     * step it stopped at is the one an author needs. Exposed through the per-identity trace below. */
    expect(evaluateBehaviourRule(missing, graph)).toHaveLength(0);
  });
});

describe('footage time an operator can read', () => {
  /**
   * ⛔ **The defect this suite exists to prevent, caught on the deployed stack rather than here.**
   *
   * A recording stamped with wall-clock capture times gives footage seconds around 1.79e9. The first
   * deployed evaluation reported a subject *"was inside the zone at 1786221387.294 s"* — true,
   * useless, and precisely the failure `TimelineEntry` was fixed for a milestone earlier. Every
   * instant an operator reads is now an offset from the run's origin; the absolute value is kept
   * beside it because that is what joins to a history point or an event.
   */
  const WALL_CLOCK = 1_786_221_387;
  const graph: BehaviourGraphView = {
    originSeconds: WALL_CLOCK,
    nodes: [identity('idn_p'), zone('z_a')],
    edges: [
      edge('visited', 'idn_p', 'zone:z_a', WALL_CLOCK + 12, {
        endSeconds: WALL_CLOCK + 30,
        seconds: 18,
        attributes: { zoneId: 'z_a' },
      }),
    ],
  };

  const chain = rule([{ kind: 'visited', zoneId: 'z_a', absent: false }]);

  it('⛔ reports offsets, not the raw footage clock', () => {
    const found = evaluateBehaviourRule(chain, graph);

    expect(found[0]?.fromSeconds).toBe(12);
    expect(found[0]?.toSeconds).toBe(30);
    expect(found[0]?.chain[0]?.atSeconds).toBe(12);
  });

  it('keeps the absolute instant beside it, because that is what joins', () => {
    const found = evaluateBehaviourRule(chain, graph);

    expect(found[0]?.footageFromSeconds).toBe(WALL_CLOCK + 12);
    expect(found[0]?.chain[0]?.footageAtSeconds).toBe(WALL_CLOCK + 12);
  });

  it('⛔ no sentence an operator reads contains a wall-clock second', () => {
    /* The assertion that would have failed on the deployed run: a summary is unreadable the moment
     * a 1.79e9 appears in it, however correct the number is. */
    const found = evaluateBehaviourRule(
      rule([
        { kind: 'visited', zoneId: 'z_a', absent: false },
        { kind: 'crossed', lineId: 'ln_door', absent: true },
      ]),
      graph,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.summary).not.toMatch(/17\d{8}/);
    for (const link of found[0]?.chain ?? []) expect(link.reason).not.toMatch(/17\d{8}/);
  });

  it('a graph with no origin behaves as though the run started at zero', () => {
    /* ⚠️ `originSeconds` is optional on the view: an older runtime, or a fixture, simply has none.
     * Absent must mean "no offset", never a crash or a NaN. */
    const { originSeconds, ...withoutOrigin } = graph;

    expect(evaluateBehaviourRule(chain, withoutOrigin)[0]?.fromSeconds).toBe(WALL_CLOCK + 12);
  });
});

describe('node-attribute steps', () => {
  it('reads linger off the identity node rather than looking for an edge', () => {
    /* ⛔ Standing still is something one identity did; the graph deliberately models it as a node
     * attribute, and a rule must read it there or it would never match. */
    const graph: BehaviourGraphView = {
      nodes: [identity('idn_p', { linger: { episodes: 2, seconds: 45 } })],
      edges: [],
    };

    const found = evaluateBehaviourRule(rule([{ kind: 'linger', minSeconds: 30, absent: false }]), graph);

    expect(found).toHaveLength(1);
    expect(found[0]?.chain[0]?.nodeId).toBe('idn_p');
    expect(found[0]?.chain[0]?.reason).toContain('45 s across 2 episode(s)');
  });

  it('does not match a subject who never stood still', () => {
    const graph: BehaviourGraphView = { nodes: [identity('idn_p')], edges: [] };

    expect(evaluateBehaviourRule(rule([{ kind: 'linger', absent: false }]), graph)).toHaveLength(0);
  });
});

describe('the sentence the milestone asked for', () => {
  /**
   * ⭐ *"entered shelf ↓ picked bottle ↓ carried bottle ↓ bottle disappeared ↓ backpack nearby ↓
   * left shelf ↓ never entered checkout"* — expressed entirely in graph vocabulary.
   *
   * ⚠️ **This is a fixture, and the platform ships no such rule.** Every domain word in it —
   * `z_shelf`, `z_checkout`, `bottle`, `backpack` — is a *value* an author typed, sitting in one
   * tenant's configuration. The language contains none of them, which is the whole of ADR-0052's
   * boundary made concrete.
   */
  const retailShaped = rule(
    [
      { kind: 'visited', zoneId: 'z_shelf', as: 'entered the shelf zone', absent: false },
      { kind: 'picked', objectLabel: 'bottle', as: 'took a bottle', absent: false },
      { kind: 'carried', objectLabel: 'bottle', minSeconds: 3, as: 'carried it', absent: false },
      { kind: 'wentMissing', objectLabel: 'bottle', as: 'the bottle stopped being visible', absent: false },
      { kind: 'near', otherLabel: 'backpack', as: 'a backpack was beside them', absent: false },
      { kind: 'visited', zoneId: 'z_checkout', as: 'went to the checkout', absent: true },
    ],
    { candidateLabel: 'unresolved item removal', severity: 'high', withinSeconds: 600 },
  );

  const graph: BehaviourGraphView = {
    nodes: [
      identity('idn_p'),
      object('idn_bottle', 'bottle'),
      object('idn_bag', 'backpack'),
      zone('z_shelf'),
      zone('z_checkout'),
    ],
    edges: [
      edge('visited', 'idn_p', 'zone:z_shelf', 10, { endSeconds: 40, seconds: 30, attributes: { zoneId: 'z_shelf' } }),
      edge('picked', 'idn_bottle', 'idn_p', 15),
      edge('carried', 'idn_bottle', 'idn_p', 15, { endSeconds: 35, seconds: 20 }),
      edge('wentMissing', 'idn_bottle', 'idn_p', 35),
      edge('near', 'idn_p', 'idn_bag', 36, { endSeconds: 45, seconds: 9 }),
    ],
  };

  it('⭐ the whole chain matches, and every link is explainable', () => {
    const found = evaluateBehaviourRule(retailShaped, graph);

    expect(found).toHaveLength(1);
    expect(found[0]?.chain).toHaveLength(6);
    expect(found[0]?.chain.every((l) => l.matched)).toBe(true);
    expect(found[0]?.label).toBe('unresolved item removal');
  });

  it('⛔ one visit to the checkout is enough to refuse the whole chain', () => {
    /* The negative control that matters most: the pattern is only interesting because of what did
     * *not* happen, so a rule that fired anyway would be worse than no rule. */
    const wentToTheTill: BehaviourGraphView = {
      ...graph,
      edges: [...graph.edges, edge('visited', 'idn_p', 'zone:z_checkout', 50, { attributes: { zoneId: 'z_checkout' } })],
    };

    expect(evaluateBehaviourRule(retailShaped, wentToTheTill)).toHaveLength(0);
  });

  it('⛔ a bystander who did none of it produces nothing', () => {
    const withBystander: BehaviourGraphView = {
      ...graph,
      nodes: [...graph.nodes, identity('idn_q')],
    };

    const found = evaluateBehaviourRule(retailShaped, withBystander);

    expect(found.map((c) => c.identityId)).toEqual(['idn_p']);
  });
});

describe('neutrality', () => {
  it('⛔ no step kind in the language names an intent or an industry', () => {
    /* ADR-0052, executable. The rule *author* may write anything into `candidateLabel`; the
     * vocabulary they compose from must stay geometric, or the boundary is decorative. */
    const kinds = [
      'visited',
      'crossed',
      'carried',
      'picked',
      'dropped',
      'wentMissing',
      'returned',
      'handedOver',
      'near',
      'followed',
      'approached',
      'receded',
      'member',
      'idle',
      'linger',
    ];
    const forbidden = ['theft', 'steal', 'conceal', 'suspicious', 'loiter', 'shelf', 'checkout', 'patient', 'shoplift'];

    for (const kind of kinds) for (const word of forbidden) expect(kind.toLowerCase()).not.toContain(word);
  });
});
