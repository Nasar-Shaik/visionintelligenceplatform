/**
 * Inference-platform contract tests (P2-2 G-3): the model registry, inference jobs, runtime metrics,
 * and pipeline shapes, plus the canonical event-catalog additions. Deterministic; schema-only.
 */
import { describe, expect, it } from 'vitest';
import {
  AddModelVersionInput,
  InferenceSession,
  InferenceSessionState,
  ModelCapabilityProfile,
  ModelEngine,
  ModelRegistration,
  PipelineDefinition,
  PipelineStage,
  RegisterModelInput,
  RuntimeMetrics,
  StartInferenceSessionInput,
} from '../src/inference/inference.js';
import { EVENT_CATALOG, isKnownEventType, lookupEvent } from '../src/events/catalog.js';

const now = '2026-07-30T00:00:00.000Z';

describe('ModelEngine', () => {
  it('is engine-agnostic (not YOLO-only)', () => {
    expect(ModelEngine.options).toEqual([
      'yolo',
      'onnx',
      'tensorrt',
      'openvino',
      'torchscript',
      'python-custom',
    ]);
  });
});

describe('ModelCapabilityProfile', () => {
  it('exposes structured, queryable capabilities', () => {
    const p = ModelCapabilityProfile.parse({
      supportedEventTypes: ['perception.person.detected', 'perception.vehicle.detected'],
      supportedCategories: ['perception'],
      inputSize: [640, 640],
      expectedFps: 30,
      acceleration: ['gpu', 'cpu'],
      confidenceThreshold: { min: 0.25, max: 0.9 },
    });
    expect(p.supportedEventTypes).toContain('perception.person.detected');
    expect(p.inputSize).toEqual([640, 640]);
  });
  it('defaults arrays', () => {
    expect(ModelCapabilityProfile.parse({}).supportedEventTypes).toEqual([]);
  });
});

describe('ModelRegistration', () => {
  it('parses a registered model with a version + active selection', () => {
    const m = ModelRegistration.parse({
      id: 'mdl_1',
      tenantId: 'tnt_a',
      name: 'YOLOv11n',
      task: 'object-detection',
      engine: 'onnx',
      status: 'enabled',
      activeVersion: '1.0.0',
      versions: [
        {
          version: '1.0.0',
          engine: 'onnx',
          format: 'onnx',
          artifactUri: 'models:/yolov11n/1',
          classes: ['person', 'car'],
          inputShape: [1, 3, 640, 640],
          createdAt: now,
        },
      ],
      capabilities: ['perception.person-detection'],
      capabilityProfile: {
        supportedEventTypes: ['perception.person.detected'],
        supportedCategories: ['perception'],
      },
      metadata: { vendor: 'ultralytics', tags: ['coco'] },
      createdAt: now,
      updatedAt: now,
    });
    expect(m.activeVersion).toBe('1.0.0');
    expect(m.versions[0]!.classes).toContain('person');
    expect(m.capabilityProfile.supportedEventTypes).toContain('perception.person.detected');
  });

  it('defaults activeVersion to null and versions/capabilities to []', () => {
    const m = ModelRegistration.parse({
      id: 'mdl_2',
      tenantId: 'tnt_a',
      name: 'Fire Detection',
      task: 'fire-smoke',
      engine: 'tensorrt',
      status: 'disabled',
      capabilityProfile: {},
      metadata: { tags: [] },
      createdAt: now,
      updatedAt: now,
    });
    expect(m.activeVersion).toBeNull();
    expect(m.versions).toEqual([]);
    expect(m.capabilities).toEqual([]);
    expect(m.capabilityProfile.acceleration).toEqual([]);
  });
});

describe('RegisterModelInput / AddModelVersionInput', () => {
  it('accepts a minimal registration and a version', () => {
    expect(
      RegisterModelInput.parse({ name: 'PPE', task: 'ppe', engine: 'openvino' }).capabilities,
    ).toEqual([]);
    const v = AddModelVersionInput.parse({
      version: '2.1.0',
      format: 'onnx',
      artifactUri: 's3://models/ppe/2.1.0.onnx',
    });
    expect(v.version).toBe('2.1.0');
  });
});

describe('InferenceSession', () => {
  it('enumerates the 7-state lifecycle', () => {
    expect(InferenceSessionState.options).toEqual([
      'created',
      'starting',
      'running',
      'paused',
      'stopped',
      'failed',
      'restarting',
    ]);
  });

  it('parses a session with engine/version/heartbeat/health + transition history', () => {
    const s = InferenceSession.parse({
      sessionId: 'ses_1',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      capabilityId: 'perception.person-detection',
      modelId: 'mdl_1',
      modelVersion: '1.0.0',
      engine: 'onnx',
      state: 'running',
      health: 'healthy',
      startedAt: now,
      lastHeartbeat: now,
      history: [{ from: null, to: 'created', at: now }],
      createdAt: now,
      updatedAt: now,
    });
    expect(s.state).toBe('running');
    expect(s.engine).toBe('onnx');
    expect(s.health).toBe('healthy');
  });

  it('validates StartInferenceSessionInput', () => {
    expect(
      StartInferenceSessionInput.safeParse({ cameraId: 'cam_1', capabilityId: 'bad id' }).success,
    ).toBe(false);
  });
});

describe('RuntimeMetrics', () => {
  it('requires core counters, a 10-bucket confidence distribution, and allows optional GPU', () => {
    const m = RuntimeMetrics.parse({
      fps: 12.5,
      framesProcessed: 100,
      framesSkipped: 5,
      droppedFrames: 2,
      avgLatencyMs: 9,
      latencyP50Ms: 8,
      latencyP95Ms: 20,
      queueDepth: 3,
      uptimeSeconds: 42,
    });
    expect(m.gpuPercent).toBeUndefined();
    expect(m.confidenceDistribution).toHaveLength(10);
    expect(RuntimeMetrics.safeParse({ fps: -1 }).success).toBe(false);
  });
  it('rejects a wrong-length confidence distribution', () => {
    expect(
      RuntimeMetrics.safeParse({
        fps: 1,
        framesProcessed: 1,
        framesSkipped: 0,
        droppedFrames: 0,
        avgLatencyMs: 1,
        latencyP50Ms: 1,
        latencyP95Ms: 1,
        queueDepth: 0,
        uptimeSeconds: 1,
        confidenceDistribution: [1, 2, 3],
      }).success,
    ).toBe(false);
  });
});

describe('Pipeline', () => {
  it('orders the canonical stages', () => {
    expect(PipelineStage.options).toEqual([
      'capture',
      'preprocess',
      'infer',
      'postprocess',
      'track',
      'translate',
      'publish',
    ]);
  });
  it('parses a pipeline definition', () => {
    const p = PipelineDefinition.parse({
      capabilityId: 'perception.person-detection',
      stages: [
        { stage: 'preprocess', engineSpecific: true },
        { stage: 'infer', engineSpecific: true },
        { stage: 'translate' },
      ],
    });
    expect(p.stages[2]!.engineSpecific).toBe(false);
  });
});

describe('canonical event catalog (G-3)', () => {
  const required = [
    'perception.weapon.detected',
    'perception.face.detected',
    'perception.pose.detected',
    'safety.ppe.violation',
    'behavior.theft.suspected',
    'behavior.fight.detected',
    'behavior.fall.detected',
    'behavior.loitering.detected',
    'analytics.people.count',
    'analytics.queue.length',
    'analytics.occupancy.changed',
    'system.model.failed',
  ];

  it('registers every canonical taxonomy type', () => {
    for (const t of required) expect(isKnownEventType(t)).toBe(true);
  });

  it('maps behaviour events onto the frozen category set (no new category)', () => {
    expect(lookupEvent('behavior.fall.detected')!.category).toBe('safety');
    expect(lookupEvent('behavior.fight.detected')!.category).toBe('security');
    expect(lookupEvent('analytics.people.count')!.category).toBe('analytics');
    expect(lookupEvent('perception.weapon.detected')!.category).toBe('security');
  });

  it('keeps every catalog entry well-formed and unique', () => {
    const types = EVENT_CATALOG.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length); // no duplicates
  });
});
