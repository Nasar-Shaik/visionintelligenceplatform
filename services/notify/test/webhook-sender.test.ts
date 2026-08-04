/**
 * The webhook transport's **reasons** — against a real HTTP server, on a real socket.
 *
 * ### ⚠️ Why this file exists
 *
 * *"A failed delivery is visible in the console, **with the reason**"* is a release exit criterion
 * for 0.5, and P-6.5's freeze pass found it being met to the letter and not at all in spirit: a
 * webhook to a dead host recorded `fetch failed`, and one that never answered recorded
 * `This operation was aborted`. Both are `undici` describing its own plumbing — neither tells an
 * operator whether to call the network team or the people who own the endpoint.
 *
 * The alert-engine tests inject their own outcome strings through a fake sender, so nothing pinned
 * what the real transport actually writes into `lastError`. These assertions are the words an
 * operator reads on the queue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Notification, NotificationChannel } from '@vip/contracts';
import { WebhookSender } from '../src/application/channel-sender.js';

const channel = (url: string): NotificationChannel => ({
  id: 'ch-hook',
  tenantId: 'tnt_acme',
  name: 'SOC webhook',
  type: 'webhook',
  config: { url },
  enabled: true,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
});

const notification = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tnt_acme',
  incidentId: '22222222-2222-4222-8222-222222222222',
  channelId: 'ch-hook',
  channelType: 'webhook',
  status: 'sent',
  severity: 'high',
  title: 'Person detected after hours',
  correlationId: 'corr-1',
  causationId: '22222222-2222-4222-8222-222222222222',
  attempts: 1,
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
} as Notification;

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/ok')) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.startsWith('/refuse')) {
      res.writeHead(503);
      res.end('service unavailable');
      return;
    }
    /* /hang: accept the request and never answer — the sender's own timeout decides. */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('WebhookSender', () => {
  it('a 2xx is a delivery', async () => {
    const outcome = await new WebhookSender().send(channel(`${base}/ok`), notification);
    expect(outcome).toEqual({ ok: true });
  });

  /** ⚠️ The far end's status, so "their endpoint is broken" is distinguishable from "we could not reach it". */
  it('names the status the endpoint answered with', async () => {
    const outcome = await new WebhookSender().send(channel(`${base}/refuse`), notification);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('the endpoint rejected it (HTTP 503)');
  });

  /**
   * ⚠️ Not "This operation was aborted" — which is what an `AbortController` calls it, and which
   * reads on an operator's screen like the platform gave up rather than the endpoint went quiet.
   */
  it('says the endpoint did not answer in time, in seconds', async () => {
    const outcome = await new WebhookSender(300).send(channel(`${base}/hang`), notification);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('no response within 0.3s');
    expect(outcome.error).not.toMatch(/abort/i);
  });

  /**
   * ⚠️ The one that matters most, and the one `fetch` hides: the cause lives in `error.cause`, and
   * the wrapper's own message is the useless string `fetch failed`.
   */
  it('digs the connection failure out of the cause rather than reporting "fetch failed"', async () => {
    /*
     * A port that was real a moment ago and is not any more — bound, read, released. ⚠️ Not a
     * hard-coded low port: `fetch` refuses port 1 as a *blocked* port before it ever connects, and
     * answers "bad port", so the test would have been asserting the wrong failure entirely.
     */
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const addr = closed.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const outcome = await new WebhookSender(2_000).send(
      channel(`http://127.0.0.1:${port}/hook`),
      notification,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('connection refused by the endpoint');
    expect(outcome.error).not.toMatch(/fetch failed/i);
  });

  it('refuses a channel with no url rather than throwing', async () => {
    const broken = { ...channel(''), config: {} };
    const outcome = await new WebhookSender().send(broken, notification);
    expect(outcome).toEqual({ ok: false, error: 'webhook channel missing url' });
  });
});
