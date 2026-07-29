import { describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { EventsPage } from './EventsPage';

const EVENTS = [
  {
    id: 'ev-1',
    type: 'perception.person.detected',
    priority: 'critical',
    cameraId: 'cam-1',
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-aaaa1111',
    confidence: 0.84,
  },
  {
    id: 'ev-2',
    type: 'perception.vehicle.detected',
    priority: 'low',
    cameraId: 'cam-2',
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-bbbb2222',
    confidence: 0.6,
  },
];

function mockEvents(events: unknown[]) {
  server.use(
    mswHttp.get('/api/events/events', () => HttpResponse.json({ success: true, data: { events } })),
  );
}

describe('EventsPage', () => {
  it('lists events and filters by the search box', async () => {
    mockEvents(EVENTS);
    const user = userEvent.setup();
    renderWithProviders(<EventsPage />);

    expect(await screen.findByText('perception.person.detected')).toBeInTheDocument();
    expect(screen.getByText('perception.vehicle.detected')).toBeInTheDocument();
    // Confidence rendered as a percentage.
    expect(screen.getByText('84%')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search'), 'vehicle');
    await waitFor(() =>
      expect(screen.queryByText('perception.person.detected')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('perception.vehicle.detected')).toBeInTheDocument();
  });

  it('shows an empty state when there are no events', async () => {
    mockEvents([]);
    renderWithProviders(<EventsPage />);
    expect(await screen.findByText(/no events match/i)).toBeInTheDocument();
  });
});
