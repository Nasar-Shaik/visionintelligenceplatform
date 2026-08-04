/**
 * User administration (P-6.2, TD-44) — the screen that closed the last pilot blocker.
 *
 * The tests are written around the sentence that justified the milestone: *an offboarded employee
 * keeps access to a security product*. So the assertions are about consequences an administrator
 * must be able to see — that disabling ends sessions, that it cannot be done to oneself, that
 * nothing is deleted — rather than about the presence of controls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { Toaster } from '@/ui';
import { UsersPage } from './UsersPage';

const ME = 'usr_me';

function authAs(roles: string[], id = ME) {
  store.dispatch(
    authenticated({
      user: { id, email: 'admin@northgate.demo', roles },
      tenantId: 'tnt_demo_retail',
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

const USERS = [
  {
    id: ME,
    tenantId: 'tnt_demo_retail',
    email: 'admin@northgate.demo',
    roles: ['admin'],
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 'usr_leaver',
    tenantId: 'tnt_demo_retail',
    email: 'leaver@northgate.demo',
    roles: ['operator'],
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  },
  {
    id: 'usr_gone',
    tenantId: 'tnt_demo_retail',
    email: 'gone@northgate.demo',
    roles: ['viewer'],
    status: 'disabled',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
  },
];

function mockUsers(users: unknown[] = USERS) {
  server.use(
    mswHttp.get('/api/identity/users', () => HttpResponse.json({ success: true, data: users })),
  );
}

function rowFor(email: string) {
  return screen.getByRole('row', { name: new RegExp(email) });
}

/**
 * ⚠️ The `Toaster` is mounted alongside the page, because on this screen the toast **is** the
 * result. "Disabled" is visible in the table; "and that ended two live sessions" exists nowhere
 * else. A harness without it would let the count regress silently.
 */
function renderPage() {
  return renderWithProviders(
    <>
      <UsersPage />
      <Toaster />
    </>,
    { store },
  );
}

describe('UsersPage', () => {
  it('lists who can sign in, and says plainly who cannot', async () => {
    mockUsers();
    authAs(['admin']);
    renderPage();

    expect(await screen.findByText('leaver@northgate.demo')).toBeInTheDocument();
    expect(within(rowFor('gone@northgate.demo')).getByText('Disabled')).toBeInTheDocument();
    expect(within(rowFor('leaver@northgate.demo')).getByText('Active')).toBeInTheDocument();
    // The count is the thing an administrator scans for during an offboarding review.
    expect(screen.getByText('2 active of 3')).toBeInTheDocument();
  });

  it('disables a user and reports how many sessions that ended', async () => {
    mockUsers();
    const disabled = vi.fn();
    server.use(
      mswHttp.post('/api/identity/users/:id/disable', ({ params }) => {
        disabled(params.id);
        return HttpResponse.json({
          success: true,
          data: { user: { ...USERS[1], status: 'disabled' }, sessionsRevoked: 2 },
        });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Disable leaver@northgate.demo' }));
    // ⚠️ Confirmed, not immediate. Taking access away mid-shift has no undo from the console.
    expect(await screen.findByText(/Disable leaver@northgate.demo\?/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^disable$/i }));

    await waitFor(() => expect(disabled).toHaveBeenCalledWith('usr_leaver'));
    expect(await screen.findByText(/2 active session\(s\) ended/)).toBeInTheDocument();
  });

  it('tells the administrator that nothing is deleted', async () => {
    mockUsers();
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Disable leaver@northgate.demo' }));
    /*
     * ⚠️ This wording is load-bearing, not decoration. An administrator who believes "disable"
     * might erase the person's name from the incidents they handled will hesitate to use it — and
     * the account stays live. The dialog answers the question before it is asked.
     */
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
  });

  it('will not let an administrator disable their own account', async () => {
    mockUsers();
    authAs(['admin']);
    renderPage();

    const self = await screen.findByRole('button', { name: 'Disable admin@northgate.demo' });
    /*
     * ⚠️ Disabled, not hidden. A missing button reads as a bug; a disabled one with a reason reads
     * as a rule. The server refuses it independently — this is the courtesy, not the control.
     */
    expect(self).toBeDisabled();
    expect(self).toHaveAttribute('title', 'You cannot disable your own account');
  });

  it('re-enables a disabled user without touching their password', async () => {
    mockUsers();
    const enabled = vi.fn();
    server.use(
      mswHttp.post('/api/identity/users/:id/enable', ({ params }) => {
        enabled(params.id);
        return HttpResponse.json({ success: true, data: { ...USERS[2], status: 'active' } });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Re-enable gone@northgate.demo' }));
    await waitFor(() => expect(enabled).toHaveBeenCalledWith('usr_gone'));
    expect(await screen.findByText(/password is unchanged/i)).toBeInTheDocument();
  });

  it('changes a role through PATCH, carrying only roles', async () => {
    mockUsers();
    let body: unknown;
    server.use(
      mswHttp.patch('/api/identity/users/:id', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true, data: { ...USERS[1], roles: ['viewer'] } });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      within(await screen.findByRole('row', { name: /leaver/ })).getByRole('button', {
        name: 'Roles',
      }),
    );
    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Viewer' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // ⚠️ Roles only. A body that could also carry `status` would let a re-role lock someone out.
    await waitFor(() => expect(body).toEqual({ roles: ['viewer'] }));
  });

  it('refuses to save a role that has not changed', async () => {
    mockUsers();
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      within(await screen.findByRole('row', { name: /leaver/ })).getByRole('button', {
        name: 'Roles',
      }),
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('requires a password of at least 8 characters before a reset can be sent', async () => {
    mockUsers();
    authAs(['admin']);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Reset the password for leaver@northgate.demo' }),
    );
    await user.type(screen.getByLabelText('New password'), 'short');
    expect(screen.getByRole('button', { name: /set password/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('At least 8 characters');

    await user.type(screen.getByLabelText('New password'), 'enough!');
    expect(screen.getByRole('button', { name: /set password/i })).toBeEnabled();
  });

  it('shows an operator the list without any way to change it', async () => {
    mockUsers();
    authAs(['operator']);
    renderPage();

    /*
     * ⚠️ An operator holds `*:read`, so the API would answer them — hiding the page would be theatre.
     * What must be absent is every write control, and the assertion is on the *actions*, not on the
     * route being unreachable.
     */
    expect(await screen.findByText('leaver@northgate.demo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Disable / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add user/i })).not.toBeInTheDocument();
  });

  it('says what to do when there are no users rather than showing an empty table', async () => {
    mockUsers([]);
    authAs(['admin']);
    renderPage();
    expect(await screen.findByText(/no users yet/i)).toBeInTheDocument();
  });

  it('surfaces a failed load instead of an empty list', async () => {
    server.use(
      mswHttp.get('/api/identity/users', () =>
        HttpResponse.json(
          { success: false, error: { code: 'forbidden', message: 'missing permission' } },
          { status: 403 },
        ),
      ),
    );
    authAs(['admin']);
    renderPage();
    /*
     * ⚠️ "No users" and "we could not ask" are different claims, and rendering the second as the
     * first would tell an administrator their tenant is empty during an outage.
     */
    expect(await screen.findByText(/don’t have permission/i)).toBeInTheDocument();
    expect(screen.queryByText(/no users yet/i)).not.toBeInTheDocument();
  });
});
