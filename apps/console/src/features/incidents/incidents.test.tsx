import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { IncidentsPage } from './IncidentsPage';

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

const INCIDENT = {
  id: 'inc-1',
  tenantId: 'tnt_acme',
  status: 'raised',
  severity: 'critical',
  title: 'Person detected after hours',
  category: 'perception',
  source: {
    ruleId: 'rule-1',
    ruleVersion: 2,
    ruleName: 'Loitering',
    candidateId: 'cand-1',
    dedupKey: 'dk-1',
  },
  triggeredBy: {
    eventId: 'ev-1',
    eventType: 'perception.person.detected',
    cameraId: 'cam-1',
    occurredAt: '2026-07-29T11:00:00.000Z',
  },
  matchedCount: 1,
  version: 1,
  correlationId: 'corr-abc123',
  causationId: 'cand-1',
  history: [{ from: null, to: 'raised', at: '2026-07-29T11:00:01.000Z', by: 'system' }],
  raisedAt: '2026-07-29T11:00:01.000Z',
  updatedAt: '2026-07-29T11:00:01.000Z',
};

function mockList(items: unknown[]) {
  server.use(
    mswHttp.get('/api/workflow/incidents', () =>
      HttpResponse.json({ success: true, data: { items } }),
    ),
  );
}

describe('IncidentsPage', () => {
  it('lists incidents with severity and status', async () => {
    mockList([INCIDENT]);
    authAs(['operator']);
    renderWithProviders(<IncidentsPage />, { store });

    expect(await screen.findByText('Person detected after hours')).toBeInTheDocument();
    // Status badge (a <span>) — distinct from the hidden native <option> the Select renders.
    expect(screen.getByText('Raised', { selector: 'span' })).toBeInTheDocument();
  });

  it('shows an empty state when nothing is raised', async () => {
    mockList([]);
    authAs(['operator']);
    renderWithProviders(<IncidentsPage />, { store });
    expect(await screen.findByText(/no incidents/i)).toBeInTheDocument();
  });

  it('opens the detail drawer and acknowledges (operator can ack)', async () => {
    mockList([INCIDENT]);
    server.use(
      mswHttp.get('/api/workflow/incidents/inc-1', () =>
        HttpResponse.json({ success: true, data: INCIDENT }),
      ),
    );
    let acked = false;
    server.use(
      mswHttp.post('/api/workflow/incidents/inc-1/ack', () => {
        acked = true;
        return HttpResponse.json({
          success: true,
          data: { ...INCIDENT, status: 'acknowledged', version: 2 },
        });
      }),
    );
    authAs(['operator']);
    const user = userEvent.setup();
    renderWithProviders(<IncidentsPage />, { store });

    await user.click(await screen.findByText('Person detected after hours'));
    // Drawer shows lifecycle + rule provenance.
    expect(await screen.findByText('Loitering')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /acknowledge/i }));
    await waitFor(() => expect(acked).toBe(true));
  });

  it('hides transition actions from a read-only viewer', async () => {
    mockList([INCIDENT]);
    server.use(
      mswHttp.get('/api/workflow/incidents/inc-1', () =>
        HttpResponse.json({ success: true, data: INCIDENT }),
      ),
    );
    authAs(['viewer']);
    const user = userEvent.setup();
    renderWithProviders(<IncidentsPage />, { store });

    await user.click(await screen.findByText('Person detected after hours'));
    expect(await screen.findByText('Loitering')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument();
  });
});
