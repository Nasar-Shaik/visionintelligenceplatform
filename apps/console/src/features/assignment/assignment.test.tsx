/**
 * Camera Processing Assignment pages (P-8 Phase 6).
 *
 * ### What these tests are for
 *
 * Not "does it render". Every assertion here is about a **distinction the page must not collapse**,
 * because each one has a failure mode where the page looks perfectly fine and says something false:
 *
 * - `Not measured` must track the payload, never a hard-coded string and never a `0`;
 * - a runtime nobody has observed must read "Not observed", never "Healthy";
 * - a profile no runtime can run must say so, and one nobody has checked must say `Unknown`;
 * - a media outage must degrade the measurement columns without hiding the controls;
 * - pause/resume must follow `assignment:control` and enable/disable `assignment:write`.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { permissionsForRoles } from '@vip/permissions';
import type {
  AssignmentCapacityReport,
  CameraAssignment,
  ProcessingProfile,
  ProcessingRuntime,
} from '@vip/contracts';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { CameraAssignmentPage } from './CameraAssignmentPage';
import { ProcessingProfilesPage } from './ProcessingProfilesPage';
import { RuntimeHealthPage } from './RuntimeHealthPage';
import { RuntimeCapacityPage } from './RuntimeCapacityPage';

const NOW = '2026-08-06T10:00:00.000Z';

function assignment(over: Partial<CameraAssignment> = {}): CameraAssignment {
  return {
    tenantId: 'tnt_a',
    cameraId: 'cam1',
    state: 'running',
    aiEnabled: true,
    profileId: 'person-tracking',
    runtimeId: 'inference',
    version: 3,
    sessionEpoch: 1,
    reason: 'operator',
    placementFailure: null,
    lastError: null,
    observed: { state: 'active', at: NOW, runtimeId: 'inference', planVersion: 4, stale: false },
    updatedAt: NOW,
    updatedBy: 'priya',
    createdAt: NOW,
    ...over,
  };
}

function profile(over: Partial<ProcessingProfile> = {}): ProcessingProfile {
  return {
    id: 'person-tracking',
    tenantId: 'tnt_a',
    name: 'Person Tracking',
    description: 'Detect and track people.',
    capabilities: ['perception.person-detection'],
    targetFps: null,
    builtIn: true,
    supported: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function runtime(over: Partial<ProcessingRuntime> = {}): ProcessingRuntime {
  return {
    id: 'inference',
    name: 'Inference runtime',
    url: 'http://inference:8085',
    labels: [],
    maxCameras: 4,
    enabled: true,
    health: 'healthy',
    observedAt: NOW,
    observedBy: 'media',
    latencyMs: 3,
    capabilities: ['perception.person-detection'],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

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

/**
 * Answer the routes a page calls.
 *
 * ⚠️ A value of `'error'` produces a **500**, not an empty body. "The service answered with nothing"
 * and "the service could not be reached" are the two cases these pages must render differently, and
 * a stub that could only produce the first would leave the second untested.
 */
function stubApi(routes: Record<string, unknown>) {
  server.use(
    ...Object.entries(routes).map(([path, value]) =>
      mswHttp.get(`/api${path}`, () =>
        value === 'error'
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json({ success: true, data: value }),
      ),
    ),
  );
}

describe('P-8.6 · Camera Assignment page', () => {
  it('⚠️ shows the decision and the measurement as separate columns', async () => {
    stubApi({
      '/camera/assignments': [assignment()],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [
        {
          cameraId: 'cam1',
          aiEnabled: true,
          state: 'running',
          profileId: 'person-tracking',
          runtimeId: 'inference',
          processingFps: 1.8,
          framesOffered: 120,
          framesDelivered: 118,
          framesSkippedUnassigned: 0,
          framesDroppedQueueFull: 2,
          queueDepth: 0,
          processingLatencyMs: 42,
          eventsPublished: 9,
          activeTracks: 1,
          lastFrameAt: NOW,
          lastError: null,
        },
      ],
    });
    authAs(['admin']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    const row = await screen.findByRole('row', { name: /cam1/ });
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(within(row).getByText('118')).toBeInTheDocument();
    expect(within(row).getByText('1.8')).toBeInTheDocument();
  });

  it('⚠️ a camera the enforcement point has not reported reads "Not measured", not 0', async () => {
    stubApi({
      '/camera/assignments': [assignment({ cameraId: 'cam-unseen' })],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [],
    });
    authAs(['admin']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    const row = await screen.findByRole('row', { name: /cam-unseen/ });
    expect(within(row).getAllByText('Not measured').length).toBeGreaterThan(0);
    expect(within(row).queryByText('0')).not.toBeInTheDocument();
  });

  it('⚠️ a media outage degrades the measurements and keeps the controls', async () => {
    stubApi({
      '/camera/assignments': [assignment()],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': 'error',
    });
    authAs(['admin']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    expect(await screen.findByText(/measurements are unavailable/i)).toBeInTheDocument();
    /* ⚠️ The decision is still shown and still actionable. */
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disable ai/i })).toBeInTheDocument();
  });

  it('⚠️ an operator may pause but not disable — the permission split, on screen', async () => {
    stubApi({
      '/camera/assignments': [assignment()],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [],
    });
    authAs(['operator']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    expect(await screen.findByRole('button', { name: /pause/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /disable ai/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enable ai/i })).not.toBeInTheDocument();
  });

  it('surfaces the placement failure on the camera rather than losing it', async () => {
    stubApi({
      '/camera/assignments': [
        assignment({
          state: 'error',
          placementFailure: 'capacity-exceeded',
          lastError: 'every eligible runtime is at capacity',
        }),
      ],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [],
    });
    authAs(['admin']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    expect(await screen.findByText('Error')).toBeInTheDocument();
    expect(screen.getByText(/every eligible runtime is at capacity/i)).toBeInTheDocument();
  });
});

describe('P-8.6 · bulk operations (§7)', () => {
  it('⚠️ a wholly refused batch names every camera, including the valid ones', async () => {
    stubApi({
      '/camera/assignments': [
        assignment(),
        assignment({ cameraId: 'cam2', state: 'unassigned', aiEnabled: false }),
      ],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [],
    });
    server.use(
      mswHttp.post('/api/camera/assignments/bulk', () =>
        HttpResponse.json({
          success: true,
          data: {
            operation: 'enable',
            requested: 2,
            applied: 0,
            failed: 2,
            partial: false,
            planVersion: 7,
            items: [
              {
                cameraId: 'cam1',
                applied: false,
                error: {
                  code: 'batch_refused',
                  message: 'not applied — another camera in this operation was refused',
                },
              },
              {
                cameraId: 'cam2',
                applied: false,
                error: { code: 'refused', message: 'every eligible runtime is at capacity' },
              },
            ],
          },
        }),
      ),
    );
    authAs(['admin']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    const select = await screen.findByLabelText('Select cam1');
    fireEvent.click(select);
    fireEvent.click(screen.getByLabelText('Select cam2'));
    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    fireEvent.click(within(bar).getByRole('button', { name: /^enable ai$/i }));

    expect(await screen.findByText(/nothing was applied/i)).toBeInTheDocument();
    /* ⚠️ The valid camera is listed too, with the reason it was held back. */
    expect(screen.getByText(/another camera in this operation was refused/i)).toBeInTheDocument();
    expect(screen.getByText(/every eligible runtime is at capacity/i)).toBeInTheDocument();
  });

  it('⚠️ a PARTIAL result says so — the state a standalone MongoDB makes possible', async () => {
    stubApi({
      '/camera/assignments': [assignment()],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [],
    });
    server.use(
      mswHttp.post('/api/camera/assignments/bulk', () =>
        HttpResponse.json({
          success: true,
          data: {
            operation: 'disable',
            requested: 2,
            applied: 1,
            failed: 1,
            partial: true,
            planVersion: 8,
            items: [
              { cameraId: 'cam1', applied: true, state: 'stopping' },
              {
                cameraId: 'cam9',
                applied: false,
                error: { code: 'write_failed', message: 'connection reset' },
              },
            ],
          },
        }),
      ),
    );
    authAs(['admin']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    fireEvent.click(await screen.findByLabelText('Select cam1'));
    const bar = await screen.findByRole('region', { name: /bulk actions/i });
    fireEvent.click(within(bar).getByRole('button', { name: /^disable ai$/i }));

    expect(await screen.findByText(/partially applied — 1 of 2/i)).toBeInTheDocument();
    expect(screen.getByText(/connection reset/i)).toBeInTheDocument();
  });

  it('⚠️ an operator is offered no selection at all — bulk is assignment:write', async () => {
    stubApi({
      '/camera/assignments': [assignment()],
      '/camera/processing-profiles': [profile()],
      '/media/perception/assignment/cameras': [],
    });
    authAs(['operator']);
    renderWithProviders(<CameraAssignmentPage />, { store });

    await screen.findByRole('button', { name: /pause/i });
    expect(screen.queryByLabelText('Select cam1')).not.toBeInTheDocument();
  });
});

describe('P-8.6 · Processing Profiles page', () => {
  it('⚠️ says which profiles this deployment cannot run, and warns once', async () => {
    stubApi({
      '/camera/processing-profiles': [
        profile(),
        profile({ id: 'vehicle-analytics', name: 'Vehicle Analytics', supported: false }),
      ],
    });
    authAs(['admin']);
    renderWithProviders(<ProcessingProfilesPage />, { store });

    expect(await screen.findByText('Supported')).toBeInTheDocument();
    expect(screen.getByText('No runtime')).toBeInTheDocument();
    expect(
      screen.getByText(/name a capability no registered runtime advertises/i),
    ).toBeInTheDocument();
  });

  it('⚠️ renders Unknown — not "unsupported" — before any runtime has been observed', async () => {
    stubApi({ '/camera/processing-profiles': [profile({ supported: null })] });
    authAs(['admin']);
    renderWithProviders(<ProcessingProfilesPage />, { store });

    expect(await screen.findByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('No runtime')).not.toBeInTheDocument();
  });

  it('⚠️ a null frame rate is the deployment default, not zero fps', async () => {
    stubApi({ '/camera/processing-profiles': [profile({ targetFps: null })] });
    authAs(['admin']);
    renderWithProviders(<ProcessingProfilesPage />, { store });

    expect(await screen.findByText('Deployment default')).toBeInTheDocument();
  });
});

describe('P-8.6 · Runtime Health page', () => {
  it('⚠️ an unobserved runtime reads "Not observed" and has no latency', async () => {
    stubApi({
      '/camera/processing-runtimes': [
        (() => {
          const r = runtime({ health: 'unknown', latencyMs: null });
          delete (r as { observedAt?: string }).observedAt;
          delete (r as { observedBy?: string }).observedBy;
          return r;
        })(),
      ],
      '/media/perception/assignment': {
        enabled: true,
        planVersion: 4,
        plannedCameras: 1,
        cycles: 3,
        failures: 0,
        releases: 0,
        lastPlanAt: NOW,
        lastError: null,
        runtimes: [],
      },
    });
    authAs(['admin']);
    renderWithProviders(<RuntimeHealthPage />, { store });

    expect(await screen.findByText('Not observed')).toBeInTheDocument();
    expect(screen.getByText('Never observed')).toBeInTheDocument();
    /* ⚠️ Unreachable ⇒ no latency figure at all, not "0 ms". */
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
  });

  it('⚠️ says plainly when the gate is off, instead of rendering zeroes', async () => {
    stubApi({
      '/camera/processing-runtimes': [runtime()],
      '/media/perception/assignment': {
        enabled: false,
        detail: 'camera processing assignment is not enabled in this deployment',
      },
    });
    authAs(['admin']);
    renderWithProviders(<RuntimeHealthPage />, { store });

    expect(await screen.findByText(/not enabled in this deployment/i)).toBeInTheDocument();
    expect(screen.getByText(/every camera is analysed/i)).toBeInTheDocument();
  });
});

describe('P-8.6 · Runtime Capacity page', () => {
  const report = (over: Partial<AssignmentCapacityReport> = {}): AssignmentCapacityReport => ({
    tenantId: 'tnt_a',
    generatedAt: NOW,
    totalCameras: 3,
    assignedCameras: 1,
    runningCameras: 1,
    pausedCameras: 0,
    idleCameras: 2,
    failedCameras: 0,
    availableCapacity: 3,
    runtimes: [
      {
        runtimeId: 'inference',
        name: 'Inference runtime',
        health: 'healthy',
        maxCameras: 4,
        assignedCameras: 1,
        activeCameras: 1,
        pausedCameras: 0,
        failedCameras: 0,
        utilization: 0.25,
        remaining: 3,
        observedAt: NOW,
      },
    ],
    suggestions: [],
    limits: { maxAiCameras: null, maxActiveRuntimes: null, maxProcessingProfiles: null },
    ...over,
  });

  it('shows occupancy, headroom and that no licence limits are configured', async () => {
    stubApi({ '/camera/assignments/capacity': report() });
    authAs(['admin']);
    renderWithProviders(<RuntimeCapacityPage />, { store });

    expect(await screen.findByText('25%')).toBeInTheDocument();
    expect(screen.getByText(/no licensed limits are configured/i)).toBeInTheDocument();
    expect(screen.getByText(/every ai-enabled camera is placed/i)).toBeInTheDocument();
  });

  it('⚠️ an undeclared capacity is "Not declared", never 0% and never Infinity', async () => {
    stubApi({
      '/camera/assignments/capacity': report({
        availableCapacity: null,
        runtimes: [
          {
            runtimeId: 'inference',
            name: 'Inference runtime',
            health: 'unknown',
            maxCameras: 0,
            assignedCameras: 2,
            activeCameras: 0,
            pausedCameras: 0,
            failedCameras: 0,
            utilization: null,
            remaining: null,
            observedAt: null,
          },
        ],
      }),
    });
    authAs(['admin']);
    renderWithProviders(<RuntimeCapacityPage />, { store });

    expect(await screen.findByText('No capacity declared')).toBeInTheDocument();
    expect(screen.getAllByText('Not declared').length).toBeGreaterThan(0);
    expect(screen.queryByText('Infinity%')).not.toBeInTheDocument();
  });

  it('⚠️ names where an unplaced camera would go, and why it cannot', async () => {
    stubApi({
      '/camera/assignments/capacity': report({
        suggestions: [
          { cameraId: 'cam2', runtimeId: null, failure: 'capability-unavailable' },
          { cameraId: 'cam3', runtimeId: 'inference' },
        ],
      }),
    });
    authAs(['admin']);
    renderWithProviders(<RuntimeCapacityPage />, { store });

    expect(await screen.findByText(/Nowhere — capability-unavailable/)).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /cam3/ });
    expect(within(row).getByText('inference')).toBeInTheDocument();
  });
});
