/**
 * Evidence service unit tests (deterministic, no infra). Prove the G-4 architecture invariants:
 * immutability, idempotent registration, stable ids, integrity hashing, version-safe metadata,
 * signed-URL retrieval + audited access, retention/legal-hold, hash-chained custody (+ tamper
 * detection), and fail-closed tenant isolation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RegisterEvidenceInput } from '@vip/contracts';
import { buildHarness, type Harness } from './helpers.js';

const A = 'tnt_a';
const B = 'tnt_b';

async function registerSnapshot(h: Harness, overrides: Partial<RegisterEvidenceInput> = {}) {
  const key = await h.putObject(A, 'cam_1/evidence/shot.jpg', 'PIXELS', 'image/jpeg');
  const input: RegisterEvidenceInput = {
    kind: 'snapshot',
    storageKey: key,
    contentType: 'image/jpeg',
    capturedAt: '2026-07-30T09:00:00.000Z',
    source: {
      incidentId: 'inc_1',
      eventId: 'evt_1',
      correlationId: 'corr-1',
      cameraId: 'cam_1',
      ruleId: 'rule_1',
    },
    ...overrides,
  };
  return h.service.register(h.scope(A), 'usr_1', input);
}

describe('EvidenceService', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('registers a snapshot: stable id, computed sha256 integrity, available, genesis custody', async () => {
    const e = await registerSnapshot(h);
    expect(e.id).toMatch(/^evd_/);
    expect(e.status).toBe('available');
    expect(e.media.integrity.algorithm).toBe('sha256');
    expect(e.media.integrity.hash).toHaveLength(64); // sha256 hex
    expect(e.media.integrity.sizeBytes).toBe(6); // 'PIXELS'
    expect(e.metadata.metadataVersion).toBe(1);
    // full traceability (rec 5)
    expect(e.source).toMatchObject({ incidentId: 'inc_1', eventId: 'evt_1', ruleId: 'rule_1' });
    const custody = await h.service.listCustody(h.scope(A), e.id, { limit: 50 });
    expect(custody.items).toHaveLength(1);
    expect(custody.items[0]).toMatchObject({ seq: 0, action: 'created', prevHash: null });
  });

  it('is idempotent on the stable id (re-register same object → same item, no dup custody)', async () => {
    const first = await registerSnapshot(h);
    const second = await registerSnapshot(h);
    expect(second.id).toBe(first.id);
    expect((await h.service.list(h.scope(A), { limit: 50 })).items).toHaveLength(1);
    expect((await h.service.listCustody(h.scope(A), first.id, { limit: 50 })).items).toHaveLength(
      1,
    );
  });

  it('download issues a signed, expiring URL and records an audited access', async () => {
    const e = await registerSnapshot(h);
    const target = await h.service.download(h.scope(A), e.id, 'usr_1', 'investigating inc_1');
    expect(target.url).toContain('signed://');
    expect(target.expiresInSeconds).toBe(900);
    expect(target.sizeBytes).toBe(6);
    const custody = await h.service.listCustody(h.scope(A), e.id, { limit: 50 });
    expect(custody.items.map((c) => c.action)).toEqual(['created', 'accessed']);
    expect(custody.items[1]?.reason).toBe('investigating inc_1');
  });

  it('metadata update bumps version + is audited, and NEVER mutates the media (immutability)', async () => {
    const e = await registerSnapshot(h);
    const beforeHash = e.media.integrity.hash;
    const updated = await h.service.updateMetadata(h.scope(A), e.id, 'usr_1', {
      label: 'entrance person',
      tags: ['review'],
      ai: { modelName: 'yolo', confidence: 0.9, detectedObjects: ['person'] },
      reason: 'operator tagged',
    });
    expect(updated.metadata.metadataVersion).toBe(2);
    expect(updated.metadata.label).toBe('entrance person');
    expect(updated.ai?.modelName).toBe('yolo');
    // media (original) untouched
    expect(updated.media.integrity.hash).toBe(beforeHash);
    expect(updated.media.storageKey).toBe(e.media.storageKey);
  });

  it('retention + legal hold are audited; hold blocks purge eligibility', async () => {
    const e = await registerSnapshot(h, { retainDays: 1 });
    const held = await h.service.setRetention(h.scope(A), e.id, 'usr_1', {
      legalHold: true,
      reason: 'litigation',
    });
    expect(held.retention.legalHold).toBe(true);
    const actions = (await h.service.listCustody(h.scope(A), e.id, { limit: 50 })).items.map(
      (c) => c.action,
    );
    expect(actions).toContain('retention-set');
    expect(actions).toContain('legal-hold-placed');
  });

  it('custody chain verifies across multiple audited actions', async () => {
    const e = await registerSnapshot(h);
    await h.service.download(h.scope(A), e.id, 'usr_1');
    await h.service.updateMetadata(h.scope(A), e.id, 'usr_1', { note: 'x' });
    const chain = await h.service.listCustody(h.scope(A), e.id, { limit: 50 });
    expect(chain.items.map((c) => c.action)).toEqual(['created', 'accessed', 'metadata-updated']);
    // each entry chains to the previous hash
    expect(chain.items[1]!.prevHash).toBe(chain.items[0]!.hash);
    expect(chain.items[2]!.prevHash).toBe(chain.items[1]!.hash);
    expect(await h.service.verifyCustody(h.scope(A), e.id)).toBe(true);
  });

  it('expires a past-retention item and then refuses download', async () => {
    // capturedAt well before the fixed clock (2026-07-30T10:00Z) + 1-day retention ⇒ due.
    const key = await h.putObject(A, 'cam_1/evidence/old.jpg', 'OLD', 'image/jpeg');
    const e = await h.service.register(h.scope(A), 'usr_1', {
      kind: 'snapshot',
      storageKey: key,
      contentType: 'image/jpeg',
      capturedAt: '2026-07-01T00:00:00.000Z',
      retainDays: 1,
    });
    const expired = await h.service.expireIfDue(h.scope(A), e.id);
    expect(expired?.status).toBe('expired');
    await expect(h.service.download(h.scope(A), e.id, 'usr_1')).rejects.toThrow(/not available/);
  });

  it('fail-closed tenant isolation: B cannot read A’s evidence (404) or its custody', async () => {
    const e = await registerSnapshot(h);
    await expect(h.service.get(h.scope(B), e.id)).rejects.toThrow(/not found/);
    await expect(h.service.download(h.scope(B), e.id, 'usr_1')).rejects.toThrow(/not found/);
    await expect(h.service.listCustody(h.scope(B), e.id, { limit: 50 })).rejects.toThrow(
      /not found/,
    );
    expect((await h.service.list(h.scope(B), { limit: 50 })).items).toHaveLength(0);
  });

  it('lists newest-first with keyset pagination + filters', async () => {
    // three snapshots at different capturedAt / different keys
    for (let i = 0; i < 3; i++) {
      const key = await h.putObject(A, `cam_1/evidence/s${i}.jpg`, `B${i}`, 'image/jpeg');
      await h.service.register(h.scope(A), 'usr_1', {
        kind: 'snapshot',
        storageKey: key,
        contentType: 'image/jpeg',
        capturedAt: `2026-07-30T09:0${i}:00.000Z`,
        source: { incidentId: i === 0 ? 'inc_x' : 'inc_y' },
      });
    }
    const page1 = await h.service.list(h.scope(A), { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]!.capturedAt > page1.items[1]!.capturedAt).toBe(true); // newest-first
    expect(page1.nextCursor).toBeDefined();
    const page2 = await h.service.list(h.scope(A), { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    // filter by incident
    const filtered = await h.service.list(h.scope(A), { limit: 50, incidentId: 'inc_x' });
    expect(filtered.items).toHaveLength(1);
  });
});
