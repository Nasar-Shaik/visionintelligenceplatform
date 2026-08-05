/**
 * Tracking pages (P-8 Phase 4).
 *
 * ⚠️ **Most of these drive an absence, not a presence.** The rule the whole feature is built on is
 * that a measurement which does not exist must render as "Not measured" and never as `0` — and a
 * suite that only ever feeds populated payloads is satisfied equally well by a page that hard-codes
 * zeros. So the cases below feed missing motion, null averages, tracking switched off and an
 * unreachable runtime, and assert the **words an operator reads**.
 *
 * The other half asserts the identity contract as it reaches the screen: a re-entered track shows a
 * NEW id linked to the old one, and the timeline still shows that it was lost.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { LiveTracksPage } from './LiveTracksPage';
import { TrackDetailPage } from './TrackDetailPage';
import { TrackTimelinePage } from './TrackTimelinePage';
import { TrackStatisticsPage } from './TrackStatisticsPage';
import type { Track, TrackingStats } from './useTracking';

function authAs(roles: string[]) {
  store.dispatch(
    authenticated({
      user: { id: 'usr_me', email: 'op@northgate.demo', roles },
      tenantId: 'tnt_demo_retail',
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

const STATS: TrackingStats = {
  camerasTracked: 2,
  activeTracks: 3,
  confirmedTracks: 2,
  tentativeTracks: 1,
  lostTracks: 0,
  removedTracks: 5,
  createdTracks: 8,
  recoveredTracks: 1,
  framesTracked: 400,
  outOfOrderFrames: 0,
  averageTrackingMs: 0.42,
  averageTrackLifetimeSeconds: 12.5,
  averageTrackHits: 9.3,
  averageTrackAgeFrames: 11.0,
  fragmentation: 1.33,
  occlusionsSurvived: 4,
  crossings: 2,
  reentryOpportunities: 3,
  identitySwitches: null,
  reidentificationSuccessRate: null,
  falseRecoveries: null,
  groundTruth: {
    available: false,
    reason: 'these ask whether an identity was CORRECT, which needs ground truth.',
    metrics: ['identitySwitches', 'reidentificationSuccessRate', 'falseRecoveries'],
    measuredBy: 'docs/review/p8/tracking.mjs',
  },
};

const CAMERA_ROW = {
  cameraId: 'cam_1',
  tracking: true,
  activeTracks: 2,
  confirmedTracks: 2,
  lostTracks: 0,
  createdTracks: 5,
  removedTracks: 3,
  recoveredTracks: 1,
  occlusionsSurvived: 2,
  crossings: 1,
  framesTracked: 240,
  outOfOrderFrames: 0,
  trackingFps: 1.98,
  averageTrackingMs: 0.13,
};

const ENGINE = {
  enabled: true,
  associator: 'predictive-iou',
  minIou: 0.3,
  minIouLost: 0.45,
  minHits: 2,
  maxAgeFrames: 8,
  historyMax: 50,
  reentryGapSeconds: 12,
  reentryDistance: 0.35,
};

function track(over: Partial<Track> = {}): Track {
  return {
    schemaVersion: '1.1',
    trackId: 'trk_cam_1_live_7',
    tenantId: 'tnt_demo_retail',
    cameraId: 'cam_1',
    label: 'person',
    state: 'confirmed',
    confidence: 0.91,
    bbox: [0.3, 0.4, 0.1, 0.2],
    centroid: [0.35, 0.5],
    firstSeen: { frameIndex: 1, at: '2026-08-05T09:00:00.000Z' },
    lastSeen: { frameIndex: 20, at: '2026-08-05T09:00:10.000Z' },
    age: 19,
    hits: 18,
    quality: { predictionFrames: 0, lostFrames: 0 },
    history: [
      {
        frameIndex: 1,
        at: '2026-08-05T09:00:00.000Z',
        bbox: [0.1, 0.4, 0.1, 0.2],
        centroid: [0.15, 0.5],
      },
      {
        frameIndex: 10,
        at: '2026-08-05T09:00:05.000Z',
        bbox: [0.2, 0.4, 0.1, 0.2],
        centroid: [0.25, 0.5],
      },
      {
        frameIndex: 20,
        at: '2026-08-05T09:00:10.000Z',
        bbox: [0.3, 0.4, 0.1, 0.2],
        centroid: [0.35, 0.5],
      },
    ],
    motion: {
      durationSeconds: 10,
      pathLengthNormalized: 0.2,
      displacementNormalized: 0.2,
      averageSpeedNormalized: 0.02,
      currentSpeedNormalized: 0.02,
      dwellSeconds: 0,
      samples: 3,
      headingDegrees: 0,
      headingLabel: 'right',
      straightness: 1,
    },
    identityId: 'trk_cam_1_live_7',
    recoveries: 0,
    attributes: {},
    ...over,
  };
}

function mockList(body: unknown, status = 200) {
  server.use(
    mswHttp.get('/api/tracking/tracks', () =>
      status === 200
        ? HttpResponse.json({ success: true, data: body })
        : HttpResponse.json({ success: false, error: { code: 'x', message: 'no' } }, { status }),
    ),
  );
}

function mockOverview(body: unknown) {
  server.use(mswHttp.get('/api/tracking', () => HttpResponse.json({ success: true, data: body })));
}

function mockCameras(body: unknown) {
  server.use(
    mswHttp.get('/api/tracking/cameras', () => HttpResponse.json({ success: true, data: body })),
  );
}

function mockDetail(body: unknown, status = 200) {
  server.use(
    mswHttp.get('/api/tracking/tracks/:trackId', () =>
      status === 200
        ? HttpResponse.json({ success: true, data: body })
        : HttpResponse.json(
            { success: false, error: { code: 'not_found', message: 'gone' } },
            { status },
          ),
    ),
  );
}

describe('Live Tracks', () => {
  it('lists what is being followed, with the unit on the speed', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    mockList({ tracks: [track()], stats: STATS });
    renderWithProviders(<LiveTracksPage />, { store });

    expect(await screen.findByText('person')).toBeInTheDocument();
    expect(screen.getByText('cam_1')).toBeInTheDocument();
    /* ⚠️ "fw/s", never a bare number — a bare speed on a CCTV page reads as m/s. */
    expect(screen.getByText('0.020 fw/s')).toBeInTheDocument();
  });

  it('⚠️ renders "Not measured" for a track with no motion yet, never 0', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    const seenOnce = track();
    delete (seenOnce as Partial<Track>).motion;
    mockList({ tracks: [seenOnce], stats: STATS });
    renderWithProviders(<LiveTracksPage />, { store });

    await screen.findByText('person');
    expect(screen.getAllByText('Not measured').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('0.000 fw/s')).not.toBeInTheDocument();
  });

  it('⚠️ says tracking is OFF rather than showing an empty table', async () => {
    authAs(['operator']);
    mockOverview({ enabled: false, detail: 'object tracking is not enabled on this runtime' });
    mockList({ tracks: [], stats: STATS });
    renderWithProviders(<LiveTracksPage />, { store });

    expect(await screen.findByText('Tracking is not enabled here')).toBeInTheDocument();
  });

  it('⚠️ distinguishes an unreachable runtime from a quiet one', async () => {
    authAs(['operator']);
    mockOverview({ enabled: false, unreachable: true, detail: 'fetch failed (ECONNREFUSED)' });
    mockList({ tracks: [] });
    renderWithProviders(<LiveTracksPage />, { store });

    expect(await screen.findByText('The runtime is not answering')).toBeInTheDocument();
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
  });

  it('⚠️ a quiet site is its own state, and says recording is unaffected nowhere near it', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: { ...STATS, activeTracks: 0 } });
    mockList({ tracks: [], stats: { ...STATS, activeTracks: 0 } });
    renderWithProviders(<LiveTracksPage />, { store });

    expect(await screen.findByText('Nothing is being tracked')).toBeInTheDocument();
  });

  it('marks a re-entered identity in the list', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    mockList({
      tracks: [
        track({ trackId: 'trk_new', precededBy: 'trk_old', identityId: 'trk_old', recoveries: 1 }),
      ],
      stats: STATS,
    });
    renderWithProviders(<LiveTracksPage />, { store });

    expect(await screen.findByText('re-entered ×1')).toBeInTheDocument();
  });

  it('filters by state', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    let lastUrl = '';
    server.use(
      mswHttp.get('/api/tracking/tracks', ({ request }) => {
        lastUrl = request.url;
        return HttpResponse.json({ success: true, data: { tracks: [track()], stats: STATS } });
      }),
    );
    renderWithProviders(<LiveTracksPage />, { store });
    await screen.findByText('person');
    await userEvent.click(screen.getByRole('button', { name: 'lost' }));
    await waitFor(() => expect(lastUrl).toContain('state=lost'));
  });

  it('refuses a role without track:read', async () => {
    authAs([]);
    renderWithProviders(<LiveTracksPage />, { store });
    expect(await screen.findByText('Not authorized')).toBeInTheDocument();
  });
});

describe('Track Detail', () => {
  const renderDetail = (id = 'trk_cam_1_live_7') =>
    renderWithProviders(<TrackDetailPage />, {
      store,
      route: `/tracking/${id}`,
      path: '/tracking/:trackId',
    });

  it('shows duration, travelled distance and dwell with their units', async () => {
    authAs(['operator']);
    mockDetail({ track: track(), timeline: [] });
    renderDetail();

    expect(await screen.findByText('10.0s')).toBeInTheDocument();
    /* Travelled appears twice — as a headline and again under Movement. Both must carry the unit. */
    expect(screen.getAllByText('0.200 fw').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Path length in frame widths/)).toBeInTheDocument();
  });

  it('⚠️ calls dwell geometry, and the only time it says "loitering" is to deny it', async () => {
    authAs(['operator']);
    mockDetail({ track: track(), timeline: [] });
    const { container } = renderDetail();
    await screen.findByText('Dwell');
    const text = container.textContent ?? '';
    expect(text).toMatch(/Geometry only/);
    /*
     * ⚠️ The word may appear once, in the negation. What must never appear is dwell *labelled* as
     * loitering — that is a business judgement, it belongs to the Rule Engine, and the Rule Engine
     * does not exist yet. So: every occurrence is preceded by "not".
     */
    const mentions = text.match(/loiter\w*/gi) ?? [];
    expect(mentions).toHaveLength(1);
    expect(text).toMatch(/not loitering/i);
  });

  it('⚠️ shows the re-entry link AND states that it is not proof of identity', async () => {
    authAs(['operator']);
    mockDetail({
      track: track({
        trackId: 'trk_new',
        precededBy: 'trk_old',
        identityId: 'trk_old',
        recoveries: 1,
      }),
      timeline: [],
    });
    renderDetail('trk_new');

    expect(await screen.findByText('This identity was re-entered')).toBeInTheDocument();
    expect(screen.getByText(/not on appearance/)).toBeInTheDocument();
    expect(screen.getByText(/strong hint, not as proof/)).toBeInTheDocument();
  });

  it('⚠️ a track that ended is a plain answer with a way back, not an error', async () => {
    authAs(['operator']);
    mockDetail(null, 404);
    renderDetail();
    expect(await screen.findByText('That track has ended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to live tracks/ })).toBeInTheDocument();
  });

  it('⚠️ draws the path with no video frame behind it, and says why', async () => {
    authAs(['operator']);
    mockDetail({ track: track(), timeline: [] });
    renderDetail();
    expect(await screen.findByRole('img', { name: /Path of person/ })).toBeInTheDocument();
    expect(
      screen.getByText(/evidence is never cached outside approved storage/),
    ).toBeInTheDocument();
  });

  it('says so when there are too few points to draw a path', async () => {
    authAs(['operator']);
    mockDetail({ track: track({ history: [] }), timeline: [] });
    renderDetail();
    expect(await screen.findByText(/Not enough observations/)).toBeInTheDocument();
  });
});

describe('Track Timeline', () => {
  const renderTimeline = (id = 'trk_cam_1_live_7') =>
    renderWithProviders(<TrackTimelinePage />, {
      store,
      route: `/tracking/${id}/timeline`,
      path: '/tracking/:trackId/timeline',
    });

  it('⚠️ keeps the `lost` transition after a recovery — the entry that changes the meaning', async () => {
    authAs(['operator']);
    mockDetail({
      track: track(),
      timeline: [
        { frameIndex: 1, at: '2026-08-05T09:00:00.000Z', from: null, to: 'created' },
        { frameIndex: 3, at: '2026-08-05T09:00:01.500Z', from: 'created', to: 'confirmed' },
        { frameIndex: 9, at: '2026-08-05T09:00:04.500Z', from: 'confirmed', to: 'lost' },
        { frameIndex: 14, at: '2026-08-05T09:00:07.000Z', from: 'lost', to: 'confirmed' },
      ],
    });
    renderTimeline();

    expect(await screen.findByText('Confirmed → Lost')).toBeInTheDocument();
    expect(screen.getByText('Lost → Confirmed')).toBeInTheDocument();
  });

  it('links back to the earlier identity in the chain', async () => {
    authAs(['operator']);
    mockDetail({
      track: track({ trackId: 'trk_new', precededBy: 'trk_old' }),
      timeline: [{ frameIndex: 1, at: '2026-08-05T09:00:00.000Z', from: null, to: 'created' }],
    });
    renderTimeline('trk_new');

    expect(await screen.findByText('Before this track')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'trk_old' })).toBeInTheDocument();
  });
});

describe('Track Statistics', () => {
  it('reports identity, cost and the engine', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    renderWithProviders(<TrackStatisticsPage />, { store });

    expect(await screen.findByText('predictive-iou')).toBeInTheDocument();
    expect(screen.getByText('0.42 ms')).toBeInTheDocument();
    expect(screen.getByText('1.33')).toBeInTheDocument();
  });

  it('⚠️ every derived average reads "Not measured" when nothing has been tracked', async () => {
    authAs(['operator']);
    mockOverview({
      enabled: true,
      engine: ENGINE,
      stats: {
        ...STATS,
        camerasTracked: 0,
        activeTracks: 0,
        confirmedTracks: 0,
        createdTracks: 0,
        framesTracked: 0,
        averageTrackingMs: null,
        averageTrackLifetimeSeconds: null,
        averageTrackHits: null,
        averageTrackAgeFrames: null,
        fragmentation: null,
      },
    });
    renderWithProviders(<TrackStatisticsPage />, { store });

    await screen.findByText('predictive-iou');
    expect(screen.getAllByText('Not measured')).toHaveLength(5);
    expect(screen.queryByText('0.00 ms')).not.toBeInTheDocument();
  });

  it('⚠️ states that fragmentation is not accuracy, on the page and not in a tooltip', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    renderWithProviders(<TrackStatisticsPage />, { store });

    expect(await screen.findByText(/Fragmentation is not accuracy/)).toBeInTheDocument();
    expect(
      screen.getByText(/needs ground truth about who was actually in frame/),
    ).toBeInTheDocument();
  });

  it('⚠️ exposes no control that configures the engine', async () => {
    authAs(['admin']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    mockCameras({ cameras: [CAMERA_ROW] });
    const { container } = renderWithProviders(<TrackStatisticsPage />, { store });
    await screen.findByText('predictive-iou');
    /*
     * Camera Processing Assignment and tracker tuning are deployment settings, not operator
     * controls. A page that offered a slider backed by nothing would be worse than one that offers
     * nothing at all — DEFINITION_OF_DONE, "no UI configures functionality that is not implemented".
     * ⚠️ The per-camera table makes this MORE important, not less: a per-camera row invites an
     * enable switch, and that switch is Camera Processing Assignment, which is not built.
     */
    await screen.findByText('cam_1');
    expect(container.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    expect(screen.getByText(/Reported, not editable/)).toBeInTheDocument();
  });

  it('⚠️ shows the three ground-truth metrics as "Not measurable" with the reason', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    renderWithProviders(<TrackStatisticsPage />, { store });

    /*
     * ⚠️ ADR-0039. These must be VISIBLE and unavailable, not omitted: an absent row and a metric
     * whose exporter is broken look identical, and an operator cannot tell which they have.
     */
    expect(await screen.findByText('Identity switches')).toBeInTheDocument();
    expect(screen.getByText('Re-identification success')).toBeInTheDocument();
    expect(screen.getByText('False recoveries')).toBeInTheDocument();
    expect(screen.getAllByText('Not measurable')).toHaveLength(3);
    expect(screen.getByText(/absent, never zero/i)).toBeInTheDocument();
    /* Two places say it: the fragmentation note and the ground-truth card. Both should. */
    expect(screen.getAllByText(/needs ground truth/i).length).toBeGreaterThanOrEqual(1);
    /* And a zero must never appear in their place. */
    expect(screen.queryByText('0 switches')).not.toBeInTheDocument();
  });

  it('⚠️ shows a runtime that reports a number it declared unmeasurable, rather than hiding it', async () => {
    authAs(['operator']);
    /*
     * ⚠️ The defect a mutation found. This card used to hard-code "Not measurable" for every row, so
     * a runtime reporting `identitySwitches: 0` changed nothing on screen — the page covered up a
     * contract violation and the browser verification stayed green. A page whose job is to report
     * runtime truth must not decide in advance what the truth is.
     */
    mockOverview({
      enabled: true,
      engine: ENGINE,
      stats: { ...STATS, identitySwitches: 0 },
    });
    renderWithProviders(<TrackStatisticsPage />, { store });

    await screen.findByText('Identity switches');
    expect(screen.getAllByText('Not measurable')).toHaveLength(2);
    expect(screen.getByText(/contract violation/i)).toBeInTheDocument();
  });

  it('⚠️ counts occlusions absorbed separately from re-entries', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    renderWithProviders(<TrackStatisticsPage />, { store });

    /* The two mechanisms are different: one kept the track id, the other minted a new one. */
    expect(await screen.findByText('Occlusions absorbed')).toBeInTheDocument();
    expect(screen.getByText(/came back with the SAME track id/)).toBeInTheDocument();
    expect(screen.getByText('Crossings')).toBeInTheDocument();
    expect(screen.getByText(/opportunity for a swap, not evidence of one/)).toBeInTheDocument();
  });

  it('lists per-camera metrics', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    mockCameras({ cameras: [CAMERA_ROW, { ...CAMERA_ROW, cameraId: 'cam_2', createdTracks: 9 }] });
    renderWithProviders(<TrackStatisticsPage />, { store });

    expect(await screen.findByText('cam_1')).toBeInTheDocument();
    expect(screen.getByText('cam_2')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getAllByText('1.98')).toHaveLength(2);
  });

  it('⚠️ marks a quiet camera as idle rather than showing it as a dead one', async () => {
    authAs(['operator']);
    mockOverview({ enabled: true, engine: ENGINE, stats: STATS });
    mockCameras({
      cameras: [{ ...CAMERA_ROW, tracking: false, activeTracks: 0, trackingFps: null }],
    });
    renderWithProviders(<TrackStatisticsPage />, { store });

    /*
     * ⚠️ Under Camera Processing Assignment this becomes the ordinary state of a camera whose AI is
     * switched off. Its counters are history — a row that just showed zeros would read as a fault.
     */
    expect(await screen.findByText(/counts are history/)).toBeInTheDocument();
    expect(screen.getByText('Not measured')).toBeInTheDocument();
  });
});
