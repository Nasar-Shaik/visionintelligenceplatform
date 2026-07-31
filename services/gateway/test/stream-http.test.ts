/**
 * SSE transport integration (P2-2 G-5) — the real HTTP surface. The gateway listens on an ephemeral
 * port with a StreamHub over an InMemoryEventBus (no NATS); a raw Node client reads the event stream.
 * Deterministic: publishing on the in-memory bus synchronously drives a frame to the socket.
 * Proves: edge auth (401), topic permission gate (403), live delivery + `ready` control, the SSE
 * framing (`id:`/`event:`/`data:`), and cross-tenant isolation over the wire.
 */
import { get } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '@vip/auth';
import { InMemoryEventBus, incidentRaisedSubject } from '@vip/messaging';
import { loadConfig } from '../src/config/env.js';
import { buildServer } from '../src/transport/server.js';
import { StreamHub } from '../src/application/stream-hub.js';

const SECRET = 'gateway-test-secret-16chars';
const jwtOpts = { secret: SECRET, issuer: 'identity', audience: 'vip', accessTtl: '15m' };

function tokenFor(tenantId: string, roles: string[]): Promise<string> {
  return signAccessToken({ principalId: 'usr_1', tenantId, email: 'a@b.com', roles }, jwtOpts).then(
    (r) => r.token,
  );
}

let app: import('fastify').FastifyInstance;
let bus: InMemoryEventBus;
let baseUrl: string;

beforeAll(async () => {
  bus = new InMemoryEventBus();
  const hub = new StreamHub({
    bus,
    limits: {
      maxConnectionsPerTenant: 50,
      maxQueueDepth: 500,
      replayBufferSize: 200,
      heartbeatIntervalMs: 0,
      maxConnectionDurationMs: 0,
    },
  });
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'gateway',
    LOG_LEVEL: 'silent',
    JWT_SECRET: SECRET,
  });
  app = (await buildServer({ config, streamHub: hub })).app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

/** Open an SSE connection; accumulate the raw stream so tests can wait for substrings. */
function openStream(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; res: IncomingMessage; buffer: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = get(`${baseUrl}${path}`, { headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
      });
      resolve({
        status: res.statusCode ?? 0,
        res,
        buffer: () => buf,
        close: () => {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on('error', reject);
  });
}

async function waitFor(get: () => string, needle: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (get().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for "${needle}"; got:\n${get()}`);
}

describe('SSE auth + authorization', () => {
  it('401 without a token', async () => {
    const conn = await openStream('/api/stream', {});
    expect(conn.status).toBe(401);
    conn.close();
  });

  it('403 when the principal has no permitted topics (no roles)', async () => {
    const token = await tokenFor('tnt_a', []);
    const conn = await openStream('/api/stream', { authorization: `Bearer ${token}` });
    expect(conn.status).toBe(403);
    conn.close();
  });
});

describe('SSE live delivery', () => {
  it('sends a ready control then streams a matching incident frame', async () => {
    const token = await tokenFor('tnt_a', ['admin']);
    const conn = await openStream('/api/stream?topics=incidents', {
      authorization: `Bearer ${token}`,
    });
    expect(conn.status).toBe(200);
    expect(conn.res.headers['content-type']).toContain('text/event-stream');
    await waitFor(conn.buffer, 'event: ready');

    await bus.publish(incidentRaisedSubject('tnt_a'), {
      incidentId: 'inc_1',
      severity: 'high',
      occurredAt: '2026-07-31T09:00:00.000Z',
    });

    await waitFor(conn.buffer, 'inc_1');
    const text = conn.buffer();
    expect(text).toContain('event: incidents');
    expect(text).toMatch(/id: \d+/);
    expect(text).toContain('"type":"incident.raised"');
    conn.close();
  });

  it('does not deliver another tenant’s events (cross-tenant isolation)', async () => {
    const token = await tokenFor('tnt_a', ['admin']);
    const conn = await openStream('/api/stream?topics=incidents', {
      authorization: `Bearer ${token}`,
    });
    await waitFor(conn.buffer, 'event: ready');

    // Publish for a DIFFERENT tenant — tnt_a's stream must stay silent.
    await bus.publish(incidentRaisedSubject('tnt_b'), { incidentId: 'inc_b' });
    await new Promise((r) => setTimeout(r, 50));

    expect(conn.buffer()).not.toContain('inc_b');
    conn.close();
  });
});

describe('stream diagnostics', () => {
  it('returns a tenant-scoped connection snapshot for an authorized reader', async () => {
    const token = await tokenFor('tnt_a', ['admin']);
    const stream = await openStream('/api/stream?topics=incidents', {
      authorization: `Bearer ${token}`,
    });
    await waitFor(stream.buffer, 'event: ready');

    const res = await app.inject({
      method: 'GET',
      url: '/stream/diagnostics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const conns = res.json().data.connections as Array<{ tenantId: string; topics: string[] }>;
    expect(conns.length).toBeGreaterThanOrEqual(1);
    expect(conns.every((c) => c.tenantId === 'tnt_a')).toBe(true);
    stream.close();
  });
});
