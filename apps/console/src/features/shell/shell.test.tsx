import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { render, screen } from '@testing-library/react';
import { server } from '@/test/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { permissionsForRoles } from '@vip/permissions';
import { Providers } from '@/app/providers';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { TooltipProvider } from '@/ui';
import { renderWithProviders } from '@/test/render';
import { Sidebar } from './Sidebar';
import { NAV_GROUPS } from './navModel';
import { AppShell } from './AppShell';

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

describe('Sidebar permission gating', () => {
  it('shows read surfaces for an operator but hides admin-only Settings', () => {
    authAs(['operator']);
    renderWithProviders(<Sidebar />, { store });
    expect(screen.getByRole('link', { name: /cameras/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /incidents/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('shows Settings for an admin', () => {
    authAs(['admin']);
    renderWithProviders(<Sidebar />, { store });
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });
});

describe('AppShell', () => {
  /**
   * ⚠️ The top bar shows the **organisation name**, falling back to the tenant id.
   *
   * It used to show only the id (`tnt_acme`) — an internal identifier a customer never chose,
   * which also made the Settings page's own description ("the name appears in the top bar")
   * untrue. Both states are asserted because the fallback is the one a test will silently sit on:
   * with no tenant fixture, a test that only checks the id passes whether the lookup works or not.
   */
  it('falls back to the tenant id while the organisation name is unknown', () => {
    authAs(['admin']);
    render(
      <Providers store={store}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<div>routed page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </Providers>,
    );
    expect(screen.getByText('tnt_acme')).toBeInTheDocument();
  });

  it('shows the organisation name once it resolves', async () => {
    server.use(
      mswHttp.get('/api/tenant/tenants/:tenantId', () =>
        HttpResponse.json({
          success: true,
          data: {
            id: 'tnt_acme',
            slug: 'acme',
            name: 'Acme Security Group',
            status: 'active',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z',
          },
        }),
      ),
    );
    authAs(['admin']);
    render(
      <Providers store={store}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<div>routed page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </Providers>,
    );
    expect(await screen.findByText('Acme Security Group')).toBeInTheDocument();
    // The id stays reachable as the tooltip — it is what support asks for.
    expect(screen.getByTitle('tnt_acme')).toBeInTheDocument();
  });

  /* Tenant display is covered by the two tests above; this one is about the layout composing. */
  it('renders the topbar, sidebar, and routed outlet', () => {
    authAs(['admin']);
    render(
      <Providers store={store}>
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<div>routed page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </Providers>,
    );
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByText('routed page')).toBeInTheDocument();
  });
});

/**
 * ⛔ **V-6 — two navigation items were both labelled "Investigations".**
 *
 * `/investigations` (analyse a recording) and `/workspace` (work an incident that already exists)
 * sat next to each other in the Investigate section under the same word, leading to entirely
 * different screens. An operator clicking "Investigations" got whichever they happened to hit.
 *
 * Found by P-8.5 Product Validation driving the real navigation in a browser — the certification's
 * own `getByRole('link', { name: /investigations/i })` matched two elements and could not proceed.
 * No test noticed, because each page renders perfectly on its own; the defect only exists in the
 * relationship between them.
 *
 * ⚠️ Asserted as a **general rule**, not as "these two differ". A test naming the two old labels
 * would pass forever while a third duplicate was added next year.
 */
describe('the navigation is unambiguous', () => {
  it('⛔ no two nav items share a label', () => {
    const labels = NAV_GROUPS.flatMap((s) => s.items.map((i) => i.label));
    const seen = new Map<string, number>();
    for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([l]) => l);
    expect(duplicated).toEqual([]);
  });

  it('⛔ no two nav items share a destination', () => {
    const routes = NAV_GROUPS.flatMap((s) => s.items.map((i) => i.to));
    expect(new Set(routes).size).toBe(routes.length);
  });
});
