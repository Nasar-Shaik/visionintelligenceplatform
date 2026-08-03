/**
 * P-5.5 — evidence playback.
 *
 * These test the **claims the surface makes**, not the pixels: a control the media cannot perform
 * is never offered, a gap is drawn to scale rather than closed up, an adjusted view is marked
 * `Enhanced` and a redacted copy outranks that marking, a still image does not get a scrubber, and
 * a deployment with no bookmark store says so instead of showing an empty list.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http as mswHttp, HttpResponse } from 'msw';
import type { PlaybackSession } from '@vip/contracts';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { EvidencePlayer } from './EvidencePlayer';
import { PlaybackTimeline } from './PlaybackTimeline';
import { tickStep } from './scale';
import { sessionStaleTime } from './usePlayback';
import { EvidenceSelectionProvider } from './selection';
import { PlaybackPanel } from './panels';

const START = '2026-08-03T09:00:00.000Z';

function session(overrides: Partial<PlaybackSession> = {}): PlaybackSession {
  return {
    tenantId: 'tnt_a',
    source: { kind: 'evidence', id: 'ev-1' },
    startedAt: START,
    endedAt: '2026-08-03T09:10:00.000Z',
    durationSeconds: 600,
    playableSeconds: 600,
    segments: [
      {
        id: 'ev-1-0',
        key: 'cam/clip.mp4',
        url: 'https://example.test/clip.mp4',
        expiresInSeconds: 900,
        contentType: 'video/mp4',
        codec: 'h264',
        startedAt: START,
        endedAt: '2026-08-03T09:10:00.000Z',
        durationSeconds: 600,
        offsetSeconds: 0,
      },
    ],
    gaps: [],
    markers: [],
    bookmarks: [],
    annotations: [],
    capabilities: { seek: true, frameStep: true, rates: [1, 2, 4], snapshot: false, export: false },
    derivedAt: START,
    ...overrides,
  };
}

const still = () =>
  session({
    durationSeconds: 0,
    playableSeconds: 0,
    endedAt: START,
    segments: [
      {
        id: 'ev-2-0',
        key: 'cam/shot.jpg',
        url: 'https://example.test/shot.jpg',
        expiresInSeconds: 900,
        contentType: 'image/jpeg',
        startedAt: START,
        endedAt: START,
        durationSeconds: 0,
        offsetSeconds: 0,
      },
    ],
    capabilities: { seek: false, frameStep: false, rates: [1], snapshot: false, export: false },
  });

describe('the player offers only what the media can do', () => {
  it('⚠️ disables seeking on a still image rather than hiding the controls', async () => {
    renderWithProviders(<EvidencePlayer session={still()} />);
    const back = screen.getByRole('button', { name: 'Back 5 seconds' });
    expect(back).toBeDisabled();
    /* Present, so an operator can see the product *has* the feature and this source lacks it. */
    expect(back).toBeInTheDocument();
  });

  it('⚠️ never offers snapshot capture — no renderer exists in this build', () => {
    renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.getByRole('button', { name: 'Capture snapshot' })).toBeDisabled();
  });

  it('offers seeking on a seekable clip', () => {
    renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.getByRole('button', { name: 'Back 5 seconds' })).toBeEnabled();
    expect(screen.getByRole('slider', { name: 'Playback position' })).toBeInTheDocument();
  });

  it('⚠️ gives a still image no scrubber at all', () => {
    renderWithProviders(<EvidencePlayer session={still()} />);
    expect(screen.queryByRole('slider', { name: 'Playback position' })).not.toBeInTheDocument();
  });
});

describe('codec support is judged on the container, never the friendly codec name', () => {
  /*
   * ⚠️ The regression this pins. `canPlayType`'s codecs parameter is RFC 6381 (`avc1.42E01E`);
   * this platform's manifests store the friendly name, because `CameraCodec` is `'h264' | 'h265'`.
   * Appending it makes Chromium answer `''` — and the player told every operator that every H.264
   * clip was undecodable. Found by looking at the rendered page, not by reasoning.
   */
  /*
   * jsdom answers `''` to everything, so asserting the rendered outcome would only prove jsdom's
   * stub. What matters is the **string we hand the browser**: it must be the container alone.
   */
  it('⚠️ never appends the manifest codec to the probe', () => {
    const probed: string[] = [];
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type: string) => {
        probed.push(type);
        /* Chromium's real answers, measured in the browser. */
        if (type === 'video/mp4') return 'maybe';
        if (type === 'video/mp4; codecs="h264"') return '';
        return '';
      });

    renderWithProviders(<EvidencePlayer session={session()} />);

    expect(probed).toContain('video/mp4');
    expect(probed.some((type) => type.includes('h264'))).toBe(false);
    expect(screen.queryByTestId('player-codec')).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('still refuses a container the browser genuinely cannot open', () => {
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation(() => '' as const);
    renderWithProviders(
      <EvidencePlayer
        session={session({
          segments: [{ ...session().segments[0]!, contentType: 'video/x-nonsense' }],
        })}
      />,
    );
    expect(screen.getByTestId('player-codec')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('the view-mode badge', () => {
  it('starts at Original', () => {
    renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.getByTestId('view-mode-badge')).toHaveTextContent('Original');
  });

  it('⚠️ says Enhanced the moment an adjustment moves', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EvidencePlayer session={session()} />);
    await user.click(screen.getByRole('button', { name: 'Adjust brightness and contrast' }));

    /* A range input does not respond to typing — set it the way a drag would. */
    fireEvent.change(screen.getByLabelText('Brightness'), { target: { value: '1.4' } });

    await waitFor(() =>
      expect(screen.getByTestId('view-mode-badge')).toHaveTextContent(/Enhanced/i),
    );
  });

  it('⚠️ marks a redacted copy as redacted, outranking any adjustment', () => {
    renderWithProviders(
      <EvidencePlayer
        session={session()}
        derivation={{
          derivedEvidenceId: 'ev-2',
          sourceEvidenceId: 'ev-1',
          tenantId: 'tnt_a',
          appliedOperations: [{ order: 0, operation: 'blur', parameters: {} }],
          rendererVersion: 'r-1',
          time: { recordedAt: START, exportedAt: START, clockConfidence: 'unknown' },
          integrityHash: 'sha256:abc',
          hashAlgorithm: 'sha256',
          producedBy: 'usr_1',
        }}
      />,
    );
    expect(screen.getByTestId('view-mode-badge')).toHaveTextContent(/Redacted/i);
  });

  it('marks a non-destructive render as Derived, not Redacted', () => {
    renderWithProviders(
      <EvidencePlayer
        session={session()}
        derivation={{
          derivedEvidenceId: 'ev-3',
          sourceEvidenceId: 'ev-1',
          tenantId: 'tnt_a',
          appliedOperations: [{ order: 0, operation: 'transcode', parameters: {} }],
          rendererVersion: 'r-1',
          time: { recordedAt: START, exportedAt: START, clockConfidence: 'unknown' },
          integrityHash: 'sha256:abc',
          hashAlgorithm: 'sha256',
          producedBy: 'usr_1',
        }}
      />,
    );
    expect(screen.getByTestId('view-mode-badge')).toHaveTextContent(/Derived/i);
  });
});

describe('the timeline', () => {
  it('⚠️ draws a gap to scale rather than closing it up', () => {
    renderWithProviders(
      <PlaybackTimeline
        positionSeconds={0}
        session={session({
          gaps: [
            {
              startedAt: '2026-08-03T09:02:00.000Z',
              endedAt: '2026-08-03T09:04:00.000Z',
              durationSeconds: 120,
              offsetSeconds: 120,
              reason: 'no-recording',
              detail: 'the camera was offline',
            },
          ],
        })}
      />,
    );
    const gap = screen.getByTestId('timeline-gap');
    /* Two minutes of a ten-minute session is 20% of the width, not a hairline marker. */
    expect(gap.style.width).toBe('20%');
    expect(gap.style.left).toBe('20%');
  });

  it('says "continuous" only when there genuinely are no gaps', () => {
    renderWithProviders(<PlaybackTimeline session={session()} positionSeconds={0} />);
    expect(screen.getByText('continuous')).toBeInTheDocument();
  });

  it('⚠️ refuses to draw a timeline for a still image', () => {
    renderWithProviders(<PlaybackTimeline session={still()} positionSeconds={0} />);
    expect(screen.getByTestId('timeline-still')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-playhead')).not.toBeInTheDocument();
  });

  it('⚠️ bounds the tick count so labels stay legible — found by looking at the rendered axis', () => {
    /*
     * The first draft allowed 24 and produced an unreadable smear at a realistic panel width. A
     * time label needs ~70 px; ten is what fits the narrowest panel the workspace allows.
     */
    for (const span of [30, 600, 3600, 86_400, 604_800]) {
      expect(span / tickStep(span)).toBeLessThanOrEqual(10);
    }
  });

  it('exposes the head to assistive technology', () => {
    renderWithProviders(<PlaybackTimeline session={session()} positionSeconds={120} />);
    const slider = screen.getByRole('slider', { name: 'Playback timeline' });
    expect(slider).toHaveAttribute('aria-valuenow', '120');
    expect(slider).toHaveAttribute('aria-valuemax', '600');
  });
});

describe('session caching', () => {
  it('⚠️ derives staleness from the session, with a margin before the URLs die', () => {
    expect(sessionStaleTime(session())).toBe((900 - 60) * 1000);
  });

  it('⚠️ treats a session with no segments as immediately stale, never as fresh', () => {
    expect(sessionStaleTime(session({ segments: [] }))).toBe(0);
    expect(sessionStaleTime(undefined)).toBe(0);
  });

  it('never outlives the shortest-lived segment', () => {
    const short = session({
      segments: [
        { ...session().segments[0]!, expiresInSeconds: 120 },
        { ...session().segments[0]!, id: 'b', expiresInSeconds: 900 },
      ],
    });
    expect(sessionStaleTime(short)).toBe((120 - 60) * 1000);
  });
});

describe('the playback panel', () => {
  function renderPanel() {
    return renderWithProviders(
      <EvidenceSelectionProvider>
        <PlaybackPanel incidentId="inc_1" unavailableReason={undefined} />
      </EvidenceSelectionProvider>,
    );
  }

  it('⚠️ says an item is unavailable with the server’s reason, not a generic error', async () => {
    server.use(
      mswHttp.get('*/evidence/evidence', () =>
        HttpResponse.json({
          success: true,
          data: {
            items: [
              {
                id: 'ev-1',
                tenantId: 'tnt_a',
                kind: 'clip',
                status: 'available',
                source: { incidentId: 'inc_1', eventId: 'e', correlationId: 'c' },
                capturedAt: START,
                media: {
                  storageKey: 'k',
                  contentType: 'video/mp4',
                  integrity: { algorithm: 'sha256', hash: 'h', sizeBytes: 1 },
                  tier: 'active',
                },
                metadata: { metadataVersion: 1, tags: [], zones: [], attributes: {} },
                retention: { retainUntil: null, legalHold: false },
                createdAt: START,
                updatedAt: START,
                createdBy: 'u',
              },
            ],
          },
        }),
      ),
      mswHttp.get('*/evidence/evidence/ev-1/playback', () =>
        HttpResponse.json(
          {
            success: false,
            error: {
              code: 'conflict',
              message: 'evidence "ev-1" is not available (status: purged)',
            },
          },
          { status: 409 },
        ),
      ),
    );

    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/not available \(status: purged\)/)).toBeInTheDocument(),
    );
  });

  it('⚠️ shows an empty state, not an error, when the incident has no evidence', async () => {
    server.use(
      mswHttp.get('*/evidence/evidence', () =>
        HttpResponse.json({ success: true, data: { items: [] } }),
      ),
    );
    renderPanel();
    await waitFor(() => expect(screen.getByText('No recording to play')).toBeInTheDocument());
  });
});
