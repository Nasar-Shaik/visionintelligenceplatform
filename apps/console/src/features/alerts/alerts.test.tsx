/**
 * The Inbox (P-6.5) — the screen that replaced the delivery log.
 *
 * ⚠️ These test the screen's **claims on an operator's attention**, not its markup: that one incident
 * is one entry however many channels it used, that the queue filter is applied by the server rather
 * than by the browser, that a failed delivery is visible with its reason, and that acknowledging an
 * incident does not quietly clear a delivery that never arrived.
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
const notification = (over: Record<string, unknown>) => ({ ...NOTIFICATION, ...over });

/** Records every query the page sends, so "who did the filtering" is assertable. */
const queries: URLSearchParams[] = [];
function mockList(items: unknown[]) {
  queries.length = 0;
  server.use(
    mswHttp.get('/api/notify/notifications', ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json({ success: true, data: { items } });
    }),
  );
}

const render = () => renderWithProviders(<AlertsPage />, { store });

/*
 * ⚠️ With the toaster mounted, so what an operator is *told* can be asserted as rendered text rather
 * than as a spy on a function call. The shell mounts it in the running app; a test that stubs it out
 * can only prove the code asked for a message, never that anybody would have seen one.
 */
const renderWithToasts = () =>
  renderWithProviders(
    <>
      <AlertsPage />
      <Toaster />
    </>,
    { store },
  );

describe('AlertsPage — the inbox', () => {
  /**
   * ⚠️ The milestone in one assertion. Three channels, one incident, **one** entry — a screen that
   * listed it three times is the list this replaced.
   */
  it('shows one entry per incident, however many channels it used', async () => {
    mockList([
      notification({ id: 'a', channelId: 'c1', channelType: 'in-app' }),
      notification({ id: 'b', channelId: 'c2', channelType: 'webhook' }),
      notification({ id: 'c', channelId: 'c3', channelType: 'webhook' }),
    ]);
    authAs(['operator']);
    render();

    expect(await screen.findByText('Person detected after hours')).toBeInTheDocument();
    expect(screen.getAllByText('Person detected after hours')).toHaveLength(1);
    expect(screen.getByText(/reached 3 of 3 channels/i)).toBeInTheDocument();
  });

  /**
   * ⚠️ Filtering happens at the **server**. Fetching everything and filtering here answers correctly
   * for the rows that happen to be loaded and silently wrongly for the rest — which is exactly how
   * an unread count becomes a lie.
   */
  it('asks the server for the queue rather than filtering in the browser', async () => {
    mockList([NOTIFICATION]);
    authAs(['operator']);
    render();

    await screen.findByText('Person detected after hours');
    expect(queries[0]?.get('acknowledged')).toBe('false');
  });

  it('the delivery log is one click away, not deleted', async () => {
    mockList([
      notification({ id: 'a', channelType: 'in-app', status: 'delivered' }),
      notification({
        id: 'b',
        channelType: 'webhook',
        status: 'failed',
        lastError: 'connect ECONNREFUSED 10.0.0.9:443',
      }),
    ]);
    authAs(['operator']);
    render();

    await screen.findByText('Person detected after hours');
    // Collapsed by default: the operator sees incidents, not transports.
    expect(screen.queryByText('Webhook')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /show delivery detail/i }));
    expect(screen.getByText('Webhook')).toBeInTheDocument();
    expect(screen.getByText('In-app')).toBeInTheDocument();
    /*
     * ⚠️ "A failed delivery is visible in the console, with the reason" is a release exit criterion.
     * A failure whose cause is only in a service log is a failure nobody can act on.
     */
    expect(screen.getByText('connect ECONNREFUSED 10.0.0.9:443')).toBeInTheDocument();
  });

  /**
   * ⚠️ The two questions this screen must never collapse. Acknowledging says a human took the
   * incident; it says nothing about whether the customer's own system was told.
   */
  it('a delivery that never arrived stays visible on an acknowledged incident', async () => {
    mockList([
      notification({ id: 'a', channelType: 'in-app', status: 'acked', ackedBy: 'sam' }),
      notification({ id: 'b', channelType: 'webhook', status: 'failed', lastError: 'timeout' }),
    ]);
    authAs(['operator']);
    render();

    expect(await screen.findByText(/taken by sam/i)).toBeInTheDocument();
    expect(screen.getByText(/delivery that never arrived/i)).toBeInTheDocument();
    expect(screen.getByText(/Acknowledging an alert does not fix this/i)).toBeInTheDocument();
  });

  it('acknowledging acts on the whole incident, and only on what can be acknowledged', async () => {
    mockList([
      notification({ id: 'a', channelType: 'in-app', status: 'delivered' }),
      notification({ id: 'b', channelType: 'webhook', status: 'sent' }),
      notification({ id: 'c', channelType: 'webhook', status: 'failed' }),
    ]);
    const acked: string[] = [];
    server.use(
      mswHttp.post('/api/notify/notifications/:id/ack', ({ params }) => {
        acked.push(String(params.id));
        return HttpResponse.json({ success: true, data: notification({ status: 'acked' }) });
      }),
    );
    authAs(['operator']);
    render();

    await userEvent.click(await screen.findByRole('button', { name: /^acknowledge$/i }));
    await waitFor(() => expect(acked.sort()).toEqual(['a', 'b']));
    // ⚠️ `c` failed — there was no recipient, so there is nothing to record as received.
    expect(acked).not.toContain('c');
  });

  /**
   * ⚠️ **Losing a race is not a failure, and it must not read like one.**
   *
   * Two operators reaching for the same alert is ordinary shift work. The loser used to be told
   * "1 of 1 could not be acknowledged" — which sounds like the product broke and says nothing about
   * what happened or what to do. The server knows precisely who got there first; this asserts the
   * console shows *that* rather than a count of things that went wrong.
   */
  it('tells the operator who beat them to it, not that something went wrong', async () => {
    mockList([notification({ id: 'a', channelType: 'in-app', status: 'delivered' })]);
    server.use(
      mswHttp.post('/api/notify/notifications/:id/ack', () =>
        HttpResponse.json(
          {
            success: false,
            error: {
              code: 'conflict',
              message: 'this alert was acknowledged by sam@acme.test a moment ago',
            },
          },
          { status: 409 },
        ),
      ),
    );
    authAs(['operator']);
    renderWithToasts();

    await userEvent.click(await screen.findByRole('button', { name: /^acknowledge$/i }));
    expect(
      await screen.findByText(/acknowledged by sam@acme\.test a moment ago/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not be acknowledged/i)).not.toBeInTheDocument();
  });

  it('links every entry to the incident it belongs to', async () => {
    mockList([NOTIFICATION]);
    authAs(['operator']);
    render();

    const link = await screen.findByRole('link', { name: /open incident/i });
    expect(link).toHaveAttribute('href', '/workspace/inc-1');
  });

  /**
   * ⚠️ **A queue that cannot be refreshed is kept, and labelled.**
   *
   * Found by taking the gateway away with the page open against the deployment: twenty-five entries
   * were replaced by "Couldn't load · Request failed (502)" for the twelve seconds it took to come
   * back. The same defect P-6.4 found on System Health, on the screen an operator watches all shift
   * — and an operator whose queue empties cannot tell "nothing needs me" from "I cannot see".
   */
  it('keeps the queue when a refresh fails, and says the reading is stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockList([NOTIFICATION]);
    authAs(['operator']);
    render();
    expect(await screen.findByText('Person detected after hours')).toBeInTheDocument();

    /* Every later request fails — the refetch, and its retries. */
    server.use(
      mswHttp.get('/api/notify/notifications', () =>
        HttpResponse.json(
          { success: false, error: { code: 'bad_gateway', message: 'Request failed (502)' } },
          { status: 502 },
        ),
      ),
    );

    /*
     * ⚠️ The page's **own 20-second poll** is what fails here, which is what happens in the
     * deployment. Switching the filter would not do: that is a different query key with no cached
     * reading to keep, so it exercises the empty-error path and proves nothing about this one. And a
     * 10-second `staleTime` means switching away and back would not refetch at all.
     */
    await vi.advanceTimersByTimeAsync(21_000); // the poll
    await vi.advanceTimersByTimeAsync(10_000); // its two retries and their backoff

    expect(await screen.findByText(/could not be refreshed/i)).toBeInTheDocument();
    /* ⚠️ And the alert is still on screen — the point of keeping it. */
    expect(screen.getByText('Person detected after hours')).toBeInTheDocument();
    /* ⚠️ And it must never read as an empty queue. */
    expect(screen.queryByText('Nothing is waiting')).not.toBeInTheDocument();
    expect(screen.queryByText('No alerts')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  /**
   * ⚠️ **A split incident is a taken incident.**
   *
   * Acknowledging is per delivery; the operator acted on an incident. Two operators pressing at the
   * same moment can take one channel each — measured on the deployment — and both were then told
   * "1 of 2 could not be acknowledged", on an incident that is now unambiguously taken. The message
   * has to follow what became true, not the tally of requests.
   */
  it('reports a race-split acknowledgement as taken, not as a failure', async () => {
    mockList([
      notification({ id: 'a', channelId: 'c1', channelType: 'in-app', status: 'delivered' }),
      notification({ id: 'b', channelId: 'c2', channelType: 'webhook', status: 'delivered' }),
    ]);
    server.use(
      mswHttp.post('/api/notify/notifications/:id/ack', ({ params }) =>
        params.id === 'a'
          ? HttpResponse.json({ success: true, data: notification({ status: 'acked' }) })
          : HttpResponse.json(
              {
                success: false,
                error: {
                  code: 'conflict',
                  message: 'this alert was acknowledged by sam@acme.test a moment ago',
                },
              },
              { status: 409 },
            ),
      ),
    );
    authAs(['operator']);
    renderWithToasts();

    await userEvent.click(await screen.findByRole('button', { name: /^acknowledge$/i }));
    expect(await screen.findByText('Alert acknowledged')).toBeInTheDocument();
    expect(screen.queryByText(/could not be acknowledged/i)).not.toBeInTheDocument();
  });

  it('hides the ack action from a read-only viewer', async () => {
    mockList([NOTIFICATION]);
    authAs(['viewer']);
    render();

    expect(await screen.findByText('Person detected after hours')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^acknowledge$/i })).not.toBeInTheDocument();
  });

  /**
   * ⚠️ An empty queue and an empty product are different facts. "Nothing is waiting" is good news;
   * "no alerts" is a statement about the deployment, and showing the second when the first is true
   * makes an operator wonder whether the system is working.
   */
  it('distinguishes an empty queue from an empty log', async () => {
    mockList([]);
    authAs(['operator']);
    const { unmount } = render();
    expect(await screen.findByText('Nothing is waiting')).toBeInTheDocument();
    unmount();

    mockList([]);
    render();
    await userEvent.click(screen.getByLabelText('Triage filter'));
    await userEvent.click(await screen.findByRole('option', { name: 'Everything' }));
    expect(await screen.findByText('No alerts')).toBeInTheDocument();
  });

  it('an unacknowledged entry is visually distinct from a handled one', async () => {
    mockList([
      notification({ id: 'a', incidentId: 'inc-1', title: 'Waiting' }),
      notification({
        id: 'b',
        incidentId: 'inc-2',
        title: 'Handled',
        status: 'acked',
        ackedBy: 'sam',
      }),
    ]);
    authAs(['operator']);
    render();

    const waiting = await screen.findByText('Waiting');
    const handled = screen.getByText('Handled');
    // ⚠️ Weight, not colour: an inbox where everything looks the same is a list.
    expect(waiting.className).toContain('font-semibold');
    expect(handled.className).not.toContain('font-semibold');
  });

  it('counts incidents rather than delivery records', async () => {
    mockList([
      notification({ id: 'a', incidentId: 'inc-1', channelType: 'in-app' }),
      notification({ id: 'b', incidentId: 'inc-1', channelType: 'webhook' }),
      notification({ id: 'c', incidentId: 'inc-2', title: 'Second incident' }),
    ]);
    authAs(['operator']);
    render();

    await screen.findByText('Person detected after hours');
    const bar = screen.getByText(/incidents$/);
    expect(within(bar).getByText('2 incidents')).toBeInTheDocument();
  });
});
