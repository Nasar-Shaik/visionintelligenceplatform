/**
 * The Event Bridge page (P-8 Phase 5).
 *
 * ⚠️ **Most of these drive an ABSENCE or a distinction, not a happy path.** The page's whole job is
 * to keep four different reasons a frame did not become an event apart, and to refuse to report a
 * broker as healthy when nothing has been published. A suite that only feeds a working bridge is
 * satisfied equally well by a page that prints zeroes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { EventBridgePage } from './EventBridgePage';
import type { EventBridgeStats } from './useEventBridge';

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

const STATS: EventBridgeStats = {
  enabled: true,
  offered: 400,
  published: 120,
  detectionsPublished: 240,
  rejected: 0,
  suppressed: 280,
  droppedQueueFull: 0,
  droppedOutOfOrder: 3,
  delayed: 1,
  retries: 2,
  failed: 0,
  queueDepth: 0,
  queuePerCamera: 16,
  activeCameras: 2,
  inflight: 0,
  publishMsAvg: 1.42,
  throughputPerSecond: 4.2,
  brokerStatus: 'up',
  lastPublishedAt: '2026-08-06T09:00:00.000Z',
  payloadSchemaVersion: '1.0',
  publisherVersion: '1.0.0',
};

function mockBridge(body: unknown) {
  server.use(
    mswHttp.get('/api/system/event-bridge', () => HttpResponse.json({ success: true, data: body })),
  );
}

describe('Event Bridge', () => {
  it('reports what the bridge published', async () => {
    authAs(['admin']);
    mockBridge(STATS);
    renderWithProviders(<EventBridgePage />, { store });

    expect(await screen.findByText('Broker reachable')).toBeInTheDocument();
    expect(screen.getByText('1.42 ms')).toBeInTheDocument();
    expect(screen.getByText('4.20/s')).toBeInTheDocument();
  });

  it('⚠️ shows the queue depth against its bound, because a depth alone says nothing', async () => {
    authAs(['admin']);
    mockBridge({ ...STATS, queueDepth: 12, queuePerCamera: 16 });
    renderWithProviders(<EventBridgePage />, { store });

    /* "12" reads as fine. "12 / 16" reads as four results away from shedding load. */
    expect(await screen.findByText('12 / 16')).toBeInTheDocument();
  });

  it('⚠️ keeps the four reasons a frame did not publish apart', async () => {
    authAs(['admin']);
    mockBridge(STATS);
    renderWithProviders(<EventBridgePage />, { store });

    /*
     * One combined "not published" figure would make a healthy busy system look identical to a
     * broken one — 280 suppressed frames on a quiet site is normal, and 280 failures is an outage.
     */
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('Suppressed')).toBeInTheDocument();
    expect(screen.getByText('Dropped')).toBeInTheDocument();
    expect(screen.getByText('Out of order')).toBeInTheDocument();
    expect(screen.getByText(/Only.*failed.*is a fault/i)).toBeInTheDocument();
  });

  it('⚠️ says the broker state is UNKNOWN before anything has published, not healthy', async () => {
    authAs(['admin']);
    mockBridge({
      ...STATS,
      published: 0,
      brokerStatus: 'unknown',
      publishMsAvg: null,
      throughputPerSecond: null,
      lastPublishedAt: undefined,
    });
    renderWithProviders(<EventBridgePage />, { store });

    /* Publishing nothing does not demonstrate a working broker (ADR-0039). */
    expect(await screen.findByText('The broker has not been contacted yet')).toBeInTheDocument();
    expect(screen.queryByText('Broker reachable')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not measured').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('0.00 ms')).not.toBeInTheDocument();
  });

  it('⚠️ a down broker says recording is unaffected, because that is the question asked next', async () => {
    authAs(['admin']);
    mockBridge({ ...STATS, brokerStatus: 'down', failed: 12, lastError: 'ECONNREFUSED' });
    renderWithProviders(<EventBridgePage />, { store });

    expect(await screen.findByText('The broker is not reachable')).toBeInTheDocument();
    expect(screen.getByText(/Recording is unaffected/)).toBeInTheDocument();
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
  });

  it('⚠️ says the bridge is OFF rather than showing zeroes that look like an outage', async () => {
    authAs(['admin']);
    mockBridge({ enabled: false, detail: 'the event bridge is not enabled in this deployment' });
    renderWithProviders(<EventBridgePage />, { store });

    expect(await screen.findByText('The event bridge is not enabled here')).toBeInTheDocument();
    expect(screen.queryByText('Broker reachable')).not.toBeInTheDocument();
  });

  it('⚠️ exposes no control — publishing is not something an operator steers', async () => {
    authAs(['admin']);
    mockBridge(STATS);
    const { container } = renderWithProviders(<EventBridgePage />, { store });
    await screen.findByText('Broker reachable');

    /*
     * No flush, drain, retry or per-camera toggle. A "flush queue" button would act on a queue
     * already draining as fast as the broker allows; per-camera enable/disable is Camera Processing
     * Assignment, which is not built (DEFINITION_OF_DONE).
     */
    expect(container.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    expect(screen.getByText(/Reported, not editable/)).toBeInTheDocument();
  });

  it('reports the publisher and payload versions separately', async () => {
    authAs(['admin']);
    mockBridge(STATS);
    renderWithProviders(<EventBridgePage />, { store });

    /* Three different questions; an operator asking "why did events change?" needs all three. */
    expect(await screen.findByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByText('1.0')).toBeInTheDocument();
  });

  it('⚠️ says the payload version was not observed rather than guessing a default', async () => {
    authAs(['admin']);
    mockBridge({ ...STATS, payloadSchemaVersion: undefined });
    renderWithProviders(<EventBridgePage />, { store });
    expect(await screen.findByText('Not observed')).toBeInTheDocument();
  });

  it('refuses a viewer — this is deployment state behind system:inspect', async () => {
    authAs(['viewer']);
    mockBridge(STATS);
    renderWithProviders(<EventBridgePage />, { store });
    expect(await screen.findByText('Not authorized')).toBeInTheDocument();
  });
});
