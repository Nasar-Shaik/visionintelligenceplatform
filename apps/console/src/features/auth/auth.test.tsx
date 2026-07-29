import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Providers } from '@/app/providers';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { permissionsForRoles } from '@vip/permissions';
import { setAccessToken } from '@/lib/api/http';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { authClient } from './authClient';
import { tokenStore } from './tokenStore';
import { LoginPage } from './LoginPage';
import { RequireAuth } from './RequireAuth';
import { AuthedHome } from '@/routes/AuthedHome';

const TOKENS = {
  tokenType: 'Bearer' as const,
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 900,
};

function principal(roles: string[]) {
  return {
    principalId: 'usr_1',
    tenantId: 'tnt_1',
    email: 'ops@tenant',
    roles,
    permissions: [],
    scopes: [],
  };
}

function mockAuth(roles: string[] = ['operator']) {
  server.use(
    mswHttp.post('/api/identity/auth/login', () =>
      HttpResponse.json({ success: true, data: TOKENS }),
    ),
    mswHttp.post('/api/identity/auth/refresh', () =>
      HttpResponse.json({ success: true, data: TOKENS }),
    ),
    mswHttp.get('/api/identity/auth/me', () =>
      HttpResponse.json({ success: true, data: principal(roles) }),
    ),
  );
}

afterEach(() => {
  store.dispatch(signedOut());
  setAccessToken(null);
  tokenStore.clear();
});

describe('authClient', () => {
  it('logs in, hydrates the principal, and expands roles to permissions', async () => {
    mockAuth(['operator']);
    await authClient.login('tnt_1', { email: 'ops@tenant', password: 'pw' });

    const session = store.getState().session;
    expect(session.status).toBe('authenticated');
    expect(session.tenantId).toBe('tnt_1');
    expect(session.permissions).toEqual(permissionsForRoles(['operator']));
  });

  it('bootstrap with no refresh token stays unauthenticated', async () => {
    tokenStore.clear();
    await authClient.bootstrap();
    expect(store.getState().session.status).toBe('unauthenticated');
  });
});

describe('LoginPage', () => {
  beforeEach(() => mockAuth(['admin']));

  it('validates required fields before submitting', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { store });
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/tenant is required/i)).toBeInTheDocument();
    expect(screen.getByText(/enter a valid email/i)).toBeInTheDocument();
  });

  it('signs in with valid credentials', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { store });
    await user.type(screen.getByLabelText(/tenant/i), 'tnt_1');
    await user.type(screen.getByLabelText(/email/i), 'ops@tenant.com');
    await user.type(screen.getByLabelText(/password/i), 'secret');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(store.getState().session.status).toBe('authenticated'));
  });
});

describe('RequireAuth', () => {
  it('redirects to /login when unauthenticated, and renders the outlet when authed', () => {
    const tree = (
      <Providers store={store}>
        <MemoryRouter initialEntries={['/secret']}>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="/secret" element={<div>protected content</div>} />
            </Route>
            <Route path="/login" element={<div>login screen</div>} />
          </Routes>
        </MemoryRouter>
      </Providers>
    );

    store.dispatch(signedOut());
    const { unmount } = render(tree);
    expect(screen.getByText('login screen')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    unmount();

    store.dispatch(
      authenticated({
        user: { id: 'u', email: 'a@b', roles: ['viewer'] },
        tenantId: 't',
        permissions: [],
      }),
    );
    render(tree);
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });
});

describe('permission gating (AuthedHome)', () => {
  it('shows granted vs denied UI affordances by role', () => {
    store.dispatch(
      authenticated({
        user: { id: 'usr_1', email: 'ops@tenant', roles: ['operator'] },
        tenantId: 'tnt_1',
        permissions: permissionsForRoles(['operator']),
      }),
    );
    renderWithProviders(<AuthedHome />, { store });
    // operator has incident:ack (granted, success) but not rule:create (denied, neutral).
    expect(screen.getByText('incident:ack').className).toContain('text-success');
    expect(screen.getByText('rule:create').className).toContain('text-muted-foreground');
  });
});
