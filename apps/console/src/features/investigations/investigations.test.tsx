import { describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { InvestigationDetailPage } from './InvestigationDetailPage';
import { formatOffset } from './format';

const FOOTAGE_START = '2026-02-14T18:30:00.000Z';

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
    provenance: { capabilityId: 'cap', pipelineVersion: '1.0.0', modelId: 'yolox-nano' },
    ruleSet: [],
    progress: {
      mediaOffsetSeconds: 30,
      framesProcessed: 60,
      throughputFps: 20,
      speedFactor: 9.7,
      etaSeconds: null,
      updatedAt: FOOTAGE_START,
    },
    counts: {
      framesDecoded: 60,
      framesAnalysed: 60,
      framesDropped: 0,
      detections: 120,
      events: 5,
      incidents: 1,
    },
    findings: [],
    requestedBy: 'u',
    createdAt: FOOTAGE_START,
    ...over,
  };
}

function mock(opts: { sessions?: unknown[]; timeline?: Record<string, unknown> } = {}) {
  server.use(
    mswHttp.get('/api/media/analyses/:id', () =>
      HttpResponse.json({
        success: true,
        data: {
          analysis: {
            id: 'ana_1',
            tenantId: 'tnt_a',
            cameraId: 'cam_1',
            cameraName: 'Front Entrance',
            label: 'Tuesday review',
            sourceKind: 'upload',
            state: 'ready',
            footageStartedAt: FOOTAGE_START,
            footageStartSource: 'operator',
            sessionCount: 1,
            createdBy: 'u',
            createdAt: FOOTAGE_START,
            updatedAt: FOOTAGE_START,
          },
          sessions: opts.sessions ?? [session()],
        },
      }),
    ),
    /*
     * ⚠️ P-8.6: the page now fetches the recording itself. Without this handler the player's query
     * fails, which is harmless on screen but fills the test log with MSW warnings that hide real
     * ones — and `expiresAt` has to be in the future or `usePlayback` schedules an immediate refetch.
     */
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
          durationSeconds: 30,
          entries: [{ eventId: 'ev1', type: 'perception.person.detected', occurredAt: FOOTAGE_START, offsetSeconds: 0, label: 'person', confidence: 0.87 }],
          tracks: [],
          density: [],
          incidents: [],
          truncated: false,
          incidentsAvailable: true,
          generatedAt: FOOTAGE_START,
          ...opts.timeline,
        },
      }),
    ),
  );
}

describe('formatOffset', () => {
  /** ⭐ The scrubber's clock: position in the recording, never a time of day. */
  it('reads as a position in the recording', () => {
    expect(formatOffset(0)).toBe('00:00');
    expect(formatOffset(29.5)).toBe('00:29');
    expect(formatOffset(605)).toBe('10:05');
  });
});

describe('Investigation detail', () => {
  /**
   * ⛔ **The most important assertion on this page.** "We could not look" and "we looked and found
   * none" are opposite answers to a customer's question, and an empty incident table would state
   * the second while meaning the first.
   */
  it('says incidents could not be looked up, rather than showing an empty list', async () => {
    mock({ timeline: { incidentsAvailable: false, incidents: [] } });
    renderWithProviders(<InvestigationDetailPage />, { route: '/investigations/ana_1', path: '/investigations/:id' });

    expect(await screen.findByText(/could not be looked up/i)).toBeInTheDocument();
  });

  /**
   * ⛔ A run that examined nothing must never read as a run that found nothing — so its findings
   * are shown beside it rather than tucked away behind a link.
   */
  it('shows a run’s findings next to the run that produced them', async () => {
    mock({
      sessions: [
        session({
          findings: [
            {
              kind: 'assignment-missing',
              detail: '60 of 60 decoded frames (100.0 %) were not analysed: camera has no assignment.',
            },
          ],
        }),
      ],
    });
    renderWithProviders(<InvestigationDetailPage />, { route: '/investigations/ana_1', path: '/investigations/:id' });

    expect(await screen.findByText(/were not analysed/i)).toBeInTheDocument();
  });

  /** ⚠️ `null` renders as "—", never as 0 — "0×" on screen reads as "stalled" (ADR-0039). */
  it('renders an unmeasured speed as a dash, not as zero', async () => {
    mock({
      sessions: [
        session({
          state: 'queued',
          progress: { ...session().progress, speedFactor: null, throughputFps: null },
        }),
      ],
    });
    renderWithProviders(<InvestigationDetailPage />, { route: '/investigations/ana_1', path: '/investigations/:id' });

    /*
     * ⚠️ Scoped to the runs table since P-8.6: the details panel renders "—" for every field the
     * platform did not measure, so a page-wide `findByText('—')` now matches several nodes. Asserting
     * on the SPEED CELL is also the stronger test — it names the column the rule is about, and would
     * still fail if that cell alone regressed to "0.0×".
     */
    const speedCell = (await screen.findAllByRole('row'))
      .map((row) => row.querySelectorAll('td'))
      .find((cells) => cells.length > 0)?.[3];
    expect(speedCell?.textContent).toBe('—');
    expect(screen.queryByText(/0\.0× real time/)).not.toBeInTheDocument();
  });

  /**
   * ⭐ **Demonstration Mode is one parameter, not a second pipeline** (slice 9). `speed: 1` paces the
   * recording so it plays through the *live* runtime, tracker, rules and event path at the rate a
   * camera would produce it — and the 1×/8× parity run is what lets it be offered at all, because it
   * measured the two producing byte-identical event streams.
   */
  it('offers a real-time demonstration alongside the fast analysis', async () => {
    mock();
    renderWithProviders(<InvestigationDetailPage />, { route: '/investigations/ana_1', path: '/investigations/:id' });

    expect(await screen.findByRole('button', { name: /demonstrate at real time/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^run analysis$/i })).toBeInTheDocument();
  });

  /**
   * ⚠️ **What was asked for sits beside what was measured.** A demonstration the host could not keep
   * up with shows "1× real time" as the mode and less than 1.0× as the measurement — which is the
   * honest reading, and the reason both are on screen.
   */
  it('shows the requested mode beside the measured rate', async () => {
    mock({ sessions: [session({ speed: 1 })] });
    renderWithProviders(<InvestigationDetailPage />, { route: '/investigations/ana_1', path: '/investigations/:id' });

    /* ⚠️ `findAllByText` since P-8.6 — the details panel reports the same measured rate. */
    expect(await screen.findByText('1× real time')).toBeInTheDocument();
    expect(screen.getAllByText(/9\.7× real time/).length).toBeGreaterThan(0);
  });

  /** ⛔ A partial timeline says so rather than presenting itself as the whole run. */
  it('states when the timeline was truncated', async () => {
    mock({ timeline: { truncated: true } });
    renderWithProviders(<InvestigationDetailPage />, { route: '/investigations/ana_1', path: '/investigations/:id' });

    expect(await screen.findByText(/Showing the first/i)).toBeInTheDocument();
  });
});
