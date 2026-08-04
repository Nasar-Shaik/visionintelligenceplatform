/**
 * System Health (P-6.4) — the screen that replaced the `/health` placeholder.
 *
 * ⚠️ **Almost every test here drives a failure.** A health page is the one screen where a suite that
 * only ever sees a healthy deployment proves nothing: the whole value of the surface is what it says
 * when something is wrong, and "green when everything is green" is satisfied equally well by a
 * hard-coded tick. So each case feeds a real report shape and asserts the **word** an operator
 * reads — not that a row exists, and never only its colour.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { SystemHealthPage } from './SystemHealthPage';

function authAs(roles: string[]) {
  store.dispatch(
    authenticated({
      user: { id: 'usr_me', email: 'admin@northgate.demo', roles },
      tenantId: 'tnt_demo_retail',
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

const component = (over: Record<string, unknown>) => ({
  kind: 'service',
  state: 'ready',
  checks: [],
  observedAt: '2026-08-04T12:00:00.000Z',
  ...over,
});

function mockHealth(components: Record<string, unknown>[], status = 200) {
  server.use(
    mswHttp.get('/api/system/health', () => {
      if (status !== 200) {
        return HttpResponse.json(
          { success: false, error: { code: 'forbidden', message: 'nope' } },
          { status },
        );
      }
      return HttpResponse.json({
        success: true,
        data: { components, derivedAt: '2026-08-04T12:00:00.000Z', cacheTtlMs: 5000 },
      });
    }),
  );
}

const render = () => renderWithProviders(<SystemHealthPage />, { store });

describe('SystemHealthPage', () => {
  it('names each state in words, not only in colour', async () => {
    mockHealth([
      component({ id: 'tenant', label: 'Tenant', state: 'ready' }),
      component({ id: 'events', label: 'Events', state: 'degraded', detail: 'mongo: refused' }),
      component({ id: 'media', label: 'Media', state: 'unreachable', detail: 'no answer' }),
      component({
        id: 'x',
        label: 'Realtime',
        kind: 'capability',
        state: 'not-configured',
        detail: 'off',
      }),
      component({
        id: 'y',
        label: 'Live video',
        kind: 'capability',
        state: 'not-built',
        detail: 'P-8',
      }),
      component({
        id: 'z',
        label: 'Odd',
        state: 'unknown',
        detail: 'answered with something else',
      }),
    ]);
    authAs(['admin']);
    render();

    expect(await screen.findByText('Tenant')).toBeInTheDocument();
    /*
     * ⚠️ Seven states cannot be told apart by hue — three are some shade of "not working" and two of
     * those are nobody's fault. The word is the primary channel; the colour is decoration.
     */
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText('Not built')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  /**
   * ⚠️ The single most important assertion in this file. "All systems operational" is only true if
   * every component is `ready`, and `unknown` is not `ready` — an unexercised dependency and a
   * working one look identical from here, and only one of them is a claim we may make.
   */
  it('never reports everything healthy while something is unknown', async () => {
    mockHealth([
      component({ id: 'tenant', label: 'Tenant', state: 'ready' }),
      component({ id: 'odd', label: 'Odd', state: 'unknown', detail: 'nothing reports on it' }),
    ]);
    authAs(['admin']);
    render();

    expect(await screen.findByText(/1 component reports nothing/i)).toBeInTheDocument();
    expect(screen.queryByText(/^All \d+ components report healthy\.$/)).not.toBeInTheDocument();
  });

  it('says everything is healthy only when it is', async () => {
    mockHealth([
      component({ id: 'tenant', label: 'Tenant', state: 'ready' }),
      component({ id: 'events', label: 'Events', state: 'ready' }),
    ]);
    authAs(['admin']);
    render();

    expect(await screen.findByText('All 2 components report healthy.')).toBeInTheDocument();
  });

  /**
   * ⚠️ A capability that this release does not contain must never count as a problem. "Live video:
   * not built" is a roadmap fact; folding it into the outage count would train an operator to
   * ignore the banner that exists to be believed.
   */
  it('does not count a not-built capability as something needing attention', async () => {
    mockHealth([
      component({ id: 'tenant', label: 'Tenant', state: 'ready' }),
      component({
        id: 'live',
        label: 'Live video',
        kind: 'capability',
        state: 'not-built',
        detail: 'P-8',
      }),
    ]);
    authAs(['admin']);
    render();

    expect(
      await screen.findByText('The one component that reports in is healthy.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    // …and it is still on the page, with its reason.
    expect(screen.getByText('Live video')).toBeInTheDocument();
    expect(screen.getByText('P-8')).toBeInTheDocument();
  });

  it('leads with what is broken, and names it', async () => {
    mockHealth([
      component({ id: 'tenant', label: 'Tenant', state: 'ready' }),
      component({ id: 'events', label: 'Events', state: 'unreachable', detail: 'did not answer' }),
    ]);
    authAs(['admin']);
    render();

    expect(await screen.findByText(/Part of the platform is not answering/)).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/1 component needs attention/)).toBeInTheDocument();
    expect(alert.textContent).toContain('Events');
  });

  /**
   * ⚠️ Every state except `ready` owes the operator a sentence. "Events: unavailable" is a light;
   * "did not answer within 2000 ms" is something to act on.
   */
  it('shows the reason, and the failing checks behind it', async () => {
    mockHealth([
      component({
        id: 'events',
        label: 'Events',
        state: 'degraded',
        detail: 'mongo: connection refused',
        checks: [{ name: 'mongo', status: 'fail', detail: 'connection refused' }],
      }),
    ]);
    authAs(['admin']);
    render();

    expect(await screen.findByText('mongo: connection refused')).toBeInTheDocument();
    expect(screen.getByText(/mongo — connection refused/)).toBeInTheDocument();
  });

  it('puts what is actionable first, and does not reshuffle on every poll', async () => {
    mockHealth([
      component({ id: 'a', label: 'Alpha', state: 'ready' }),
      component({ id: 'b', label: 'Bravo', state: 'unreachable', detail: 'down' }),
      component({ id: 'c', label: 'Charlie', state: 'degraded', detail: 'slow' }),
      component({ id: 'd', label: 'Delta', state: 'unknown', detail: 'silent' }),
    ]);
    authAs(['admin']);
    render();

    await screen.findByText('Alpha');
    const labels = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector('p')?.textContent ?? '');
    // unreachable → degraded → unknown → ready. ⚠️ `unknown` outranks `ready`: a component nothing
    // reports on is the one whose failure has not been discovered yet.
    expect(labels).toEqual(['Bravo', 'Charlie', 'Delta', 'Alpha']);
  });

  /**
   * ⚠️ "You may not see this" and "nothing is wrong" are different sentences, and rendering an empty
   * page for the second would let the person least able to check read it as an all-clear.
   */
  it('tells an unauthorized viewer that the restriction is about them, not the platform', async () => {
    mockHealth([]);
    authAs(['viewer']);
    render();

    expect(await screen.findByText('Not authorized')).toBeInTheDocument();
    expect(
      screen.getByText(/says nothing about whether the platform is healthy/i),
    ).toBeInTheDocument();
  });

  it('treats a 403 from the gateway the same way the local check does', async () => {
    mockHealth([], 403);
    /* The UI mirror says yes; the server says no. The server wins, and the copy is identical. */
    authAs(['admin']);
    render();

    expect(await screen.findByText('Not authorized')).toBeInTheDocument();
  });

  it('surfaces a failure to reach the report at all, rather than an empty page', async () => {
    server.use(mswHttp.get('/api/system/health', () => HttpResponse.error()));
    authAs(['admin']);
    render();

    /*
     * ⚠️ The failure is the answer, so it is shown rather than retried into. `retry: false` on the
     * query exists for this: three silent attempts would hide a gateway outage for the seconds it
     * matters most.
     */
    expect(await screen.findByText('Couldn’t load')).toBeInTheDocument();
    expect(screen.queryByText(/components report healthy/)).not.toBeInTheDocument();
  });

  /**
   * ⚠️ **Found by stopping the gateway with the page open.** The whole report was replaced by
   * "Couldn't load · Request failed (502)" — every row gone, during the exact outage this page
   * exists to report, and the operator loses the last thing the platform managed to say about
   * itself. A reading from twenty seconds ago is not current, but it is the only context there is.
   */
  it('⚠️ keeps the last reading when a refresh fails, and says it is stale', async () => {
    let calls = 0;
    server.use(
      mswHttp.get('/api/system/health', () => {
        calls += 1;
        if (calls > 1) return HttpResponse.error();
        return HttpResponse.json({
          success: true,
          data: {
            components: [component({ id: 'tenant', label: 'Tenant', state: 'ready' })],
            derivedAt: '2026-08-04T12:00:00.000Z',
            cacheTtlMs: 5000,
          },
        });
      }),
    );
    authAs(['admin']);
    render();

    await screen.findByText('Tenant');
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByText(/could not be refreshed/i)).toBeInTheDocument();
    // The rows survive — and are labelled as a past reading rather than presented as current.
    expect(screen.getByText('Tenant')).toBeInTheDocument();
    expect(screen.getByText(/^Last known:/)).toBeInTheDocument();
    expect(screen.queryByText('Couldn’t load')).not.toBeInTheDocument();
  });

  it('re-reads on demand', async () => {
    let calls = 0;
    server.use(
      mswHttp.get('/api/system/health', () => {
        calls += 1;
        return HttpResponse.json({
          success: true,
          data: {
            components: [component({ id: 'tenant', label: 'Tenant', state: 'ready' })],
            derivedAt: '2026-08-04T12:00:00.000Z',
            cacheTtlMs: 5000,
          },
        });
      }),
    );
    authAs(['admin']);
    render();

    await screen.findByText('Tenant');
    expect(calls).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(calls).toBe(2));
  });
});
