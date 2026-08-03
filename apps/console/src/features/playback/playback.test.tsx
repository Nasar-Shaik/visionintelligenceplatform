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

/**
 * ⚠️ `derivedAt` is **now**, not a fixed literal.
 *
 * A hard-coded resolution time makes every fixture a session that expired months ago, and the
 * player — correctly, since P-5.6 — replaces the video with "this playback link expired". The suite
 * still passed, because the assertions were all on the transport chrome *around* the video, so a
 * player showing an expiry overlay in every test looked identical to a healthy one. The fixture is
 * live by construction now, and expiry is asserted deliberately where it belongs.
 */
const nowIso = () => new Date().toISOString();

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
    derivedAt: nowIso(),
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

describe('the codec question is answered with measured browser behaviour', () => {
  /*
   * ⚠️ The P-5.5 regression this still pins. `canPlayType`'s codecs parameter is RFC 6381
   * (`avc1.42E01E`); this platform's manifests store the friendly name, because `CameraCodec` is
   * `'h264' | 'h265'`. Handing the stored name straight to the browser makes **every engine**
   * answer `''`, and the player told every operator that every H.264 clip was undecodable.
   *
   * P-5.6 goes further: the friendly name is *translated* rather than dropped, so an H.265 clip on
   * a build with no HEVC decoder is named as such instead of falling through to a generic media
   * error. jsdom answers `''` to everything, so these tests inject the answers measured in each
   * real engine — see `docs/review/p56/BROWSER_MATRIX.md`.
   */
  it('⚠️ never hands the browser the friendly codec name', () => {
    const probed: string[] = [];
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type: string) => {
        probed.push(type);
        /* Chromium's measured answers. */
        if (type === 'video/mp4') return 'maybe';
        if (type.includes('avc1')) return 'probably';
        return '';
      });

    renderWithProviders(<EvidencePlayer session={session()} />);

    expect(probed).toContain('video/mp4');
    expect(probed.some((type) => type.includes('"h264"'))).toBe(false);
    expect(probed.some((type) => type.includes('avc1'))).toBe(true);
    expect(screen.queryByTestId('player-codec')).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('refuses a container the browser genuinely cannot open', () => {
    /* Chrome measured: `video/quicktime` → '' while `video/mp4` → 'maybe'. A .mov will not open. */
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type: string) => (type.startsWith('video/mp4') ? 'maybe' : ''));
    renderWithProviders(
      <EvidencePlayer
        session={session({
          segments: [{ ...session().segments[0]!, contentType: 'video/quicktime' }],
        })}
      />,
    );
    expect(screen.getByTestId('player-codec')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('⚠️ names the missing HEVC decoder instead of reporting a broken recording', () => {
    /* Chromium (open-source build) measured: both H.265 candidates → ''. Branded Chrome differs. */
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation((type: string) => {
        if (type === 'video/mp4') return 'maybe';
        if (type.includes('avc1')) return 'probably';
        return '';
      });
    renderWithProviders(
      <EvidencePlayer
        session={session({
          segments: [{ ...session().segments[0]!, codec: 'h265' }],
        })}
      />,
    );
    expect(screen.getByTestId('player-codec')).toHaveTextContent(/H\.265/);
    /* ⚠️ And it must say the evidence is fine — that is the whole point of naming the cause. */
    expect(screen.getByTestId('player-codec')).toHaveTextContent(/evidence is intact/i);
    spy.mockRestore();
  });

  it('⚠️ stays silent in a test environment that answers "" to everything', () => {
    /*
     * jsdom. A probe that refuses even a bare container is not measuring, and treating its answer
     * as fact would paper every player in the suite with a false "cannot decode" alarm — which is
     * how the P-5.5 defect stayed invisible in the other direction.
     */
    const spy = vi
      .spyOn(HTMLMediaElement.prototype, 'canPlayType')
      .mockImplementation(() => '' as const);
    renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.queryByTestId('player-codec')).not.toBeInTheDocument();
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

// =================================================================================================
// P-5.6 — production hardening
// =================================================================================================

describe('⚠️ an expired playback link is recovered, not reported as a broken recording', () => {
  const expired = () => session({ derivedAt: new Date(Date.now() - 4 * 3600_000).toISOString() });

  it('names the expiry rather than blaming the media', () => {
    renderWithProviders(<EvidencePlayer session={expired()} onRecover={() => undefined} />);
    const overlay = screen.getByTestId('player-error');
    expect(overlay).toHaveAttribute('data-failure', 'expired');
    expect(overlay).toHaveTextContent(/expired/i);
    /* The sentence that stops somebody concluding the evidence is gone. */
    expect(overlay).toHaveTextContent(/untouched/i);
  });

  it('⚠️ fetches a fresh signature instead of reloading the dead URL', async () => {
    const user = userEvent.setup();
    const onRecover = vi.fn();
    renderWithProviders(<EvidencePlayer session={expired()} onRecover={onRecover} />);
    await user.click(screen.getByRole('button', { name: /resume playback/i }));
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it('⚠️ offers no button at all when nothing can refetch, and says what to do instead', () => {
    renderWithProviders(<EvidencePlayer session={expired()} />);
    expect(screen.queryByRole('button', { name: /resume playback/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('player-error')).toHaveTextContent(/reopen this evidence item/i);
  });

  it('a live session shows no overlay', () => {
    renderWithProviders(<EvidencePlayer session={session()} onRecover={() => undefined} />);
    expect(screen.queryByTestId('player-error')).not.toBeInTheDocument();
  });
});

describe('⚠️ the media element is released when the player goes away', () => {
  it('pauses, clears the source and reloads the element on unmount', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const { unmount } = renderWithProviders(<EvidencePlayer session={session()} />);
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    const removeAttribute = vi.spyOn(video!, 'removeAttribute');

    unmount();

    /*
     * Detaching the node is not enough: a detached element with a live `src` keeps downloading —
     * measured at 13.33 MB against 1.61 MB over 60 opened-and-closed clips.
     */
    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(removeAttribute).toHaveBeenCalledWith('src');
    expect(load).toHaveBeenCalled();

    pause.mockRestore();
    load.mockRestore();
  });

  it('⚠️ does NOT release a node React is merely re-attaching', async () => {
    /*
     * The defect this pins: React runs ref cleanup then ref attach on a **still-mounted** node —
     * StrictMode does it on every development mount. Releasing there blanked a live player, and
     * React never restored `src`, because its virtual DOM saw no change. The player was a black
     * rectangle reading "Resolving media…" and no test was watching.
     */
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    renderWithProviders(<EvidencePlayer session={session()} />);
    const video = document.querySelector('video')!;
    const removeAttribute = vi.spyOn(video, 'removeAttribute');

    /* Re-renders that keep the element mounted, driven the way the operator would. */
    fireEvent.change(screen.getByRole('slider', { name: 'Playback position' }), {
      target: { value: '12' },
    });
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.5' } });
    await waitFor(() => expect(video.isConnected).toBe(true));
    /* Let any deferred release run — if the guard were absent, this is where it would fire. */
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(removeAttribute).not.toHaveBeenCalledWith('src');
    expect(video.getAttribute('src')).toBe('https://example.test/clip.mp4');
    load.mockRestore();
  });
});

describe('playback preferences survive the clip being reopened', () => {
  it('⚠️ remembers the rate for this clip only, in sessionStorage', async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
    const { unmount } = renderWithProviders(
      <EvidencePlayer session={session()} evidenceId="clip-a" />,
    );
    /* The rate ladder for this fixture is [1, 2, 4]; one press moves to 2×. */
    await user.click(screen.getByRole('button', { name: /^Speed/ }));
    expect(screen.getByRole('button', { name: 'Speed 2×' })).toBeInTheDocument();
    unmount();

    renderWithProviders(<EvidencePlayer session={session()} evidenceId="clip-a" />);
    expect(screen.getByRole('button', { name: 'Speed 2×' })).toBeInTheDocument();

    /* ⚠️ A different clip starts clean — this is per-item memory, not a global preference. */
    renderWithProviders(<EvidencePlayer session={session()} evidenceId="clip-b" />);
    expect(screen.getAllByRole('button', { name: 'Speed 1×' }).length).toBeGreaterThan(0);
  });

  it('⚠️ never reaches localStorage, which would outlive the operator’s shift', async () => {
    const user = userEvent.setup();
    sessionStorage.clear();
    localStorage.clear();
    renderWithProviders(<EvidencePlayer session={session()} evidenceId="clip-c" />);
    await user.click(screen.getByRole('button', { name: /^Speed/ }));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem('vip.playback.memory.v1')).toContain('clip-c');
  });
});

describe('the volume control', () => {
  it('is offered on a clip and withheld from a still image', () => {
    const { unmount } = renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.getByLabelText('Volume')).toBeInTheDocument();
    unmount();
    renderWithProviders(<EvidencePlayer session={still()} />);
    expect(screen.queryByLabelText('Volume')).not.toBeInTheDocument();
  });

  it('⚠️ announces a percentage, not a raw float', () => {
    renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.getByLabelText('Volume')).toHaveAttribute('aria-valuetext', '100 percent');
  });
});

describe('the shortcut sheet is generated from the frozen registry', () => {
  it('⚠️ lists an unavailable binding with its reason rather than hiding it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EvidencePlayer session={session()} />);
    await user.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));

    const list = await screen.findByTestId('shortcut-list');
    expect(list).toHaveTextContent('Play / Pause');
    expect(list).toHaveTextContent('Capture Snapshot');
    /* Registered so the binding is reserved, and honest about producing nothing. */
    expect(list).toHaveTextContent(/no snapshot renderer is built yet/i);
  });
});

describe('the scrubber speaks to a screen reader', () => {
  it('⚠️ announces a clock, not a float', () => {
    renderWithProviders(<EvidencePlayer session={session()} />);
    expect(screen.getByRole('slider', { name: 'Playback position' })).toHaveAttribute(
      'aria-valuetext',
      '00:00 of 10:00',
    );
  });
});
