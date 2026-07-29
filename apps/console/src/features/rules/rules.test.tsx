import { afterEach, describe, expect, it, vi } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { RulesListPage } from './RulesListPage';
import { RuleEditorPage } from './RuleEditorPage';

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

const RULE = {
  id: 'rule-1',
  tenantId: 'tnt_acme',
  name: 'Loitering after hours',
  description: 'Person in zone A',
  lifecycle: 'enabled',
  priority: 200,
  version: 3,
  eventTypes: ['perception.person.detected'],
  categories: ['perception'],
  severity: 'high',
  actions: [{ type: 'raise-incident' }],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

function mockRules(rules: unknown[]) {
  server.use(
    mswHttp.get('/api/rules/rules', () => HttpResponse.json({ success: true, data: rules })),
  );
}

describe('RulesListPage', () => {
  it('lists rules with lifecycle state and offers "New rule" to an author', async () => {
    mockRules([RULE]);
    authAs(['admin']);
    renderWithProviders(<RulesListPage />, { store });

    expect(await screen.findByText('Loitering after hours')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new rule/i })).toBeInTheDocument();
  });

  it('shows an empty state when there are no rules', async () => {
    mockRules([]);
    authAs(['admin']);
    renderWithProviders(<RulesListPage />, { store });
    expect(await screen.findByText(/no rules yet/i)).toBeInTheDocument();
  });

  it('toggles lifecycle via PATCH when disabling an enabled rule', async () => {
    mockRules([RULE]);
    const patched = vi.fn();
    server.use(
      mswHttp.patch('/api/rules/rules/:id', async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ success: true, data: { ...RULE, lifecycle: 'disabled' } });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderWithProviders(<RulesListPage />, { store });

    await user.click(await screen.findByRole('button', { name: /disable/i }));
    await waitFor(() => expect(patched).toHaveBeenCalledWith({ lifecycle: 'disabled' }));
  });
});

describe('RuleEditorPage (create)', () => {
  it('validates and POSTs a new rule', async () => {
    let created: unknown;
    server.use(
      mswHttp.post('/api/rules/rules', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ success: true, data: { ...RULE, id: 'rule-new' } });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/new' });

    await user.type(screen.getByLabelText('Name'), 'Tailgating');
    await user.click(screen.getByRole('button', { name: /create rule/i }));

    await waitFor(() => expect(created).toBeDefined());
    expect(created).toMatchObject({
      name: 'Tailgating',
      actions: [{ type: 'raise-incident' }],
    });
  });

  it('blocks an operator without rule:create', () => {
    authAs(['viewer']);
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/new' });
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
  });
});
