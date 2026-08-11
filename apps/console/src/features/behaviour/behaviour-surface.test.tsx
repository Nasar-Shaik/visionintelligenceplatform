import { describe, expect, it, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AnalysisTimeline } from '@vip/contracts';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { makeStore } from '@/app/store';
import { authenticated } from '@/store/sessionSlice';
import { BehaviourPanel } from './BehaviourPanel';

/**
 * **The behaviour surface, against contract-shaped payloads** (Phase 2.4 slice 2.8).
 *
 * ⛔ Every assertion here compares what is on screen against what the API said. The defect class
 * this surface can produce is not a crash — it is *a screen that states something the runtime did
 * not*: a fact placed on the wrong frame, a truncated answer rendered as a complete one, a
 * confidence that is a coverage measure presented as a probability. None of those throw.
 */

const FOOTAGE_START = '2026-08-05T09:00:00.000Z';
const START_SECONDS = Date.parse(FOOTAGE_START) / 1000;

const analysisTimeline = {
  analysisId: 'ana_1',
  sessionId: 'ases_1',
  tenantId: 'tnt_1',
  cameraId: 'cam_1',
  footageStartedAt: FOOTAGE_START,
  durationSeconds: 30,
  entries: [{ eventId: 'ev_1', trackId: 'trk_a' }],
  tracks: [],
  density: [],
  incidents: [{ incidentId: 'inc_1', title: 'Loitering', offsetSeconds: 12, triggeredByEventId: 'ev_1' }],
  truncated: false,
  incidentsAvailable: true,
  generatedAt: FOOTAGE_START,
} as unknown as AnalysisTimeline;

/** A run in which one person lingered by the till and one gap dominates the count. */
function timelinePayload(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    query: { cameraId: null, streamId: 'ases_1', identityId: null },
    sources: { durable: 1, live: 0 },
    entries: [
      {
        kind: 'zoneEntry',
        identityId: 'trk_a',
        atSeconds: 2,
        footageSeconds: START_SECONDS + 10,
        cameraId: 'cam_1',
        streamId: 'ases_1',
        summary: 'identity trk_a entered zone z_till',
        attributes: { zoneId: 'z_till' },
        evidence: { frameIndex: 20, trackId: 'trk_a' },
      },
      {
        kind: 'linger',
        identityId: 'trk_a',
        atSeconds: 4,
        endSeconds: 19,
        seconds: 15,
        footageSeconds: START_SECONDS + 12,
        cameraId: 'cam_1',
        streamId: 'ases_1',
        summary: 'identity trk_a stayed within 0.08 of the frame for 15 s',
        attributes: { radiusNormalized: 0.08 },
        evidence: { frameIndex: 24, trackId: 'trk_a' },
      },
    ],
    truncated: false,
    relational: { identitiesConsidered: 2, truncated: false, maxIdentities: 32 },
    kinds: ['observed', 'gap', 'linger', 'zoneEntry'],
    countsByKind: { gap: 1207, linger: 1, zoneEntry: 1 },
    kindsRequested: [],
    excludedByKind: 0,
    ...overrides,
  };
}

const graphPayload = {
  enabled: true,
  graph: {
    nodes: [
      { id: 'trk_a', kind: 'identity', label: 'person', attributes: { lingerSeconds: 15 } },
      { id: 'trk_b', kind: 'identity', label: 'person', attributes: {} },
      { id: 'z_till', kind: 'zone', label: 'z_till', attributes: {} },
    ],
    edges: [
      {
        id: 'eg_1',
        kind: 'visited',
        source: 'trk_a',
        target: 'z_till',
        atSeconds: START_SECONDS + 10,
        endSeconds: START_SECONDS + 25,
        seconds: 15,
        attributes: {},
        evidence: { frameIndex: 20, trackId: 'trk_a' },
      },
      {
        id: 'eg_2',
        kind: 'near',
        source: 'trk_a',
        target: 'trk_b',
        atSeconds: START_SECONDS + 11,
        attributes: {},
        evidence: { frameIndex: 22, trackId: 'trk_a' },
      },
    ],
    counts: { nodes: 3, edges: 2, byNodeKind: {}, byEdgeKind: {} },
    originSeconds: START_SECONDS + 8,
    truncated: { nodes: false, edges: false, relational: false, identitiesConsidered: 2, maxIdentities: 32 },
  },
};

const primitivesPayload = {
  enabled: true,
  primitives: {
    task: 'behaviour',
    modules: ['motion', 'zone'],
    identities: { trk_a: { lingerSeconds: 15 } },
    scene: [],
    zoneMembership: 'present',
    lineGeometry: 'absent',
    observedIntervalSeconds: 30,
    readings: {
      linger: {
        mechanism: 'stationary_episodes',
        radiusNormalized: 0.08,
        minSeconds: 15,
        means: 'stayed within 8% of the frame width for at least 15 s',
      },
    },
    relational: { identitiesConsidered: 2, truncated: false, maxIdentities: 32 },
    moduleFailures: {},
  },
};

function signedIn() {
  const store = makeStore();
  store.dispatch(
    authenticated({
      user: { id: 'u1', email: 'a@b.c', displayName: 'A' },
      tenantId: 'tnt_1',
      permissions: ['track:read', 'rule:read'],
    } as never),
  );
  return store;
}

function mountPanel(onSeek = vi.fn()) {
  return {
    onSeek,
    ...renderWithProviders(
      <BehaviourPanel
        streamId="ases_1"
        analysisTimeline={analysisTimeline}
        durationSeconds={30}
        onSeek={onSeek}
        enabled
      />,
      { store: signedIn() },
    ),
  };
}

beforeEach(() => {
  server.use(
    http.get('/api/behaviour/timeline', ({ request }) => {
      const kinds = new URL(request.url).searchParams.get('kinds');
      if (kinds === null) return HttpResponse.json({ success: true, data: timelinePayload() });
      const wanted = kinds.split(',');
      const payload = timelinePayload();
      return HttpResponse.json({
        success: true,
        data: {
          ...payload,
          entries: payload.entries.filter((e) => wanted.includes(e.kind)),
          kindsRequested: wanted,
          excludedByKind: payload.entries.filter((e) => !wanted.includes(e.kind)).length,
        },
      });
    }),
    http.get('/api/behaviour/graph', () => HttpResponse.json({ success: true, data: graphPayload })),
    http.get('/api/behaviour/primitives', () =>
      HttpResponse.json({ success: true, data: primitivesPayload }),
    ),
    http.get('/api/track-history', () =>
      HttpResponse.json({
        success: true,
        data: {
          enabled: true,
          records: [
            {
              identityId: 'trk_a',
              tenantId: 'tnt_1',
              cameraId: 'cam_1',
              streamId: 'ases_1',
              label: 'person',
              trackIds: ['trk_a'],
              closed: true,
              zoneVersion: 3,
              points: [
                /* ⛔ The runtime's own encoding: `zoneIds` present ⇒ decided, absent ⇒ never decided. */
                { frameIndex: 20, at: '2026-08-05T09:00:10.000Z', bbox: [0.1, 0.1, 0.1, 0.2], trackId: 'trk_a', label: 'person', confidence: 0.9, zoneIds: ['z_till'] },
                { frameIndex: 24, at: '2026-08-05T09:00:12.000Z', bbox: [0.3, 0.2, 0.1, 0.2], trackId: 'trk_a', label: 'person', confidence: 0.7, zoneIds: ['z_till'] },
                { frameIndex: 30, at: '2026-08-05T09:00:15.000Z', bbox: [0.5, 0.3, 0.1, 0.2], trackId: 'trk_a', label: 'person', confidence: 0.8 },
              ],
            },
          ],
          live: [],
        },
      }),
    ),
  );
});

describe('the behaviour timeline', () => {
  it('renders each fact with its evidence and the runtime’s own sentence', async () => {
    mountPanel();
    const rows = await screen.findAllByTestId('behaviour-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByTestId('evidence-tag')).toHaveTextContent('frame');
  });

  /**
   * ⛔ **The seek arithmetic, end to end.** The fact is at footage second `start + 12` and the
   * recording starts at `start`, so the player must go to 12 s — not to `atSeconds` (4), which is
   * measured from the run's first observation and would land eight seconds early.
   */
  it('seeks the player to the frame the fact came from, not to its run offset', async () => {
    const { onSeek } = mountPanel();
    const rows = await screen.findAllByTestId('behaviour-row');
    const linger = rows.find((r) => r.getAttribute('data-kind') === 'linger')!;
    const seek = within(linger).getByTestId('behaviour-seek');
    expect(seek).toHaveAttribute('data-basis', 'footage-clock');
    await userEvent.click(seek);
    expect(onSeek).toHaveBeenCalledWith(12);
    expect(onSeek).not.toHaveBeenCalledWith(4);
  });

  /**
   * ⛔ **The state the browser certification tripped over, pinned deterministically here.**
   *
   * A fact whose footage instant falls outside this recording is **unplaceable**: the control is
   * disabled, `data-offset` is empty, and clicking does nothing. That is correct and deliberate —
   * seeking to 0 or to the nearest frame would put an operator on a frame where the thing being
   * explained is not happening, with the same confidence as a correct seek.
   *
   * ⚠️ It is asserted here, at a tier with no timing in it, because the end-to-end test read
   * `data-offset` unconditionally: `Number('')` is **0**, so an unplaceable first fact made the
   * suite fail intermittently depending on which facts a run happened to produce.
   */
  it('disables the seek for a fact that does not fall inside this recording', async () => {
    server.use(
      http.get('/api/behaviour/timeline', () =>
        HttpResponse.json({
          success: true,
          data: timelinePayload({
            entries: [
              {
                kind: 'zoneEntry',
                identityId: 'trk_a',
                atSeconds: 2,
                /* ⚠️ An hour past the end of a 30 s recording — neither reading lands inside it. */
                footageSeconds: START_SECONDS + 3600,
                cameraId: 'cam_1',
                streamId: 'ases_1',
                summary: 'identity trk_a entered zone z_till',
                attributes: { zoneId: 'z_till' },
                evidence: { frameIndex: 20, trackId: 'trk_a' },
              },
            ],
          }),
        }),
      ),
    );
    const { onSeek } = mountPanel();
    const rows = await screen.findAllByTestId('behaviour-row');
    const seek = within(rows[0]!).getByTestId('behaviour-seek');

    expect(seek).toHaveAttribute('data-basis', 'unplaceable');
    expect(seek).toBeDisabled();
    /* ⛔ Empty, never "0" — a zero here reads as "the start of the recording", which is a claim. */
    expect(seek).toHaveAttribute('data-offset', '');
    await userEvent.click(seek);
    expect(onSeek).not.toHaveBeenCalled();
  });

  /** ⭐ The count is the whole run's, not the page's — which is what makes the cap visible. */
  it('reports what the whole run produced, including the kinds it did not return', async () => {
    mountPanel();
    expect(await screen.findByText(/1209 fact\(s\) across 3 kind\(s\)/)).toBeInTheDocument();
    expect(screen.getByTestId('kind-filter-gap')).toHaveTextContent('1207');
  });

  /**
   * ⛔ Filtering must re-ask the runtime. A browser-side filter cannot recover a fact the runtime's
   * cap already dropped, and this asserts the request actually carries the selection.
   */
  it('sends the kind selection to the runtime rather than filtering what arrived', async () => {
    const asked: string[] = [];
    server.use(
      http.get('/api/behaviour/timeline', ({ request }) => {
        const kinds = new URL(request.url).searchParams.get('kinds');
        if (kinds !== null) asked.push(kinds);
        return HttpResponse.json({ success: true, data: timelinePayload() });
      }),
    );
    mountPanel();
    await userEvent.click(await screen.findByTestId('kind-filter-linger'));
    await waitFor(() => expect(asked).toContain('linger'));
  });

  it('expands a fact into its attributes and its absolute footage clock', async () => {
    mountPanel();
    const rows = await screen.findAllByTestId('behaviour-row');
    await userEvent.click(within(rows[0]!).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('behaviour-row-detail');
    expect(detail).toHaveTextContent('Footage clock');
    expect(detail).toHaveTextContent('entered zone z_till');
  });

  /** ⛔ A truncated answer must never render as a complete one. */
  it('says so when the runtime capped the answer', async () => {
    server.use(
      http.get('/api/behaviour/timeline', () =>
        HttpResponse.json({ success: true, data: timelinePayload({ truncated: true }) }),
      ),
    );
    mountPanel();
    expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(/stops early/);
  });

  /** ⛔ The more dangerous truncation: a complete-looking scene in which nothing social happened. */
  it('says so when the scene was capped', async () => {
    server.use(
      http.get('/api/behaviour/timeline', () =>
        HttpResponse.json({
          success: true,
          data: timelinePayload({
            relational: { identitiesConsidered: 32, truncated: true, maxIdentities: 32 },
          }),
        }),
      ),
    );
    mountPanel();
    expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
      /their absence below means nothing/,
    );
  });

  /** ⛔ "The runtime keeps no history" and "nobody did anything" are opposite facts. */
  it('distinguishes a runtime that stores nothing from a quiet run', async () => {
    server.use(
      http.get('/api/behaviour/timeline', () =>
        HttpResponse.json({
          success: true,
          data: { enabled: false, detail: 'track history is not enabled on this runtime', entries: [] },
        }),
      ),
    );
    mountPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('track history is not enabled');
  });
});

describe('the behaviour graph', () => {
  it('draws the nodes and bundles repeated relations', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    await screen.findByTestId('behaviour-graph-svg');
    expect(screen.getAllByTestId('graph-node')).toHaveLength(3);
    expect(screen.getByTestId('graph-counts')).toHaveTextContent('3/3 nodes');
  });

  /**
   * ⛔ The defect that shipped once, one layer up: a graph edge's `atSeconds` is the absolute
   * footage clock, so rendering it directly says "at 1786221387.294 s".
   */
  it('renders an edge’s instant as an offset from the run, never as the footage clock', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    const edges = await screen.findAllByTestId('graph-edge');
    await userEvent.click(edges[0]!);
    const detail = await screen.findByTestId('graph-edge-detail');
    /* origin is start+8, the edge is at start+10 or start+11 → 2.0 s or 3.0 s */
    expect(detail.textContent).toMatch(/[23]\.0 s/);
    expect(detail.textContent).not.toMatch(/17859\d{5}/);
  });

  it('narrows to one subject when a node is clicked, and says the counts are still the whole graph', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Graph' }));
    const nodes = await screen.findAllByTestId('graph-node');
    const till = nodes.find((n) => n.getAttribute('data-node-id') === 'z_till')!;
    await userEvent.click(till);
    await waitFor(() => expect(screen.getByTestId('graph-counts')).toHaveTextContent('/3 nodes'));
  });
});

describe('identity history', () => {
  it('draws a trajectory, the zones observed and the DETECTOR’s confidence', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Identity' }));
    await userEvent.click(await screen.findByRole('button', { name: 'trk_a' }));
    expect(await screen.findByTestId('identity-trajectory')).toBeInTheDocument();
    /* ⛔ Labelled as the detector's — a primitive has no probability attached to it. */
    expect(screen.getByText('Detector confidence')).toBeInTheDocument();
    expect(screen.getByText(/80% mean \(70–90%\)/)).toBeInTheDocument();
  });

  /** ⛔ Undecided membership is reported separately: it is not "outside". */
  it('separates observations whose zone membership was never decided', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Identity' }));
    await userEvent.click(await screen.findByRole('button', { name: 'trk_a' }));
    expect(await screen.findByText(/2 settled · 1 never decided/)).toBeInTheDocument();
  });

  it('attributes an incident through its recorded trigger', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Identity' }));
    await userEvent.click(await screen.findByRole('button', { name: 'trk_a' }));
    expect(await screen.findByTestId('identity-incident')).toHaveTextContent('Loitering');
  });

  it('seeks from a point on the trajectory', async () => {
    const { onSeek } = mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Identity' }));
    await userEvent.click(await screen.findByRole('button', { name: 'trk_a' }));
    const points = await screen.findAllByTestId('trajectory-point');
    await userEvent.click(points[0]!);
    expect(onSeek).toHaveBeenCalledWith(10);
  });
});

describe('the primitive inspector', () => {
  /** ⭐ The thresholds the business word was computed at, published by the runtime and rendered. */
  it('shows the parameters and the plain-English meaning beside each primitive', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
    const rows = await screen.findAllByTestId('primitive-row');
    const linger = rows.find((r) => r.getAttribute('data-kind') === 'linger')!;
    expect(linger).toHaveTextContent('stationary_episodes');
    expect(linger).toHaveTextContent('Radius Normalized 0.08');
    expect(linger).toHaveTextContent('Min Seconds 15');
  });

  /** ⛔ An inert primitive family is stated. "Nobody crossed a line" is a different answer. */
  it('says when a primitive family was inert rather than empty', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
    expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
      /No line geometry reached this read/,
    );
  });

  /*
   * ⭐ **The association diagnostic** (slice 2.10). ⛔ `AssociationModule` ran on every frame for
   * three milestones with nothing to associate, and the console rendered exactly what it renders
   * for a scene where nobody carried anything: an empty list. Each reason below is a different
   * situation that produces that same emptiness, and only one of them is the product working.
   */
  describe('the association diagnostic', () => {
    const withDiagnostic = (diagnostic: Record<string, unknown>) =>
      server.use(
        http.get('/api/behaviour/primitives', () =>
          HttpResponse.json({
            success: true,
            data: {
              ...primitivesPayload,
              primitives: { ...primitivesPayload.primitives, associationDiagnostic: diagnostic },
            },
          }),
        ),
      );

    const base = {
      subjects: 1,
      objects: 0,
      objectLabels: [],
      notCarriable: 0,
      notCarriableLabels: [],
      framesTogether: 0,
      unjoinedObjectPoints: 0,
      pairsNear: 0,
      thresholdNormalized: 0.05,
      spans: 0,
    };

    it('says the detector returned nothing carriable, rather than showing an empty list', async () => {
      withDiagnostic({ ...base, reason: 'no-objects-detected' });
      mountPanel();
      await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
      expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
        /the detector returned nothing a person could be carrying/i,
      );
    });

    /** ⛔ A tracked car is not the same absence as an empty frame, and must not read as one. */
    it('names the objects it excluded as things nobody carries', async () => {
      withDiagnostic({ ...base, notCarriable: 1, notCarriableLabels: ['car'], reason: 'no-carriable-objects' });
      mountPanel();
      await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
      expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
        /1 object\(s\) were tracked \(car\) and none is a thing a person carries/i,
      );
    });

    /** ⚠️ The silent one: a timestamp join, not a distance. */
    it('distinguishes a timing failure from a distance failure', async () => {
      withDiagnostic({ ...base, objects: 1, objectLabels: ['handbag'], unjoinedObjectPoints: 12, reason: 'never-observed-together' });
      mountPanel();
      await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
      expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
        /timing problem rather than a distance one/i,
      );
    });

    /** ⭐ How far the scene was from associating — the number that separates "nearly" from "not at all". */
    it('reports the closest approach against the threshold', async () => {
      withDiagnostic({
        ...base,
        objects: 1,
        objectLabels: ['handbag'],
        framesTogether: 30,
        closestNormalized: 0.32,
        reason: 'never-close-enough',
      });
      mountPanel();
      await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
      expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
        /closest they ever came was 32.0% of the frame width against a threshold of 5.0%/i,
      );
    });

    /** ⚠️ Reported on a SUCCESSFUL run too: silence about the excluded car would mislead. */
    it('still names an excluded object when the run did associate', async () => {
      withDiagnostic({
        ...base,
        objects: 1,
        objectLabels: ['handbag'],
        notCarriable: 1,
        notCarriableLabels: ['car'],
        framesTogether: 30,
        pairsNear: 1,
        spans: 1,
      });
      mountPanel();
      await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
      expect(await screen.findByTestId('behaviour-incompleteness')).toHaveTextContent(
        /excluded from carrying because nobody carries one \(car\)/i,
      );
    });

    /** ⛔ A run that associated and has nothing to explain says nothing about association. */
    it('says nothing when a span was produced and nothing was excluded', async () => {
      withDiagnostic({ ...base, objects: 1, objectLabels: ['handbag'], framesTogether: 30, pairsNear: 1, spans: 1 });
      mountPanel();
      await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
      const notes = await screen.findByTestId('behaviour-incompleteness');
      expect(notes).not.toHaveTextContent(/association/i);
    });
  });

  it('opens a primitive into its instances, each with a frame', async () => {
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Primitives' }));
    const rows = await screen.findAllByTestId('primitive-row');
    await userEvent.click(rows.find((r) => r.getAttribute('data-kind') === 'linger')!);
    const instances = await screen.findAllByTestId('primitive-instance');
    expect(instances[0]!).toHaveTextContent('frame 24');
  });
});

describe('the reasoning chain', () => {
  const candidate = {
    ruleId: 'rule_console_draft',
    ruleVersion: 1,
    ruleName: 'Sequence I am investigating',
    label: 'Matched the sequence',
    severity: 'medium',
    identityId: 'trk_a',
    cameraId: 'cam_1',
    fromSeconds: 2,
    toSeconds: 19,
    footageFromSeconds: START_SECONDS + 10,
    footageToSeconds: START_SECONDS + 27,
    confidence: 1,
    summary: 'trk_a was inside z_till at 2.0 s, then lingered for 15 s at 4.0 s',
    chain: [
      {
        index: 0,
        step: { kind: 'visited', absent: false, zoneId: 'z_till' },
        matched: true,
        reason: 'was inside zone z_till from 2.0 s for 15.0 s',
        atSeconds: 2,
        seconds: 15,
        footageAtSeconds: START_SECONDS + 10,
        edgeId: 'eg_1',
        evidence: { frameIndex: 20, trackId: 'trk_a' },
      },
      {
        index: 1,
        step: { kind: 'carried', absent: true },
        matched: true,
        reason: 'never carried anything',
        considered: 0,
        evidence: {},
      },
    ],
  };

  function withEvaluation(body: Record<string, unknown> = {}) {
    server.use(
      http.post('/api/rules/rules/behaviour/evaluate', () =>
        HttpResponse.json({
          success: true,
          data: {
            rulesEvaluated: 1,
            identitiesEvaluated: 2,
            candidates: [candidate],
            graphTruncated: { nodes: false, edges: false, relational: false, identitiesConsidered: 2 },
            elapsedMs: 42,
            ...body,
          },
        }),
      ),
    );
  }

  it('renders the WHY chain, every link clickable back to a frame', async () => {
    withEvaluation();
    const { onSeek } = mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    await userEvent.click(await screen.findByTestId('evaluate-rule'));

    const links = await screen.findAllByTestId('chain-link');
    expect(links).toHaveLength(2);
    await userEvent.click(within(links[0]!).getByTestId('behaviour-seek'));
    expect(onSeek).toHaveBeenCalledWith(10);
  });

  /** ⛔ It says candidate, and it keeps saying candidate. */
  it('never calls a match an incident', async () => {
    withEvaluation();
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    await userEvent.click(await screen.findByTestId('evaluate-rule'));
    const card = await screen.findByTestId('candidate');
    expect(card).toHaveTextContent('candidate');
    expect(card.textContent?.toLowerCase()).not.toContain('incident');
  });

  /** ⚠️ Confidence is a coverage measure and is labelled as one wherever it appears. */
  it('labels confidence as evidence coverage and says it is not a probability', async () => {
    withEvaluation();
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    await userEvent.click(await screen.findByTestId('evaluate-rule'));
    expect(await screen.findByTestId('candidate-confidence')).toHaveTextContent('evidence coverage 100%');
    expect(screen.getByText(/not a probability that the label is true/)).toBeInTheDocument();
  });

  /**
   * ⛔ The strength of an absence is the search behind it. "0 facts of that kind were examined" and
   * "seven were checked and none was the till" both satisfy the step; only one is worth acting on.
   */
  it('shows how much an absent step actually examined', async () => {
    withEvaluation();
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    await userEvent.click(await screen.findByTestId('evaluate-rule'));
    expect(await screen.findByTestId('absence-strength')).toHaveTextContent(
      '0 fact(s) of that kind were examined',
    );
  });

  /** ⛔ A 503 is a refusal, and it must never render as "no candidates". */
  it('reports a graph that could not be read, rather than an empty result', async () => {
    server.use(
      http.post('/api/rules/rules/behaviour/evaluate', () =>
        HttpResponse.json(
          { success: false, error: { code: 'graph-unavailable', message: 'the behaviour graph did not answer within 5000 ms' } },
          { status: 503 },
        ),
      ),
    );
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    await userEvent.click(await screen.findByTestId('evaluate-rule'));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer within 5000 ms');
    expect(screen.queryByTestId('no-candidates')).not.toBeInTheDocument();
  });

  it('distinguishes “nothing matched” from “nothing was asked”', async () => {
    withEvaluation({ candidates: [] });
    mountPanel();
    await userEvent.click(screen.getByRole('tab', { name: 'Reasoning' }));
    await userEvent.click(await screen.findByTestId('evaluate-rule'));
    expect(await screen.findByTestId('no-candidates')).toHaveTextContent(
      /a step whose kind never occurs .* can never match/,
    );
  });
});

describe('a run that is not finished', () => {
  /** ⚠️ A partial run's behaviour changes under the reader, so it is not presented as an answer. */
  it('says why there is nothing to show rather than showing an empty surface', () => {
    renderWithProviders(
      <BehaviourPanel
        streamId="ases_1"
        analysisTimeline={analysisTimeline}
        onSeek={vi.fn()}
        enabled={false}
      />,
      { store: signedIn() },
    );
    expect(screen.getByText(/Run the analysis to the end/)).toBeInTheDocument();
  });
});

/**
 * ⛔ **The six evidence states, on screen** (Evidence Integrity, EI-4).
 *
 * Five of them used to render identically: an empty timeline, which an operator reads as *nothing
 * happened*. That is right in exactly one of the five. These assert the three that mean something
 * went wrong are impossible to miss, and — just as importantly — that the two ordinary ones stay
 * quiet, because a banner on every read is furniture nobody sees.
 */
describe('the evidence state', () => {
  const withEvidence = (evidence: Record<string, unknown>) => {
    server.use(
      http.get('/api/behaviour/timeline', () =>
        HttpResponse.json({ success: true, data: { ...timelinePayload(), evidence } }),
      ),
    );
  };

  it('says so, loudly, when evidence was lost', async () => {
    withEvidence({
      state: 'lost',
      detail: '2 identity(ies) were retired but could not be written to durable storage: idn_a, idn_b.',
      durable: 0,
      live: 0,
      records: 0,
      damagedRecords: 0,
      lostIdentities: ['idn_a', 'idn_b'],
    });
    mountPanel();
    const note = await screen.findByTestId('evidence-state');
    expect(note).toHaveAttribute('data-state', 'lost');
    /* ⛔ `alert`, not `status`: a destroyed movement path is not an aside. */
    expect(note).toHaveAttribute('role', 'alert');
    expect(note).toHaveTextContent('idn_a');
  });

  it('says so when stored records could not be read', async () => {
    withEvidence({
      state: 'corrupted',
      detail: '1 stored record(s) for this query could not be read. 4 were readable and are shown.',
      durable: 4,
      live: 0,
      records: 4,
      damagedRecords: 1,
    });
    mountPanel();
    const note = await screen.findByTestId('evidence-state');
    expect(note).toHaveAttribute('data-state', 'corrupted');
    expect(note).toHaveAttribute('role', 'alert');
  });

  it('distinguishes a run still in progress from a finished one', async () => {
    /* ⚠️ Not a fault — a lower bound. Amber and `status`, never `alert`. */
    withEvidence({
      state: 'notYetAvailable',
      detail: '3 identity(ies) are still being observed, so this answer is incomplete.',
      durable: 1,
      live: 3,
      records: 4,
      damagedRecords: 0,
    });
    mountPanel();
    const note = await screen.findByTestId('evidence-state');
    expect(note).toHaveAttribute('data-state', 'notYetAvailable');
    expect(note).toHaveAttribute('role', 'status');
  });

  it('explains an empty answer that retention caused', async () => {
    /* ⭐ A kept promise. The operator must not read it as a defect, nor as "nothing happened". */
    withEvidence({
      state: 'expired',
      detail: 'this run finished at 2026-08-01T09:00:00Z, before the retention horizon.',
      durable: 0,
      live: 0,
      records: 0,
      damagedRecords: 0,
    });
    mountPanel();
    const note = await screen.findByTestId('evidence-state');
    expect(note).toHaveAttribute('data-state', 'expired');
    expect(note).toHaveTextContent('retention horizon');
  });

  it('stays silent on a complete read', async () => {
    /* ⚠️ The negative control, and it is the one that keeps the other four legible. */
    withEvidence({
      state: 'present',
      detail: '4 stored movement path(s) answered this query, complete and closed.',
      durable: 4,
      live: 0,
      records: 4,
      damagedRecords: 0,
    });
    mountPanel();
    await screen.findAllByTestId('behaviour-row');
    expect(screen.queryByTestId('evidence-state')).not.toBeInTheDocument();
  });

  it('stays silent when there is genuinely nothing to report', async () => {
    withEvidence({
      state: 'absent',
      detail: 'no stored movement path matches this query.',
      durable: 0,
      live: 0,
      records: 0,
      damagedRecords: 0,
    });
    mountPanel();
    await screen.findAllByTestId('behaviour-row');
    expect(screen.queryByTestId('evidence-state')).not.toBeInTheDocument();
  });
});
