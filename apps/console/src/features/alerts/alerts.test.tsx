import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { AlertsPage } from './AlertsPage';

function authAs(roles: string[]) {
  store.dispatch(
    authenticated({
      user: { id: 'u', email: 'ops@tenant', roles },
      tenantId: 'tnt_acme',
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

const NOTIFICATION = {
  id: 'ntf-1',
  tenantId: 'tnt_acme',
  incidentId: 'inc-1',
  channelId: 'ch-1',
  channelType: 'webhook',
  status: 'delivered',
  severity: 'high',
  title: 'Person detected after hours',
  correlationId: 'corr-abc123',
  causationId: 'inc-1',
  attempts: 1,
  deliveredAt: '2026-07-29T11:00:05.000Z',
  createdAt: '2026-07-29T11:00:02.000Z',
  updatedAt: '2026-07-29T11:00:05.000Z',
};

function mockList(items: unknown[]) {
  server.use(
    mswHttp.get('/api/notify/notifications', () =>
      HttpResponse.json({ success: true, data: { items } }),
    ),
  );
}

describe('AlertsPage', () => {
  it('lists delivery records with channel and status', async () => {
    mockList([NOTIFICATION]);
    authAs(['operator']);
    renderWithProviders(<AlertsPage />, { store });

    expect(await screen.findByText('Person detected after hours')).toBeInTheDocument();
    expect(screen.getByText('Webhook')).toBeInTheDocument();
    expect(screen.getByText('Delivered', { selector: 'span' })).toBeInTheDocument();
  });

  it('shows an empty state when there are no alerts', async () => {
    mockList([]);
    authAs(['operator']);
    renderWithProviders(<AlertsPage />, { store });
    expect(await screen.findByText(/no alerts/i)).toBeInTheDocument();
  });

  it('acknowledges a delivered alert (operator can ack)', async () => {
    mockList([NOTIFICATION]);
    let acked = false;
    server.use(
      mswHttp.post('/api/notify/notifications/ntf-1/ack', () => {
        acked = true;
        return HttpResponse.json({
          success: true,
          data: { ...NOTIFICATION, status: 'acked', ackedBy: 'ops@tenant' },
        });
      }),
    );
    authAs(['operator']);
    const user = userEvent.setup();
    renderWithProviders(<AlertsPage />, { store });

    await user.click(await screen.findByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(acked).toBe(true));
  });

  it('hides the ack action from a read-only viewer', async () => {
    mockList([NOTIFICATION]);
    authAs(['viewer']);
    renderWithProviders(<AlertsPage />, { store });

    expect(await screen.findByText('Person detected after hours')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
  });
});
