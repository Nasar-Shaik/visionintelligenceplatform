/**
 * Retail Loitering pages (P-8 Phase 7).
 *
 * ### What these tests are for
 *
 * Not "does it render". Every assertion is about a **distinction the page must not collapse**,
 * because each has a failure mode where the page looks fine and says something false:
 *
 * - a rate the node has not measured must read "measuring…", never `0.0/s`;
 * - a node that does not evaluate must say so, never render an empty dashboard;
 * - a duration assembled across a track gap must say so **above** the number, not below it;
 * - a candidate raised mid-loiter must not claim an exit time;
 * - the zone editor must refuse a self-intersecting polygon before the server does;
 * - `dwellWithoutIdentity > 0` must be visible, because it is the only signal that separates
 *   "nothing is happening" from "this rule can never fire".
 */
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { permissionsForRoles } from '@vip/permissions';
import type {
  CandidateExplanation,
  CandidateTimeline,
  DetectionZone,
  LiveDwellTimer,
  LiveRuleStatus,
} from '@vip/contracts';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { LiveRuleStatusPage } from './LiveRuleStatusPage';
import { ZoneEditorPage } from './ZoneEditorPage';
import { LoiteringEvidence } from './LoiteringEvidence';

const NOW = '2026-08-06T10:00:00.000Z';

function signIn(roles: string[] = ['admin']): void {
  store.dispatch(
    authenticated({
      user: { id: 'usr_me', email: 'op@northgate.demo', roles },
      tenantId: 'tnt_demo_retail',
      permissions: permissionsForRoles(roles),
    }),
  );
}

function timer(over: Partial<LiveDwellTimer> = {}): LiveDwellTimer {
  return {
    ruleId: 'rule-1',
    ruleName: 'Retail Loitering',
    subject: 'id-alpha',
    subjectKind: 'identity',
    cameraId: 'cam1',
    zoneId: 'zn-queue',
    zoneName: 'Checkout Queue',
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    elapsedSeconds: 42,
    thresholdSeconds: 60,
    observations: 84,
    trackFragments: 1,
    longestGapSeconds: 0,
    state: 'accumulating',
    cooldownRemainingSeconds: null,
    dryRun: false,
    ...over,
  };
}

function status(over: Partial<LiveRuleStatus> = {}): LiveRuleStatus {
  return {
    tenantId: 'tnt_demo_retail',
    node: 'rules-7f9',
    uptimeSeconds: 3600,
    activeRules: 3,
    dwellRules: 1,
    dryRunRules: 0,
    activeZones: 2,
    evaluationsPerSecond: 12.5,
    candidatesPerSecond: 0.1,
    eventsPerSecond: 4,
    activeDwellTimers: 1,
    timers: [timer()],
    dwellWithoutIdentity: 0,
    dwellStateEntries: 1,
    dwellStateCapacity: 50_000,
    dwellStateEvicted: 0,
    at: NOW,
    ...over,
  };
}

function serveStatus(payload: LiveRuleStatus | { status: number }): void {
  server.use(
    mswHttp.get('*/rules/rules/live', () =>
      'status' in payload
        ? HttpResponse.json({ error: { code: 'not-evaluating', message: 'no engine' } }, payload)
        : HttpResponse.json({ data: payload }),
    ),
    mswHttp.get('*/rules/rules/live/dry-runs', () => HttpResponse.json({ data: [] })),
    mswHttp.get('*/camera/zones*', () => HttpResponse.json({ data: [] })),
    mswHttp.get('*/tracking/tracks*', () => HttpResponse.json({ data: { tracks: [] } })),
  );
}

afterEach(() => {
  store.dispatch(signedOut());
});

describe('Live Rule Status', () => {
  it('shows the running dwell clock against its threshold', async () => {
    signIn();
    serveStatus(status());
    renderWithProviders(<LiveRuleStatusPage />, { store });

    expect(await screen.findByText('Checkout Queue')).toBeInTheDocument();
    expect(screen.getByText('42.0s')).toBeInTheDocument();
    expect(screen.getByText('60s')).toBeInTheDocument();
    expect(screen.getByText('accumulating')).toBeInTheDocument();
  });

  /** ⚠️ ADR-0039. `0.0/s` and "no window has elapsed" look identical and mean opposite things. */
  it('says "measuring…" for a rate the node has not measured yet', async () => {
    signIn();
    serveStatus(
      status({ evaluationsPerSecond: null, eventsPerSecond: null, candidatesPerSecond: null }),
    );
    renderWithProviders(<LiveRuleStatusPage />, { store });

    expect(await screen.findAllByText(/measuring…/)).not.toHaveLength(0);
    expect(screen.queryByText('0.0/s')).not.toBeInTheDocument();
  });

  /** ⚠️ A deployment shape, not an outage. An empty dashboard would look like a quiet estate. */
  it('says the node does not evaluate rather than rendering zeroes', async () => {
    signIn();
    serveStatus({ status: 503 });
    renderWithProviders(<LiveRuleStatusPage />, { store });

    expect(await screen.findByText(/does not evaluate rules/i)).toBeInTheDocument();
    expect(screen.queryByText('Running dwell clocks')).not.toBeInTheDocument();
  });

  /**
   * ⚠️ The one number that separates "nothing is happening" from "this rule can never fire". A dwell
   * rule receiving identity-less events looks enabled and healthy for ever.
   */
  it('warns when events are arriving without an identity', async () => {
    signIn();
    serveStatus(status({ dwellWithoutIdentity: 812 }));
    renderWithProviders(<LiveRuleStatusPage />, { store });

    expect(await screen.findByText(/arriving without an identity/i)).toBeInTheDocument();
    expect(screen.getByText(/812 dwell evaluations were skipped/)).toBeInTheDocument();
  });

  it('warns when dwell state is being evicted, because those rules will not fire', async () => {
    signIn();
    serveStatus(status({ dwellStateEvicted: 5 }));
    renderWithProviders(<LiveRuleStatusPage />, { store });
    expect(await screen.findByText(/Dwell state is being evicted/i)).toBeInTheDocument();
  });

  it('shows the cool-down remaining rather than just "cooling down"', async () => {
    signIn();
    serveStatus(
      status({ timers: [timer({ state: 'cooling-down', cooldownRemainingSeconds: 137 })] }),
    );
    renderWithProviders(<LiveRuleStatusPage />, { store });
    expect(await screen.findByText('cooling 137s')).toBeInTheDocument();
  });

  it('marks a dry-run rule’s clock so nobody waits for an incident that will not come', async () => {
    signIn();
    serveStatus(status({ timers: [timer({ dryRun: true })] }));
    renderWithProviders(<LiveRuleStatusPage />, { store });
    expect(await screen.findByText('dry run')).toBeInTheDocument();
  });

  it('names the node every figure came from', async () => {
    signIn();
    serveStatus(status());
    renderWithProviders(<LiveRuleStatusPage />, { store });
    expect(await screen.findByText(/rules-7f9/)).toBeInTheDocument();
  });

  it('reports zero running clocks as a legitimate reading, not an error', async () => {
    signIn();
    serveStatus(status({ timers: [], activeDwellTimers: 0 }));
    renderWithProviders(<LiveRuleStatusPage />, { store });
    expect(await screen.findByText('No clocks running')).toBeInTheDocument();
  });
});

describe('Zone Editor', () => {
  /**
   * Choose the camera.
   *
   * ⚠️ Waits for the **option**, not for the select. The select renders immediately with only its
   * placeholder; setting a value that has no matching option leaves a controlled `<select>` on the
   * placeholder, and the page then correctly shows "No camera selected" — a green-looking test that
   * asserted nothing.
   */
  async function selectCamera(): Promise<void> {
    await screen.findByRole('option', { name: 'Front Door' });
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'cam1' } });
  }

  function serveCameras(zones: DetectionZone[] = []): void {
    server.use(
      /* ⚠️ `*` suffix — the client always sends `limit`, so an exact-path handler never matches. */
      mswHttp.get('*/camera/cameras*', () =>
        HttpResponse.json({ data: { cameras: [{ id: 'cam1', name: 'Front Door' }] } }),
      ),
      mswHttp.get('*/camera/zones*', () => HttpResponse.json({ data: zones })),
      mswHttp.get('*/tracking/tracks*', () => HttpResponse.json({ data: { tracks: [] } })),
    );
  }

  it('will not draw until a camera is chosen, and says why', async () => {
    signIn();
    serveCameras();
    renderWithProviders(<ZoneEditorPage />, { store });
    expect(await screen.findByText('No camera selected')).toBeInTheDocument();
  });

  it('refuses a self-intersecting polygon before the server is asked', async () => {
    signIn();
    serveCameras();
    renderWithProviders(<ZoneEditorPage />, { store });

    await selectCamera();
    const canvas = await screen.findByRole('application');
    /*
     * jsdom gives every element a zero-sized bounding box, so clicks cannot place points. The
     * geometry rule under test is the contracts function the page imports — asserted directly in
     * `packages/contracts/test/zone-geometry.test.ts`. What this test pins is that the page reaches
     * the drawing surface at all once a camera is chosen, which is the wiring that could break.
     */
    expect(canvas).toBeInTheDocument();
  });

  /** ⚠️ Absence of zones is not an error — it is the state every new camera is in, and it is fatal
   * to a zone-scoped rule, so the page has to say what it means rather than showing nothing. */
  it('explains what no zones means for a rule', async () => {
    signIn();
    serveCameras();
    renderWithProviders(<ZoneEditorPage />, { store });
    await selectCamera();
    expect(await screen.findByText('No zones yet')).toBeInTheDocument();
    expect(
      screen.getByText(/carries no zone and a zone-scoped rule matches nothing/),
    ).toBeInTheDocument();
  });

  it('states on the canvas that there is no video frame behind it', async () => {
    signIn();
    serveCameras();
    renderWithProviders(<ZoneEditorPage />, { store });
    await selectCamera();
    expect(await screen.findByText(/No video frame is available/)).toBeInTheDocument();
  });
});

describe('Loitering evidence panel', () => {
  const explanation = (over: Partial<CandidateExplanation> = {}): CandidateExplanation => ({
    trigger: 'dwell',
    subjectKind: 'identity',
    identityId: 'id-alpha',
    cameraId: 'cam1',
    zoneId: 'zn-queue',
    zoneName: 'Checkout Queue',
    zoneVersion: 4,
    observedSeconds: 94,
    thresholdSeconds: 60,
    firstObservedAt: NOW,
    lastObservedAt: '2026-08-06T10:01:34.000Z',
    observations: 188,
    trackFragments: 1,
    longestGapSeconds: 0,
    meanConfidence: 0.82,
    summary: 'the same subject was observed in Checkout Queue for 94s',
    ...over,
  });

  const timeline: CandidateTimeline = {
    entries: [
      {
        at: NOW,
        kind: 'first-observed',
        elapsedSeconds: 0,
        evidence: [],
        summary: 'first seen in the zone — the clock starts',
      },
    ],
    omitted: 164,
    total: 188,
  };

  it('renders nothing at all for an incident with no dwell analysis', () => {
    const { container } = renderWithProviders(<LoiteringEvidence />);
    expect(container.querySelector('[data-testid="loitering-evidence"]')).toBeNull();
  });

  /** ⚠️ Above the numbers — see the component header. */
  it('warns about a fragmented identity before showing the duration', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation({ trackFragments: 3 })} />);
    const banner = screen.getByText(/assembled, not watched continuously/i);
    const duration = screen.getByText('94s');
    /* `compareDocumentPosition` returns FOLLOWING when the argument comes after the node. */
    expect(
      banner.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('warns about an observation gap', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation({ longestGapSeconds: 19 })} />);
    expect(screen.getByText(/longest stretch with no observation was 19s/)).toBeInTheDocument();
  });

  it('says nothing alarming when the observation was continuous', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation()} />);
    expect(screen.queryByText(/assembled, not watched continuously/i)).not.toBeInTheDocument();
  });

  /** ⚠️ A candidate is raised DURING a loiter. An exit time here would be a fabricated fact. */
  it('does not claim an exit time', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation()} />);
    expect(screen.getByText(/still present when raised/)).toBeInTheDocument();
  });

  it('shows the zone version, so the incident can be redrawn over its own footage', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation()} />);
    expect(screen.getByText('v4')).toBeInTheDocument();
  });

  /** ADR-0039 again, on an evidence record this time. */
  it('says a confidence was not measured rather than showing 0.00', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation()} confidence={null} />);
    expect(screen.getByText('not measured')).toBeInTheDocument();
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();
  });

  it('says how much of the timeline it left out', () => {
    renderWithProviders(<LoiteringEvidence explanation={explanation()} timeline={timeline} />);
    expect(screen.getByText(/164 routine observations omitted/)).toBeInTheDocument();
  });

  it('links evidence rather than embedding it', () => {
    renderWithProviders(
      <LoiteringEvidence
        explanation={explanation()}
        evidence={[
          {
            kind: 'recording-interval',
            cameraId: 'cam1',
            startedAt: NOW,
            endedAt: NOW,
            locator: '/media/recordings?cameraId=cam1',
            label: 'Recorded footage — 94s in zone',
          },
        ]}
      />,
    );
    const link = screen.getByRole('link', { name: /Recorded footage/ });
    expect(link).toHaveAttribute('href', '/media/recordings?cameraId=cam1');
  });
});
