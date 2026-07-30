/**
 * HTTP transport tests (inject; no network). Prove permission gating (deny-by-default), status codes,
 * signed-URL retrieval, custody endpoints, and fail-closed cross-tenant isolation (404).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config/env.js';
import { EvidenceService } from '../src/application/evidence-service.js';
import { InMemoryEvidenceStore } from '../src/adapters/in-memory-evidence-store.js';
import { InMemoryCustodyLog } from '../src/adapters/in-memory-custody-log.js';
import { buildServer } from '../src/transport/server.js';
import { FakeObjectStore, SECRET, authHeader, token } from './helpers.js';

const A = 'tnt_a';
const B = 'tnt_b';

let app: FastifyInstance;
let objectStore: FakeObjectStore;

function makeConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'evidence',
    LOG_LEVEL: 'silent',
    JWT_SECRET: SECRET,
    MONGO_URI: 'mongodb://localhost:47017/vip_evidence',
    S3_ENDPOINT: 'http://localhost:49000',
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
    NATS_URL: 'nats://localhost:4222',
    EVIDENCE_STORAGE_PROVIDER: 'local',
  });
}

async function putObject(tenantId: string, relKey: string): Promise<string> {
  await objectStore.put({
    key: `${tenantId}/${relKey}`,
    body: 'PIXELS',
    contentType: 'image/jpeg',
  });
  return relKey;
}

async function registerVia(t: string, tenantId: string, relKey: string): Promise<string> {
  await putObject(tenantId, relKey);
  const res = await app.inject({
    method: 'POST',
    url: '/evidence',
    headers: authHeader(t),
    payload: {
      kind: 'snapshot',
      storageKey: relKey,
      contentType: 'image/jpeg',
      capturedAt: '2026-07-30T09:00:00.000Z',
      source: { incidentId: 'inc_1', eventId: 'evt_1', correlationId: 'corr-1', cameraId: 'cam_1' },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().data.id as string;
}

beforeEach(async () => {
  objectStore = new FakeObjectStore();
  let n = 0;
  const service = new EvidenceService({
    store: new InMemoryEvidenceStore(),
    custody: new InMemoryCustodyLog(),
    objectStore,
    now: () => new Date('2026-07-30T10:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    downloadTtlSeconds: 900,
    defaultRetentionDays: 0,
  });
  app = (await buildServer({ config: makeConfig(), service, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('evidence HTTP — permissions + status codes', () => {
  it('operator registers (201); viewer is denied (403)', async () => {
    const viewer = await token(A, ['viewer']);
    await putObject(A, 'cam_1/evidence/x.jpg');
    const denied = await app.inject({
      method: 'POST',
      url: '/evidence',
      headers: authHeader(viewer),
      payload: {
        kind: 'snapshot',
        storageKey: 'cam_1/evidence/x.jpg',
        contentType: 'image/jpeg',
        capturedAt: '2026-07-30T09:00:00.000Z',
      },
    });
    expect(denied.statusCode).toBe(403);

    const operator = await token(A, ['operator']);
    const id = await registerVia(operator, A, 'cam_1/evidence/y.jpg');
    expect(id).toMatch(/^evd_/);
  });

  it('viewer can read + list + download + custody (evidence:read)', async () => {
    const admin = await token(A, ['admin']);
    const id = await registerVia(admin, A, 'cam_1/evidence/z.jpg');
    const viewer = await token(A, ['viewer']);

    expect(
      (await app.inject({ url: `/evidence/${id}`, headers: authHeader(viewer) })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/evidence', headers: authHeader(viewer) })).statusCode).toBe(
      200,
    );
    const dl = await app.inject({ url: `/evidence/${id}/download`, headers: authHeader(viewer) });
    expect(dl.statusCode).toBe(200);
    expect(dl.json().data.url).toContain('signed://');
    const custody = await app.inject({
      url: `/evidence/${id}/custody`,
      headers: authHeader(viewer),
    });
    expect(custody.json().data.items.map((c: { action: string }) => c.action)).toContain(
      'accessed',
    );
    const verify = await app.inject({
      url: `/evidence/${id}/custody/verify`,
      headers: authHeader(viewer),
    });
    expect(verify.json().data.valid).toBe(true);
  });

  it('retention/legal-hold is manage-only: operator denied (403), admin allowed (200)', async () => {
    const admin = await token(A, ['admin']);
    const id = await registerVia(admin, A, 'cam_1/evidence/r.jpg');

    const operator = await token(A, ['operator']);
    const denied = await app.inject({
      method: 'POST',
      url: `/evidence/${id}/retention`,
      headers: authHeader(operator),
      payload: { legalHold: true },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: `/evidence/${id}/retention`,
      headers: authHeader(admin),
      payload: { legalHold: true, reason: 'litigation' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.retention.legalHold).toBe(true);
  });

  it('metadata update is version-safe (operator allowed)', async () => {
    const operator = await token(A, ['operator']);
    const id = await registerVia(operator, A, 'cam_1/evidence/m.jpg');
    const res = await app.inject({
      method: 'PATCH',
      url: `/evidence/${id}/metadata`,
      headers: authHeader(operator),
      payload: { label: 'tagged', reason: 'triage' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.metadata.metadataVersion).toBe(2);
  });

  it('fail-closed tenant isolation: B cannot read A’s evidence (404)', async () => {
    const admin = await token(A, ['admin']);
    const id = await registerVia(admin, A, 'cam_1/evidence/iso.jpg');
    const bAdmin = await token(B, ['admin']);
    expect(
      (await app.inject({ url: `/evidence/${id}`, headers: authHeader(bAdmin) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/evidence/${id}/download`, headers: authHeader(bAdmin) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/evidence', headers: authHeader(bAdmin) })).json().data.items,
    ).toHaveLength(0);
  });

  it('rejects requests with no token (401)', async () => {
    expect((await app.inject({ url: '/evidence' })).statusCode).toBe(401);
  });
});
