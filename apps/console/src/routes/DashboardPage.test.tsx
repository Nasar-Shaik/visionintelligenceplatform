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
    mswHttp.get('/api/camera/cameras', () => HttpResponse.json({ success: true, data: [CAMERA] })),
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
    // ...and the camera in the health panel.
    expect(screen.getByText('Lobby — East')).toBeInTheDocument();

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
      mswHttp.get('/api/camera/cameras', () => HttpResponse.json({ success: true, data: [] })),
      mswHttp.get('/api/notify/notifications', () =>
        HttpResponse.json({ success: true, data: { items: [] } }),
      ),
    );
    renderWithProviders(<DashboardPage />);
    expect(await screen.findByText(/no active incidents/i)).toBeInTheDocument();
    expect(screen.getByText(/no cameras registered/i)).toBeInTheDocument();
  });
});
