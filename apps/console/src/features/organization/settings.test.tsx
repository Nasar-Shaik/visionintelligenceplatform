/**
 * Tenant settings (P-6.3) — the screen that replaced the last `/settings` placeholder.
 *
 * Written around the two things that separate a settings page from a PATCH form: it must say what
 * cannot be changed and why, and it must not let one administrator silently overwrite another.
 * Every render state is exercised, because a settings screen is where a customer first meets the
 * product's honesty about its own limits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { Toaster } from '@/ui';
import { SettingsPage } from './SettingsPage';

const TENANT = 'tnt_demo_retail';

function authAs(roles: string[], tenantId: string = TENANT) {
  store.dispatch(
    authenticated({
      user: { id: 'usr_me', email: 'admin@northgate.demo', roles },
      tenantId,
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

const TENANT_RECORD = {
  id: TENANT,
  slug: 'northgate',
  name: 'Northgate Retail Group',
  status: 'active',
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-07-20T11:30:00.000Z',
};

function mockTenant(record: unknown = TENANT_RECORD) {
  server.use(
    mswHttp.get('/api/tenant/tenants/:id', () =>
      HttpResponse.json({ success: true, data: record }),
    ),
  );
}

const renderPage = () =>
  renderWithProviders(
    <>
      <SettingsPage />
      <Toaster />
    </>,
    { store },
  );

describe('SettingsPage', () => {
  it('shows the organisation and what cannot be changed', async () => {
    mockTenant();
    authAs(['admin']);
    renderPage();

    expect(await screen.findByLabelText('Organisation name')).toHaveValue('Northgate Retail Group');
    expect(screen.getByText('northgate')).toBeInTheDocument();
    expect(screen.getByText(TENANT)).toBeInTheDocument();
    // ⚠️ The reason is on screen, not only in the code. An immutable field with no explanation
    // reads as a missing feature.
    expect(screen.getByText(/Immutable\. Used as a key and namespace prefix/)).toBeInTheDocument();
  });

  it('⚠️ shows status read-only, and says it is not enforced', async () => {
    /*
     * The backend accepts `status`, so a form could offer it. It must not: nothing in identity, the
     * gateway or @vip/tenancy refuses a request because a tenant is suspended, so a Suspend button
     * would claim to lock everyone out and do nothing. This asserts the honesty, not the absence.
     */
    mockTenant({ ...TENANT_RECORD, status: 'suspended' });
    authAs(['admin']);
    renderPage();

    expect(await screen.findByText('suspended')).toBeInTheDocument();
    expect(screen.getByText('not enforced')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /status/i })).not.toBeInTheDocument();
  });

  it('renames the tenant, sending the version it was shown', async () => {
    mockTenant();
    let body: Record<string, unknown> | undefined;
    server.use(
      mswHttp.patch('/api/tenant/tenants/:id', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          success: true,
          data: { ...TENANT_RECORD, name: body.name, updatedAt: '2026-08-04T12:00:00.000Z' },
        });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    const field = await screen.findByLabelText('Organisation name');
    await user.clear(field);
    await user.type(field, 'Northgate Security Ltd');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      name: 'Northgate Security Ltd',
      // ⚠️ The concurrency token the page was rendered from. Omitting it is how silent overwrites happen.
      expectedUpdatedAt: '2026-07-20T11:30:00.000Z',
    });
  });

  it('⚠️ renders a conflict inline and refetches, rather than a toast that can be missed', async () => {
    const gets = vi.fn();
    server.use(
      mswHttp.patch('/api/tenant/tenants/:id', () =>
        HttpResponse.json(
          {
            success: false,
            error: { code: 'conflict', message: 'this tenant was changed by someone else' },
          },
          { status: 409 },
        ),
      ),
      /*
       * ⚠️ The first GET is what this administrator loaded; every later one is what the *other*
       * administrator left behind. Serving the same record to both — which an earlier version of
       * this test did — leaves `updatedAt` unchanged, so nothing detects a change and the test
       * fails for a reason that has nothing to do with the page.
       */
      mswHttp.get('/api/tenant/tenants/:id', () => {
        const first = gets.mock.calls.length === 0;
        gets();
        return HttpResponse.json({
          success: true,
          data: first
            ? TENANT_RECORD
            : {
                ...TENANT_RECORD,
                name: 'Renamed By Someone Else',
                updatedAt: '2026-08-04T13:00:00.000Z',
              },
        });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    const field = await screen.findByLabelText('Organisation name');
    await user.clear(field);
    await user.type(field, 'My Version');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText(/Someone else changed these settings while you were editing/),
    ).toBeInTheDocument();

    /*
     * ⚠️ And the field now shows what is actually stored. Leaving the administrator's rejected text
     * in the box invites them to press Save again against the same stale version, which fails the
     * same way — a loop the page would have created for them.
     */
    await waitFor(() => expect(field).toHaveValue('Renamed By Someone Else'));
    expect(gets.mock.calls.length).toBeGreaterThan(1);
  });

  it('refuses to save an empty or over-long name, and says which', async () => {
    mockTenant();
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    const field = await screen.findByLabelText('Organisation name');
    await user.clear(field);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('A name is required.');

    await user.type(field, 'x'.repeat(201));
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Too long — 201 of 200 characters.');
  });

  it('discards an edit back to what is stored', async () => {
    mockTenant();
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    const field = await screen.findByLabelText('Organisation name');
    await user.type(field, ' Holdings');
    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(field).toHaveValue('Northgate Retail Group');
  });

  it('shows a viewer the settings with the field disabled and no save control', async () => {
    mockTenant();
    authAs(['viewer']);
    renderPage();

    // A viewer holds `*:read`, so the API would answer them — hiding the page would be theatre.
    expect(await screen.findByLabelText('Organisation name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.getByText('Only an administrator can change this.')).toBeInTheDocument();
  });

  it('surfaces a backend failure instead of an empty form', async () => {
    server.use(
      mswHttp.get('/api/tenant/tenants/:id', () =>
        HttpResponse.json(
          { success: false, error: { code: 'forbidden', message: 'nope' } },
          { status: 403 },
        ),
      ),
    );
    authAs(['admin']);
    renderPage();
    expect(await screen.findByText(/don’t have permission/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Organisation name')).not.toBeInTheDocument();
  });

  it('⚠️ a session with no tenant is unavailable, not empty', async () => {
    /*
     * "There is nothing here" and "we could not ask" are different claims. A signed-in session
     * carrying no tenant is malformed — telling the administrator their organisation is empty
     * would be false, and would send them looking in the wrong place.
     */
    mockTenant();
    authAs(['admin'], '');
    renderPage();
    expect(await screen.findByText(/does not carry a tenant/i)).toBeInTheDocument();
  });

  it('refuses the page outright without tenant:read', () => {
    mockTenant();
    store.dispatch(
      authenticated({
        user: { id: 'usr_me', email: 'nobody@northgate.demo', roles: [] },
        tenantId: TENANT,
        permissions: [],
      }),
    );
    renderPage();
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
  });
});

describe('branding panel', () => {
  it('states that branding is deployment-wide, not per-tenant', async () => {
    mockTenant();
    authAs(['admin']);
    renderPage();
    /*
     * ⚠️ An administrator who assumes this is per-tenant will set a colour for one customer and
     * change it for all of them. The sentence is the feature.
     */
    expect(
      await screen.findByText(/applies to the whole deployment, not to this\s+organisation alone/i),
    ).toBeInTheDocument();
  });

  it('reports the accent colour’s WCAG ratio rather than asserting it passes', async () => {
    mockTenant();
    authAs(['admin']);
    renderPage();
    // No colour is configured in the test environment, so it says exactly that.
    expect(await screen.findByText(/built-in accent is in use/i)).toBeInTheDocument();
  });
});
