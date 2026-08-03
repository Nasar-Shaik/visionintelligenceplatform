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

/**
 * P-4.1 operations routes.
 *
 * The route-level questions are the ones the service tests cannot answer: is the permission right, does
 * a static path get mistaken for a rule id, and does an unimplemented thing say so honestly.
 */
describe('operations routes (P-4.1)', () => {
  const adminToken = () => token('tnt_a', ['admin']);

  it('serves the audit, dependencies and compilation of a rule', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;

    const audit = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/audit`,
      headers: authHeader(admin),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data[0]).toMatchObject({ action: 'created', version: 1 });

    const deps = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/dependencies`,
      headers: authHeader(admin),
    });
    expect(deps.json().data.dependencyHash).toMatch(/^[0-9a-f]{64}$/);

    const compilation = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/compilation`,
      headers: authHeader(admin),
    });
    expect(compilation.json().data).toMatchObject({ ruleId: rule.id, engineVersion: '1.0.0' });
  });

  /** `/rules/dependents` must not be read as a rule id — a router that matched greedily would 404. */
  it('resolves the static dependents path rather than treating it as a rule id', async () => {
    const admin = await adminToken();
    const rule = (
      await createRule(admin, personRuleInput({ eventTypes: ['perception.person.detected'] }))
    ).json().data;

    const res = await app.inject({
      method: 'GET',
      url: '/rules/dependents?kind=event-type&ref=perception.person.detected',
      headers: authHeader(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rules.map((r: { ruleId: string }) => r.ruleId)).toEqual([rule.id]);
  });

  it('rejects a dependents lookup with no kind or no ref', async () => {
    const admin = await adminToken();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/rules/dependents?ref=x',
          headers: authHeader(admin),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/rules/dependents?kind=location',
          headers: authHeader(admin),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rolls a rule back under rule:update, and refuses it to a viewer', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;
    await app.inject({
      method: 'PATCH',
      url: `/rules/${rule.id}`,
      headers: authHeader(admin),
      payload: { severity: 'critical' },
    });

    const viewer = await token('tnt_a', ['viewer']);
    const refused = await app.inject({
      method: 'POST',
      url: `/rules/${rule.id}/rollback`,
      headers: authHeader(viewer),
      payload: { version: 1 },
    });
    expect(refused.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: `/rules/${rule.id}/rollback`,
      headers: authHeader(admin),
      payload: { version: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ version: 3, severity: 'high' });
  });

  it('simulates over supplied events and reports 501 for stored history', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;

    const ok = await app.inject({
      method: 'POST',
      url: `/rules/${rule.id}/simulate`,
      headers: authHeader(admin),
      payload: { events: [personEvent()] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ evaluated: 1, matched: 1 });

    const replay = await app.inject({
      method: 'POST',
      url: `/rules/${rule.id}/simulate`,
      headers: authHeader(admin),
      payload: { range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' } },
    });
    expect(replay.statusCode).toBe(501);
  });

  it('round-trips an export through an import, landing as a draft', async () => {
    const admin = await adminToken();
    await createRule(admin, personRuleInput({ name: 'exported' }));

    const exported = await app.inject({
      method: 'GET',
      url: '/rules/export',
      headers: authHeader(admin),
    });
    expect(exported.statusCode).toBe(200);

    const other = await token('tnt_b', ['admin']);
    const imported = await app.inject({
      method: 'POST',
      url: '/rules/import',
      headers: authHeader(other),
      payload: exported.json().data,
    });
    expect(imported.json().data).toMatchObject({ imported: 1, rejected: 0 });

    const listed = await app.inject({ method: 'GET', url: '/rules', headers: authHeader(other) });
    expect(listed.json().data[0]).toMatchObject({ name: 'exported', lifecycle: 'draft' });
  });

  it('needs rule:create to import, because an import creates rules', async () => {
    const admin = await adminToken();
    await createRule(admin);
    const pkg = (
      await app.inject({ method: 'GET', url: '/rules/export', headers: authHeader(admin) })
    ).json().data;

    const viewer = await token('tnt_a', ['viewer']);
    const res = await app.inject({
      method: 'POST',
      url: '/rules/import',
      headers: authHeader(viewer),
      payload: pkg,
    });
    expect(res.statusCode).toBe(403);
  });

  it('says it has no statistics rather than reporting zeroes, when nothing evaluates here', async () => {
    const admin = await adminToken();
    const res = await app.inject({
      method: 'GET',
      url: '/rules/stats',
      headers: authHeader(admin),
    });
    expect(res.statusCode).toBe(501);
  });

  /**
   * The crash guard. `RuleCondition` is recursive, so without this the body overflows the stack inside
   * the Zod parser and the handler dies — an authenticated request taking a process with it.
   */
  it('refuses an absurdly nested body with a 400 rather than dying in the parser', async () => {
    const admin = await adminToken();
    let condition: unknown = { field: 'confidence', op: 'gte', value: 0.5 };
    for (let i = 0; i < 5_000; i += 1) condition = { not: condition };

    const res = await createRule(admin, personRuleInput({ condition: condition as never }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/nested too deeply/);
  });
});

/**
 * P-4.2 operations routes.
 *
 * Route-level questions the service tests cannot answer: does a static path get mistaken for a rule
 * id, is a malformed query a 400 rather than a silent default, and does the plane split leave every
 * published path exactly where it was.
 */
describe('diagnostics routes (P-4.2)', () => {
  const adminToken = () => token('tnt_a', ['admin']);

  it('serves health, complexity and the full diagnostic package', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;

    const health = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/health`,
      headers: authHeader(admin),
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().data).toMatchObject({ ruleId: rule.id });

    const complexity = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/complexity`,
      headers: authHeader(admin),
    });
    expect(complexity.json().data.class).toBe('simple');

    const pkg = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/diagnostics`,
      headers: authHeader(admin),
    });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.json().data).toMatchObject({ ruleId: rule.id, packageVersion: '1.0.0' });
    expect(pkg.json().data.versions).toHaveLength(1);
  });

  it('diffs two versions, and rejects a diff with no versions to compare', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;
    await app.inject({
      method: 'PATCH',
      url: `/rules/${rule.id}`,
      headers: authHeader(admin),
      payload: { severity: 'critical' },
    });

    const diff = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/diff?from=1&to=2`,
      headers: authHeader(admin),
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().data.changes.some((c: { area: string }) => c.area === 'severity')).toBe(
      true,
    );

    const bad = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/diff?from=one`,
      headers: authHeader(admin),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('serves the incident-management contract, pinned to a version', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin, personRuleInput({ severity: 'low' }))).json().data;
    await app.inject({
      method: 'PATCH',
      url: `/rules/${rule.id}`,
      headers: authHeader(admin),
      payload: { severity: 'critical' },
    });

    const pinned = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/incident-context?version=1`,
      headers: authHeader(admin),
    });
    expect(pinned.json().data).toMatchObject({
      ruleVersion: 1,
      severity: 'low',
      supersededByCurrentVersion: true,
    });

    const bad = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/incident-context?version=nope`,
      headers: authHeader(admin),
    });
    expect(bad.statusCode).toBe(400);
  });

  /** Another static path that must not be read as a rule id. */
  it('resolves the diagnostics search path and validates its filters', async () => {
    const admin = await adminToken();
    await createRule(admin, personRuleInput({ name: 'searchable' }));

    const ok = await app.inject({
      method: 'GET',
      url: '/rules/diagnostics?name=search',
      headers: authHeader(admin),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.rows[0]?.ruleName).toBe('searchable');

    // An unknown lifecycle is a 400, not a filter silently ignored.
    const bad = await app.inject({
      method: 'GET',
      url: '/rules/diagnostics?lifecycle=whenever',
      headers: authHeader(admin),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('checks dependency status only when asked, and says which answer it gave', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;

    const bare = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/dependencies`,
      headers: authHeader(admin),
    });
    expect(bare.json().data.statusChecked).toBe(false);

    const checked = await app.inject({
      method: 'GET',
      url: `/rules/${rule.id}/dependencies?status=true`,
      headers: authHeader(admin),
    });
    expect(checked.json().data.statusChecked).toBe(true);
  });

  it('takes the conflict policy from the query, keeping the body a bare package', async () => {
    const admin = await adminToken();
    await createRule(admin, personRuleInput({ name: 'portable' }));
    const pkg = (
      await app.inject({ method: 'GET', url: '/rules/export', headers: authHeader(admin) })
    ).json().data;

    const other = await token('tnt_b', ['admin']);
    await app.inject({
      method: 'POST',
      url: '/rules/import',
      headers: authHeader(other),
      payload: pkg,
    });
    const again = await app.inject({
      method: 'POST',
      url: '/rules/import',
      headers: authHeader(other),
      payload: pkg,
    });
    expect(again.json().data).toMatchObject({ imported: 0, skipped: 1 });

    const forced = await app.inject({
      method: 'POST',
      url: '/rules/import?onConflict=import-anyway',
      headers: authHeader(other),
      payload: pkg,
    });
    expect(forced.json().data.imported).toBe(1);
  });

  it('keeps every published path where it was after the plane split', async () => {
    const admin = await adminToken();
    const rule = (await createRule(admin)).json().data;
    const paths = [
      '/rules',
      `/rules/${rule.id}`,
      `/rules/${rule.id}/versions`,
      `/rules/${rule.id}/validation`,
      `/rules/${rule.id}/audit`,
      `/rules/${rule.id}/dependencies`,
      `/rules/${rule.id}/compilation`,
      '/rules/dependents?kind=action&ref=raise-incident',
      '/rules/export',
    ];
    for (const path of paths) {
      const res = await app.inject({ method: 'GET', url: path, headers: authHeader(admin) });
      // A rename would be a 404 here — which is exactly what CONSTRAINTS §41 forbids.
      expect(res.statusCode, path).toBe(200);
    }
  });
});
