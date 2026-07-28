import { describe, expect, it } from 'vitest';
import {
  Detection,
  DetectionResult,
  InferenceRequest,
  ModelBinding,
} from '../src/perception/perception.js';

const now = '2026-07-28T00:00:00.000Z';

describe('Detection', () => {
  it('parses a normalized detection (label + confidence + bbox), defaulting generic maps', () => {
    const d = Detection.parse({ label: 'person', confidence: 0.92, bbox: [0.1, 0.2, 0.3, 0.4] });
    expect(d.label).toBe('person');
    expect(d.classId).toBeUndefined();
    expect(d.attributes).toEqual({});
    expect(d.metadata).toEqual({});
    expect(d.embedding).toBeUndefined();
    expect(d.trackingId).toBeUndefined();
  });

  it('carries generic model-independent extras (attributes/embedding/metadata/trackingId)', () => {
    const d = Detection.parse({
      label: 'person',
      confidence: 0.5,
      bbox: [0, 0, 1, 1],
      attributes: { color: 'red' },
      embedding: [0.1, 0.2],
      metadata: { model: 'x' },
      trackingId: 'trk_1',
    });
    expect(d.attributes).toEqual({ color: 'red' });
    expect(d.embedding).toEqual([0.1, 0.2]);
    expect(d.trackingId).toBe('trk_1');
  });

  it('rejects a confidence outside [0,1]', () => {
    expect(Detection.safeParse({ label: 'x', confidence: 1.5, bbox: [0, 0, 1, 1] }).success).toBe(
      false,
    );
  });

  it('rejects a malformed bbox', () => {
    expect(Detection.safeParse({ label: 'x', confidence: 0.5, bbox: [0, 0, 1] }).success).toBe(
      false,
    );
  });
});

describe('InferenceRequest', () => {
  const base = {
    context: { tenantId: 'tnt_a', principalId: 'usr_1' },
    frame: { cameraId: 'cam_1', seq: 3, capturedAt: now },
    imageBase64: 'AAAA',
  };

  it('accepts a request carrying context + frame + image', () => {
    expect(InferenceRequest.safeParse(base).success).toBe(true);
  });

  it('requires a tenant context (frame + context travel together, fail-closed)', () => {
    const { context: _drop, ...noCtx } = base;
    void _drop;
    expect(InferenceRequest.safeParse(noCtx).success).toBe(false);
  });

  it('requires the image bytes', () => {
    const { imageBase64: _drop, ...noImg } = base;
    void _drop;
    expect(InferenceRequest.safeParse(noImg).success).toBe(false);
  });

  it('accepts an optional per-request selector override', () => {
    const r = InferenceRequest.safeParse({
      ...base,
      selector: { task: 'object-detection', family: 'yolo' },
    });
    expect(r.success).toBe(true);
  });
});

describe('ModelBinding', () => {
  it('defaults family + accelerator', () => {
    const m = ModelBinding.parse({ name: 'person-det', version: '1', task: 'object-detection' });
    expect(m.family).toBe('*');
    expect(m.accelerator).toBe('cpu');
  });
});

describe('DetectionResult', () => {
  it('parses a full result with version metadata and defaults empty detections', () => {
    const r = DetectionResult.parse({
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      capabilityId: 'perception.person-detection',
      capabilityVersion: '0.1.0',
      runtimeVersion: '0.1.0',
      executionProvider: 'stub',
      model: { name: 'person-det', version: '1', task: 'object-detection' },
      frame: { seq: 3, capturedAt: now },
      inferenceMs: 12.5,
      at: now,
    });
    expect(r.detections).toEqual([]);
    expect(r.model.name).toBe('person-det');
    expect(r.executionProvider).toBe('stub');
    expect(r.runtimeVersion).toBe('0.1.0');
  });

  it('requires version metadata (auditability)', () => {
    expect(
      DetectionResult.safeParse({
        tenantId: 'tnt_a',
        cameraId: 'cam_1',
        capabilityId: 'perception.person-detection',
        model: { name: 'x', version: '1', task: 'object-detection' },
        frame: { seq: 0, capturedAt: now },
        inferenceMs: 1,
        at: now,
      }).success,
    ).toBe(false);
  });
});
