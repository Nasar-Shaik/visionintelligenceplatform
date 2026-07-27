import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { buildServer } from '../src/transport/server.js';

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'identity-test',
    SERVICE_VERSION: '9.9.9',
    LOG_LEVEL: 'silent',
  });
  const built = await buildServer({ config, startedAt: new Date(Date.now() - 5_000) });
  app = built.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('infra endpoints', () => {
  it('GET /health → 200 liveness', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /ready → 200 pass with no dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pass', checks: [] });
  });

  it('GET / → 200 service-info in a success envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('identity-test');
    expect(body.data.version).toBe('9.9.9');
    expect(body.data.uptimeSeconds).toBeGreaterThanOrEqual(4);
  });

  it('sets baseline security headers (helmet)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /metrics → 200 Prometheus exposition', async () => {
    await app.inject({ method: 'GET', url: '/health' }); // generate a sample
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.body).toContain('http_request_duration_seconds');
    expect(res.body).toContain('service="identity-test"');
  });

  it('unknown route → 404 error envelope with correlationId', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('not_found');
    expect(typeof body.error.correlationId).toBe('string');
  });

  it('honours an inbound x-request-id as the correlation id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    expect(res.json().error.correlationId).toBe('trace-abc-123');
  });
});
