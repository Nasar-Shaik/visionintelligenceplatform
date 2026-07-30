/**
 * Gateway tests — edge token validation, `/whoami` context resolution, and the reverse proxy's
 * trust boundary (inject the token's context, strip client-supplied context) against a real stub
 * upstream. Uses inject for the gateway; the stub upstream listens on an ephemeral port.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '@vip/auth';
import { buildUpstreamHeaders, forwardHeaders } from '../src/transport/context.js';
import { loadConfig } from '../src/config/env.js';
import { buildServer } from '../src/transport/server.js';

const SECRET = 'gateway-test-secret-16chars';
const jwtOpts = { secret: SECRET, issuer: 'identity', audience: 'vip', accessTtl: '15m' };
const claims = { principalId: 'usr_1', tenantId: 'tnt_a', email: 'a@b.com', roles: ['admin'] };

let gateway: FastifyInstance;
let upstream: FastifyInstance;
let upstreamUrl: string;

beforeAll(async () => {
  // Stub upstream that echoes the headers it received.
  upstream = Fastify({ logger: false });
  upstream.all('/echo/*', async (request) => ({ headers: request.headers, url: request.url }));
  upstream.all('/auth/*', async (request) => ({ headers: request.headers, url: request.url }));
  await upstream.listen({ host: '127.0.0.1', port: 0 });
  const addr = upstream.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  upstreamUrl = `http://127.0.0.1:${port}`;

  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'gateway',
    LOG_LEVEL: 'silent',
    JWT_SECRET: SECRET,
    IDENTITY_URL: upstreamUrl,
  });
  gateway = (await buildServer({ config })).app;
  await gateway.ready();
});

afterAll(async () => {
  await gateway.close();
  await upstream.close();
});

async function token(): Promise<string> {
  return (await signAccessToken(claims, jwtOpts)).token;
}

describe('config', () => {
  it('registers identity, tenant, and camera upstreams (with defaults)', () => {
    const c = loadConfig({
      NODE_ENV: 'test',
      SERVICE_NAME: 'gateway',
      LOG_LEVEL: 'silent',
      JWT_SECRET: SECRET,
    });
    expect(Object.keys(c.upstreams).sort()).toEqual([
      'camera',
      'events',
      'evidence',
      'identity',
      'media',
      'notify',
      'rules',
      'tenant',
      'workflow',
    ]);
    expect(c.upstreams.camera).toBe('http://localhost:8082');
    expect(c.upstreams.media).toBe('http://localhost:8083');
    expect(c.upstreams.events).toBe('http://localhost:8084');
    expect(c.upstreams.rules).toBe('http://localhost:8086');
    expect(c.upstreams.evidence).toBe('http://localhost:8090');
    expect(c.upstreams.workflow).toBe('http://localhost:8087');
    expect(c.upstreams.notify).toBe('http://localhost:8088');
  });
});

describe('context helpers', () => {
  it('forwardHeaders maps claims to internal headers', () => {
    expect(forwardHeaders(claims)).toEqual({
      'x-tenant-id': 'tnt_a',
      'x-principal-id': 'usr_1',
      'x-roles': 'admin',
    });
  });

  it('buildUpstreamHeaders strips client-supplied context and injects the trusted one', () => {
    const out = buildUpstreamHeaders(
      { 'x-tenant-id': 'evil', 'x-principal-id': 'evil', accept: 'application/json' },
      claims,
    );
    expect(out['x-tenant-id']).toBe('tnt_a');
    expect(out['x-principal-id']).toBe('usr_1');
    expect(out['accept']).toBe('application/json');
  });

  it('strips a client-supplied x-internal-key (cannot reach internal endpoints via the gateway)', () => {
    const out = buildUpstreamHeaders(
      { 'x-internal-key': 'stolen', accept: 'application/json' },
      claims,
    );
    expect(out['x-internal-key']).toBeUndefined();
  });
});

describe('edge auth', () => {
  it('GET /health is open', async () => {
    expect((await gateway.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('/whoami requires a valid token', async () => {
    expect((await gateway.inject({ method: 'GET', url: '/whoami' })).statusCode).toBe(401);
    expect(
      (
        await gateway.inject({
          method: 'GET',
          url: '/whoami',
          headers: { authorization: 'Bearer garbage' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('/whoami returns the resolved context for a valid token', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ tenantId: 'tnt_a', principalId: 'usr_1' });
  });
});

describe('reverse proxy (trust boundary)', () => {
  it('rejects an unauthenticated proxy call', async () => {
    expect((await gateway.inject({ method: 'GET', url: '/api/identity/echo/x' })).statusCode).toBe(
      401,
    );
  });

  it('404s an unknown upstream', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/nope/echo/x',
      headers: { authorization: `Bearer ${await token()}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('forwards to the upstream, injecting trusted context and stripping client spoofing', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/api/identity/echo/thing?q=1',
      headers: {
        authorization: `Bearer ${await token()}`,
        'x-tenant-id': 'evil-tenant', // client attempt to spoof
        'x-principal-id': 'evil-user',
      },
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json().headers;
    // The upstream saw the token's context, not the client's spoofed values.
    expect(echoed['x-tenant-id']).toBe('tnt_a');
    expect(echoed['x-principal-id']).toBe('usr_1');
    expect(echoed['x-roles']).toBe('admin');
    // The `/api/identity` prefix was stripped.
    expect(res.json().url).toBe('/echo/thing?q=1');
  });
});

describe('public auth passthrough (login/refresh/logout)', () => {
  it('proxies POST /api/identity/auth/login WITHOUT a token, forwarding x-tenant-id', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/identity/auth/login',
      headers: { 'content-type': 'application/json', 'x-tenant-id': 'tnt_dev' },
      payload: { email: 'a@b.com', password: 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json().headers;
    // x-tenant-id is a lookup scope on login (no token to derive it from) — it passes through.
    expect(echoed['x-tenant-id']).toBe('tnt_dev');
    expect(res.json().url).toBe('/auth/login');
  });

  it('strips privilege + internal headers on the public path (no identity spoofing)', async () => {
    const res = await gateway.inject({
      method: 'POST',
      url: '/api/identity/auth/refresh',
      headers: {
        'x-tenant-id': 'tnt_dev',
        'x-principal-id': 'evil',
        'x-roles': 'admin',
        'x-internal-key': 'stolen',
      },
      payload: { refreshToken: 'x' },
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json().headers;
    expect(echoed['x-principal-id']).toBeUndefined();
    expect(echoed['x-roles']).toBeUndefined();
    expect(echoed['x-internal-key']).toBeUndefined();
    expect(echoed['x-tenant-id']).toBe('tnt_dev');
  });

  it('keeps auth on non-public identity paths and non-POST methods', async () => {
    // A non-auth identity path still requires a token.
    expect((await gateway.inject({ method: 'GET', url: '/api/identity/echo/x' })).statusCode).toBe(
      401,
    );
    // GET to an auth path is not in the public allowlist (only POST login/refresh/logout).
    expect(
      (await gateway.inject({ method: 'GET', url: '/api/identity/auth/login' })).statusCode,
    ).toBe(401);
    // Another service's `/auth/login` is not public — only identity is.
    expect(
      (await gateway.inject({ method: 'POST', url: '/api/camera/auth/login' })).statusCode,
    ).toBe(401);
  });
});
