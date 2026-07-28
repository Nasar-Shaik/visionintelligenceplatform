/**
 * HTTP tests — the rule authoring vertical driven in-memory (no Mongo/NATS): authorization
 * (deny-by-default), tenant scoping, CRUD + versioning, and dry-run. Tokens are minted directly with
 * @vip/auth (this service verifies; it does not log in) using identity's iss/aud.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { RuleService } from '../src/application/rule-service.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { buildServer } from '../src/transport/server.js';
import { SECRET, token, authHeader, personEvent, personRuleInput } from './helpers.js';

let app: FastifyInstance;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'rules',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_rules',
    NATS_URL: 'nats://localhost:44222',
    JWT_SECRET: SECRET,
  });
  const service = new RuleService({
    store: new InMemoryRuleStore({ now: () => new Date('2026-07-29T21:00:00.000Z') }),
  });
  app = (await buildServer({ config, ruleService: service, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const createRule = async (t: string, body: unknown = personRuleInput()) =>
  app.inject({ method: 'POST', url: '/rules', headers: authHeader(t), payload: body });

describe('authorization', () => {
  it('POST /rules without a token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/rules', payload: personRuleInput() });
    expect(res.statusCode).toBe(401);
  });

  it('POST /rules without rule:create → 403 (viewer)', async () => {
    const res = await createRule(await token('tnt_a', ['viewer']));
    expect(res.statusCode).toBe(403);
  });

  it('a viewer CAN dry-run (rule:read via *:read) but cannot create', async () => {
    const admin = await token('tnt_a', ['admin']);
    const created = (await createRule(admin)).json().data;
    const viewer = await token('tnt_a', ['viewer']);
    const res = await app.inject({
      method: 'POST',
      url: `/rules/${created.id}/dry-run`,
      headers: authHeader(viewer),
      payload: { event: personEvent() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.matched).toBe(true);
  });
});

describe('CRUD + versioning', () => {
  it('creates, reads, lists, updates (version bump), and deletes — tenant-scoped', async () => {
    const admin = await token('tnt_a', ['admin']);
    const created = (await createRule(admin)).json().data;
    expect(created.version).toBe(1);

    const got = await app.inject({
      method: 'GET',
      url: `/rules/${created.id}`,
      headers: authHeader(admin),
    });
    expect(got.statusCode).toBe(200);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/rules/${created.id}`,
      headers: authHeader(admin),
      payload: { lifecycle: 'disabled' },
    });
    expect(patched.json().data.version).toBe(2);
    expect(patched.json().data.lifecycle).toBe('disabled');

    const versions = await app.inject({
      method: 'GET',
      url: `/rules/${created.id}/versions`,
      headers: authHeader(admin),
    });
    expect(versions.json().data).toHaveLength(2);

    const del = await app.inject({
      method: 'DELETE',
      url: `/rules/${created.id}`,
      headers: authHeader(admin),
    });
    expect(del.statusCode).toBe(204);
  });

  it("a tenant cannot read another tenant's rule (404)", async () => {
    const created = (await createRule(await token('tnt_a', ['admin']))).json().data;
    const other = await token('tnt_b', ['admin']);
    const res = await app.inject({
      method: 'GET',
      url: `/rules/${created.id}`,
      headers: authHeader(other),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an invalid rule body (400)', async () => {
    const res = await createRule(await token('tnt_a', ['admin']), { name: 'x', actions: [] });
    expect(res.statusCode).toBe(400);
  });
});
