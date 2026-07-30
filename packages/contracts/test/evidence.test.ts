/**
 * Evidence contract tests (P2-2 G-4). Prove the shapes, defaults, and invariants of the Evidence
 * context contracts — the manifest/lifecycle/custody surfaces the service + gateway bind to.
 */
import { describe, expect, it } from 'vitest';
import {
  Evidence,
  EvidenceManifest,
  EvidenceInterval,
  EvidenceQuery,
  EvidenceCustodyEntry,
  RegisterEvidenceInput,
  UpdateEvidenceMetadataInput,
} from '../src/evidence/evidence.js';

const baseManifest = {
  id: 'evd_abc',
  tenantId: 'tnt_a',
  kind: 'snapshot' as const,
  source: { incidentId: 'inc_1', eventId: 'evt_1', correlationId: 'corr-1', cameraId: 'cam_1' },
  capturedAt: '2026-07-30T09:00:00.000Z',
  media: {
    storageKey: 'cam_1/evidence/evd_abc.jpg',
    contentType: 'image/jpeg',
    integrity: { algorithm: 'sha256' as const, hash: 'deadbeef', sizeBytes: 1234 },
  },
  metadata: {},
};

describe('Evidence contracts', () => {
  it('parses a manifest and applies value-object defaults', () => {
    const m = EvidenceManifest.parse(baseManifest);
    expect(m.media.tier).toBe('active'); // StorageTier default
    expect(m.metadata.metadataVersion).toBe(1);
    expect(m.metadata.tags).toEqual([]);
    expect(m.metadata.attributes).toEqual({});
  });

  it('Evidence = manifest + lifecycle', () => {
    const e = Evidence.parse({
      ...baseManifest,
      status: 'available',
      retention: {},
      createdBy: 'system',
      createdAt: '2026-07-30T09:00:01.000Z',
      updatedAt: '2026-07-30T09:00:01.000Z',
    });
    expect(e.status).toBe('available');
    expect(e.retention.retainUntil).toBeNull();
    expect(e.retention.legalHold).toBe(false);
  });

  it('rejects a clip interval where endedAt precedes startedAt', () => {
    expect(
      EvidenceInterval.safeParse({
        startedAt: '2026-07-30T09:00:10.000Z',
        endedAt: '2026-07-30T09:00:00.000Z',
        durationSeconds: 10,
      }).success,
    ).toBe(false);
  });

  it('RegisterEvidenceInput defaults source to {} and coerces query limit', () => {
    const input = RegisterEvidenceInput.parse({
      kind: 'clip',
      storageKey: 'cam_1/evidence/clip.mp4',
      contentType: 'video/mp4',
      capturedAt: '2026-07-30T09:00:00.000Z',
    });
    expect(input.source).toEqual({});
    const q = EvidenceQuery.parse({ limit: '25' });
    expect(q.limit).toBe(25);
  });

  it('AI metadata is an engine-agnostic optional extension point', () => {
    const patch = UpdateEvidenceMetadataInput.parse({
      ai: { modelName: 'yolo', modelVersion: '11', confidence: 0.9, detectedObjects: ['person'] },
      reason: 'operator tagged',
    });
    expect(patch.ai?.attributes).toEqual({});
  });

  it('custody entries carry a hash chain (prevHash nullable, hash required)', () => {
    const genesis = EvidenceCustodyEntry.parse({
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tnt_a',
      evidenceId: 'evd_abc',
      seq: 0,
      action: 'created',
      actor: 'system',
      at: '2026-07-30T09:00:00.000Z',
      prevHash: null,
      hash: 'abc123',
    });
    expect(genesis.prevHash).toBeNull();
    expect(genesis.details).toEqual({});
  });
});
