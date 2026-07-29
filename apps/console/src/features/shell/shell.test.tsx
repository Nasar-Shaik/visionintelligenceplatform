import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { permissionsForRoles } from '@vip/permissions';
import { Providers } from '@/app/providers';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { TooltipProvider } from '@/ui';
import { renderWithProviders } from '@/test/render';
import { Sidebar } from './Sidebar';
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
  it('renders the topbar (tenant), sidebar, and routed outlet', () => {
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
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByText('routed page')).toBeInTheDocument();
  });
});
