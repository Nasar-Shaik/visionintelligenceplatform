import { describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { DashboardPage } from './DashboardPage';

const RAISED_INCIDENT = {
  id: 'inc-1',
  status: 'raised',
  severity: 'critical',
  title: 'Intrusion — Zone A',
  triggeredBy: { cameraId: 'cam-1' },
  raisedAt: new Date().toISOString(),
};

const CAMERA = { id: 'cam-1', name: 'Lobby — East', health: { status: 'online' } };

function mockGateway() {
  server.use(
    mswHttp.get('/api/workflow/incidents', () =>
      HttpResponse.json({ success: true, data: { items: [RAISED_INCIDENT] } }),
    ),
    /* P-6.6: the list is paged, and the estate's total comes from the server's own count. */
    mswHttp.get('/api/camera/cameras', () =>
      HttpResponse.json({ success: true, data: { cameras: [CAMERA] } }),
    ),
    mswHttp.get('/api/camera/cameras/metrics', () =>
      HttpResponse.json({
        success: true,
        data: {
          window: 'day',
          windowStart: '2026-08-05T00:00:00.000Z',
          windowEnd: '2026-08-05T12:00:00.000Z',
          cameras: 1,
          sampled: false,
          camerasProbed: 0,
          camerasNeverProbed: 1,
          probes: 0,
          successes: 0,
          failures: 0,
        },
      }),
    ),
    mswHttp.get('/api/notify/notifications', () =>
      HttpResponse.json({ success: true, data: { items: [{ id: 'n-1' }, { id: 'n-2' }] } }),
    ),
  );
}

describe('DashboardPage', () => {
  it('aggregates read APIs into KPIs and panels', async () => {
    mockGateway();
    renderWithProviders(<DashboardPage />);

    // Active incident surfaces in the panel...
    expect(await screen.findByText('Intrusion — Zone A')).toBeInTheDocument();

    /*
     * ...and the camera name appears TWICE: once in the health panel, once on the incident card.
     * ⚠️ That second one is the P-5.9 fix. The incident card used to render the raw `cameraId`
     * (`cam-1`), because the prop was named `cameraName` and was handed an id — so this assertion
     * used to find exactly one match. `getAllByText` is the point of the test, not a workaround:
     * two matches is the correct count, and one would mean the id is back.
     */
    expect(screen.getAllByText('Lobby — East')).toHaveLength(2);
    expect(screen.queryByText('cam-1')).not.toBeInTheDocument();

    // KPIs: 1 active incident, 1/1 cameras online, 2 alerts.
    expect(screen.getByText('1', { selector: 'span' })).toBeInTheDocument(); // active incidents value
    expect(screen.getByText('1/1')).toBeInTheDocument(); // cameras online
    expect(screen.getByText('2', { selector: 'span' })).toBeInTheDocument(); // alerts
  });

  it('shows an empty state when there are no active incidents', async () => {
    server.use(
      mswHttp.get('/api/workflow/incidents', () =>
        HttpResponse.json({ success: true, data: { items: [] } }),
      ),
      mswHttp.get('/api/camera/cameras', () =>
        HttpResponse.json({ success: true, data: { cameras: [] } }),
      ),
      mswHttp.get('/api/notify/notifications', () =>
        HttpResponse.json({ success: true, data: { items: [] } }),
      ),
    );
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/no active incidents/i)).toBeInTheDocument();
    expect(screen.getByText(/no cameras registered/i)).toBeInTheDocument();
  });
});
