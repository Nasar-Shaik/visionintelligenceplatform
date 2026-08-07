/**
 * The product surface over the existing pipeline (P-8.6).
 *
 * ⭐ **Every assertion here is about EXPOSURE, not computation.** Each of these values was already
 * being produced and stored before this milestone; the P-8.5 capability audit found them reaching no
 * screen. So these tests fail if a lane, a field or a caveat is dropped from the UI — which is the
 * only way the gap that produced the audit can reopen.
 *
 * ⚠️ **jsdom implements no media element.** `<video>` never loads, `duration` is `NaN` and
 * `timeupdate` never fires, so anything that depends on playback position is asserted in
 * `overlay.test.ts` against values instead. What is asserted here is what renders.
 */
import { describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { InvestigationDetailPage } from './InvestigationDetailPage';

const FOOTAGE_START = '2021-12-22T20:18:44.000Z';
const TRACK = 'trk_cam_1-tnt_a-cam_1-ases_1_7';

/** ⭐ Shaped from the Architect's real 2160×4096 upload, so the fixture is a measurement. */
function analysis(over: Record<string, unknown> = {}) {
  return {
    id: 'ana_1',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    cameraName: 'Front Entrance',
    label: '10622415-uhd_2160_4096_25fps.mp4',
    sourceKind: 'upload',
    state: 'ready',
    footageStartedAt: FOOTAGE_START,
    footageStartSource: 'container-metadata',
    sessionCount: 1,
    asset: {
      key: 'analyses/ana_1/source.mp4',
      originalName: '10622415-uhd_2160_4096_25fps.mp4',
      bytes: 43_359_551,
      contentType: 'video/mp4',
      container: 'mp4',
      codec: 'h264',
      codecTag: 'avc1',
      width: 2160,
      height: 4096,
      sourceFrameRate: 25,
      durationSeconds: 33.28,
    },
    createdBy: 'u',
    createdAt: FOOTAGE_START,
    updatedAt: FOOTAGE_START,
    ...over,
  };
}

function session(over: Record<string, unknown> = {}) {
  return {
    id: 'ases_1',
    tenantId: 'tnt_a',
    analysisId: 'ana_1',
    cameraId: 'cam_1',
    sequence: 1,
    state: 'succeeded',
    analysisFrameRate: 2,
    speed: null,
    provenance: {
      capabilityId: 'perception.person-detection',
      pipelineVersion: '1.0.0',
      runtimeVersion: '0.1.0',
      modelId: 'yolox-nano',
      executionProvider: 'CPUExecutionProvider',
    },
    ruleSet: [],
    progress: {
      mediaOffsetSeconds: 33.5,
      framesProcessed: 67,
      throughputFps: 7.11,
      speedFactor: 3.55,
      etaSeconds: null,
      etaUnavailableReason: 'not enough of the recording has been analysed yet to estimate honestly',
      updatedAt: FOOTAGE_START,
    },
    counts: {
      framesDecoded: 67,
      framesAnalysed: 67,
      framesDropped: 0,
      detections: 285,
      events: 0,
      incidents: 0,
    },
    findings: [],
    requestedBy: 'u',
    createdAt: FOOTAGE_START,
    ...over,
  };
}

function entry(offsetSeconds: number, over: Record<string, unknown> = {}) {
  return {
    eventId: `ev_${String(offsetSeconds)}`,
    type: 'perception.person.detected',
    occurredAt: new Date(Date.parse(FOOTAGE_START) + offsetSeconds * 1000).toISOString(),
    offsetSeconds,
    label: 'person',
    confidence: 0.797689,
    trackId: TRACK,
    bbox: [0.454124, 0.592513, 0.158532, 0.264006],
    ...over,
  };
}

function mock(over: { timeline?: Record<string, unknown>; analysis?: Record<string, unknown> } = {}) {
  server.use(
    mswHttp.get('/api/media/analyses/:id', () =>
      HttpResponse.json({
        success: true,
        data: { analysis: analysis(over.analysis ?? {}), sessions: [session()] },
      }),
    ),
    mswHttp.get('/api/media/analyses/:id/playback', () =>
      HttpResponse.json({
        success: true,
        data: {
          url: 'https://example.invalid/source.mp4?sig=x',
          contentType: 'video/mp4',
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      }),
    ),
    mswHttp.get('/api/media/analyses/:id/timeline', () =>
      HttpResponse.json({
        success: true,
        data: {
          analysisId: 'ana_1',
          sessionId: 'ases_1',
          tenantId: 'tnt_a',
          cameraId: 'cam_1',
          footageStartedAt: FOOTAGE_START,
          durationSeconds: 33.28,
          entries: [entry(0), entry(16, { eventId: 'ev_16' })],
          tracks: [
            {
              trackId: TRACK,
              label: 'person',
              fromOffsetSeconds: 0,
              toOffsetSeconds: 16,
              observations: 2,
              peakConfidence: 0.901,
            },
          ],
          density: [
            { fromOffsetSeconds: 0, toOffsetSeconds: 0.28, count: 6 },
            { fromOffsetSeconds: 0.28, toOffsetSeconds: 0.55, count: 0 },
          ],
          incidents: [
            {
              incidentId: 'inc_1',
              title: 'Person detected — any camera: perception.person.detected',
              status: 'raised',
              severity: 'critical',
              ruleId: 'rule_demo_retail_afterhours',
              ruleName: 'Person detected — any camera',
              ruleVersion: 2,
              triggeredByEventId: 'ev_16',
              matchedCount: 1,
              occurredAt: new Date(Date.parse(FOOTAGE_START) + 16_000).toISOString(),
              offsetSeconds: 16,
            },
          ],
          truncated: false,
          incidentsAvailable: true,
          generatedAt: FOOTAGE_START,
          ...over.timeline,
        },
      }),
    ),
  );
}

function render() {
  renderWithProviders(<InvestigationDetailPage />, {
    route: '/investigations/ana_1',
    path: '/investigations/:id',
  });
}

describe('the recording is on the page', () => {
  /** ⛔ P-8.6 priority 1. Before this, a customer could not watch the file they uploaded. */
  it('renders a video element pointed at the signed source', async () => {
    mock();
    render();
    const player = await screen.findByTestId('analysis-player');
    /* ⚠️ The signed URL is a second request; until it lands the stage renders its offline state. */
    await waitFor(() => expect(player.querySelector('video')).not.toBeNull());
    expect(player.querySelector('video')?.getAttribute('src')).toContain('source.mp4');
  });

  /**
   * ⚠️ **Portrait sources must not be locked into 16:9.** The first real upload was 2160×4096; in
   * `aspect-video` a person renders as a stripe roughly eighty pixels tall, which is useless for the
   * one thing this page exists to do.
   */
  it('gives a portrait recording a portrait stage', async () => {
    mock();
    render();
    const player = await screen.findByTestId('analysis-player');
    await waitFor(() => expect(player.querySelector('.aspect-9\\/16')).not.toBeNull());
  });

  /** ⭐ The toggle the brief asked for, and it starts on. */
  it('offers the detection overlay as a switch', async () => {
    mock();
    render();
    expect(await screen.findByLabelText(/detection overlay/i)).toBeInTheDocument();
  });

  /**
   * ⛔ **The honesty line.** 285 detections were returned and 24 events kept, so most of the
   * recording has no stored box. Without this sentence the gaps read as "the AI saw nothing".
   */
  it('says how many moments actually have a stored detection', async () => {
    mock();
    render();
    expect(await screen.findByText(/gaps are retention, not blindness/i)).toBeInTheDocument();
  });
});

describe('every timeline lane is rendered', () => {
  it('offers incidents, events, tracks and density', async () => {
    mock();
    render();
    const lanes = await screen.findByTestId('timeline-lanes');
    expect(within(lanes).getByRole('tab', { name: /incidents/i })).toBeInTheDocument();
    expect(within(lanes).getByRole('tab', { name: /events/i })).toBeInTheDocument();
    expect(within(lanes).getByRole('tab', { name: /tracks/i })).toBeInTheDocument();
    expect(within(lanes).getByRole('tab', { name: /density/i })).toBeInTheDocument();
  });

  /**
   * ⛔ **The funnel, which is the whole point of showing four lanes rather than one number.**
   * 67 frames → 285 detections → 2 events here; a page showing only the last would let a customer
   * conclude the platform saw two people.
   */
  it('states the funnel from frames to incidents', async () => {
    mock();
    render();
    const funnel = await screen.findByTestId('funnel');
    expect(within(funnel).getByText('285')).toBeInTheDocument();
    expect(within(funnel).getByText('67')).toBeInTheDocument();
  });

  /** ⚠️ Tracks are identities followed, not a headcount, and the page must not imply otherwise. */
  it('refuses to present tracks as a count of people', async () => {
    mock();
    render();
    expect(await screen.findByText(/tracks are not a headcount/i)).toBeInTheDocument();
  });

  /** ⭐ "Which rule created this incident?" — by name and version. */
  it('names the rule and version that raised each incident', async () => {
    mock();
    render();
    /* ⚠️ `getAllBy` — the rule's name is deliberately also inside the incident title. */
    expect((await screen.findAllByText(/Person detected — any camera/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/· v2/)).toBeInTheDocument();
  });

  /** ⭐ "Which events became incidents?" — from `triggeredByEventId`, not a time match. */
  it('marks the event that became an incident', async () => {
    mock();
    render();
    await userEvent.click(await screen.findByRole('tab', { name: /events/i }));
    expect(await screen.findByText('incident')).toBeInTheDocument();
  });

  /** ⭐ Confidence, track and box — the three fields the brief named, all previously unreachable. */
  it('shows confidence, track id and bounding box for every event', async () => {
    mock();
    render();
    await userEvent.click(await screen.findByRole('tab', { name: /events/i }));
    expect((await screen.findAllByText('79.8 %')).length).toBe(2);
    expect(screen.getAllByText('#7').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0\.454, 0\.593, 0\.159, 0\.264/).length).toBeGreaterThan(0);
  });

  /**
   * ⛔ **The brief asked for this in so many words: density is persisted events, not detections.**
   * On the measured run the two numbers are 24 and 285, so a lane captioned "detections" would
   * overstate what the platform kept by roughly twelve to one.
   */
  it('labels the density lane as persisted events and not detections', async () => {
    mock();
    render();
    await userEvent.click(await screen.findByRole('tab', { name: /density/i }));
    const lane = await screen.findByTestId('density-lane');
    expect(within(lane).getByText(/persisted events/i)).toBeInTheDocument();
    /* ⚠️ `<strong>not</strong>` splits the sentence across nodes, so match a contiguous run. */
    expect(within(lane).getByText(/a detection histogram/i)).toBeInTheDocument();
  });

  /**
   * ⚠️ **`observations` is events that survived dedup, not frames the subject was tracked in.** The
   * tracker recorded 56 hits for a span this lane shows as 2 observations; without the caveat the
   * number reads as "seen twice".
   */
  it('warns that observations are not frames', async () => {
    mock();
    render();
    await userEvent.click(await screen.findByRole('tab', { name: /tracks/i }));
    expect(await screen.findByText(/the frames the subject was tracked in/i)).toBeInTheDocument();
  });
});

describe('the analysis details panel', () => {
  /** ⭐ P-8.6 priority 5 — ten asset fields and six provenance fields, three of which were shown. */
  it('shows resolution, codec, size, duration and the whole provenance', async () => {
    mock();
    render();
    const panel = await screen.findByTestId('analysis-details');
    expect(within(panel).getByText('2160 × 4096')).toBeInTheDocument();
    expect(within(panel).getByText('h264 (avc1)')).toBeInTheDocument();
    expect(within(panel).getByText('41.4 MiB')).toBeInTheDocument();
    expect(within(panel).getByText('33.3 s')).toBeInTheDocument();
    expect(within(panel).getByText('yolox-nano')).toBeInTheDocument();
    expect(within(panel).getByText('0.1.0')).toBeInTheDocument();
    expect(within(panel).getByText('CPUExecutionProvider')).toBeInTheDocument();
    expect(within(panel).getByText('7.11 fps')).toBeInTheDocument();
  });

  /**
   * ⛔ **An ETA nobody can estimate is an em dash with the reason beside it, never "0 s"**
   * (ADR-0039). This is the first screen to show `etaUnavailableReason` at all.
   */
  it('explains an unavailable ETA rather than printing a zero', async () => {
    mock();
    render();
    const panel = await screen.findByTestId('analysis-details');
    expect(within(panel).getByText(/not enough of the recording/i)).toBeInTheDocument();
  });

  /**
   * ⛔ **The footage start and how much it can be trusted, together.** Every incident time is an
   * offset from this instant, so an unconfirmed start makes every timestamp below it a claim.
   */
  it('says where the footage start came from', async () => {
    mock();
    render();
    const panel = await screen.findByTestId('analysis-details');
    expect(within(panel).getByText(/read from the file.s own metadata, unconfirmed/i)).toBeInTheDocument();
  });

  /** ⚠️ TD-29 — an `hev1` recording analyses fine and plays on nothing Safari or iOS owns. */
  it('warns about a codec that will not play back everywhere', async () => {
    mock({ analysis: { asset: { ...analysis().asset, codec: 'hevc', codecTag: 'hev1' } } });
    render();
    const panel = await screen.findByTestId('analysis-details');
    expect(within(panel).getByText(/Safari and iOS cannot play this back/i)).toBeInTheDocument();
  });
});

describe('export', () => {
  /** ⭐ P-8.6 priority 6 — the endpoint, the client and the hook all existed; nothing called them. */
  it('offers a download of the run report', async () => {
    mock();
    render();
    /* ⚠️ Disabled until a terminal run exists — the header renders before the detail resolves. */
    const button = await screen.findByRole('button', { name: /export report/i });
    await waitFor(() => expect(button).toBeEnabled());
  });
});

/**
 * ⛔ **Long operations must say they are working** — reported by the Architect during P-8.6: an
 * upload and a run start both changed a label and disabled a button, with no motion and no
 * percentage. A disabled control is indistinguishable from a broken one, and the product accepts
 * files up to 2 GB.
 */
describe('long operations show they are working', () => {
  it('turns Run analysis into a spinner and "Starting…" while the request is in flight', async () => {
    mock();
    /* ⚠️ Never resolves: the assertion is about the PENDING state, which a fast mock would skip. */
    server.use(
      mswHttp.post('/api/media/analyses/:id/sessions', () => new Promise<never>(() => {})),
    );
    render();

    const run = await screen.findByRole('button', { name: /^run analysis$/i });
    await waitFor(() => expect(run).toBeEnabled());
    await userEvent.click(run);

    /* ⚠️ Exactly one — the demonstration button disables but keeps its own label. */
    expect(await screen.findByRole('button', { name: /starting…/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demonstrate at real time/i })).toBeDisabled();
  });

  /**
   * ⭐ A run in flight shows how far through the FOOTAGE it is — `mediaOffsetSeconds` against the
   * recording's duration, both of which the platform has always carried and never displayed.
   */
  it('shows a progress bar for a run that has not finished', async () => {
    mock();
    server.use(
      mswHttp.get('/api/media/analyses/:id', () =>
        HttpResponse.json({
          success: true,
          data: {
            analysis: analysis(),
            sessions: [
              session({
                state: 'running',
                progress: { ...session().progress, mediaOffsetSeconds: 16.64 },
              }),
            ],
          },
        }),
      ),
    );
    render();

    const bar = await screen.findByRole('progressbar', { name: /run #1 progress/i });
    /* 16.64 of 33.28 s — the bar reports the real fraction, not an animation. */
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  /**
   * ⛔ **An unmeasurable stage sweeps rather than sitting at zero** (ADR-0039). A container with no
   * declared duration gives no denominator, and a bar parked at the left edge reads as "stuck".
   */
  it('omits aria-valuenow when progress cannot be computed', async () => {
    mock();
    server.use(
      mswHttp.get('/api/media/analyses/:id', () =>
        HttpResponse.json({
          success: true,
          data: {
            analysis: analysis({ asset: { ...analysis().asset, durationSeconds: 0 } }),
            sessions: [session({ state: 'running' })],
          },
        }),
      ),
    );
    render();

    const bar = await screen.findByRole('progressbar', { name: /run #1 progress/i });
    expect(bar).not.toHaveAttribute('aria-valuenow');
  });
});
