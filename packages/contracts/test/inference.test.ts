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
  RUNTIME_FAILURE_CODES,
  RUNTIME_FAILURE_RECOVERY,
  RuntimeFailureCategory,
  RuntimeMetrics,
  SessionDiagnostics,
  SessionIdentity,
  SessionSupervisorStats,
  StartInferenceSessionInput,
  StreamBackpressureStats,
  StreamConnectionState,
  StreamIngestionStats,
  StreamSourceConfig,
  StreamSourceType,
  AdmissionVerdict,
  AnalyzerCostModel,
  ComputeResource,
  ComputeResourceKind,
  DEGRADATION_LADDER,
  DegradationLevel,
  DeploymentProfile,
  METRIC_GROUPS,
  PRIORITY_WEIGHTS,
  SchedulerDecision,
  SchedulerPolicy,
  SchedulerStats,
  SessionPriority,
  SessionResourceUsage,
  SessionSla,
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

describe('live ingestion (AI-5b)', () => {
  it('keeps the source seam protocol-neutral — RTSP is only the first implementation', () => {
    expect(StreamSourceType.options).toEqual([
      'rtsp',
      'http',
      'file',
      'usb',
      'webrtc',
      'onvif',
      'cloud',
      'simulated',
    ]);
  });

  it('references credentials, never carries them inline', () => {
    const c = StreamSourceConfig.parse({
      type: 'rtsp',
      uri: 'rtsp://camera.local:554/stream',
      credentialRef: 'cred_cam_1',
      targetFps: 5,
      options: { transport: 'tcp' },
    });
    expect(c.credentialRef).toBe('cred_cam_1');
    expect(c.options.transport).toBe('tcp');
    expect(Object.keys(StreamSourceConfig.shape)).not.toContain('password');
    expect(StreamSourceConfig.parse({ type: 'file', uri: '/tmp/a.mp4' }).options).toEqual({});
  });

  it('models the connection lifecycle independently of session state', () => {
    expect(StreamConnectionState.options).toEqual([
      'idle',
      'connecting',
      'connected',
      'lost',
      'reconnecting',
      'stopped',
      'failed',
    ]);
    // A source may be reconnecting while its session is still running — the two are separate axes.
    expect(InferenceSessionState.options).not.toContain('reconnecting');
  });

  it('keeps the five failure categories mutually exclusive, each with a code and a recovery path', () => {
    expect(RuntimeFailureCategory.options).toEqual([
      'connection',
      'model',
      'inference',
      'pipeline',
      'configuration',
    ]);
    // Every category maps to exactly one diagnostic code and one recovery path.
    const codes = Object.values(RUNTIME_FAILURE_CODES);
    expect(new Set(codes).size).toBe(RuntimeFailureCategory.options.length);
    for (const category of RuntimeFailureCategory.options) {
      expect(RUNTIME_FAILURE_CODES[category]).toBeTruthy();
      expect(RUNTIME_FAILURE_RECOVERY[category]).toBeTruthy();
    }
    // A configuration failure is never retried — that is the whole point of separating it.
    expect(RUNTIME_FAILURE_RECOVERY.configuration).toBe('operator');
    expect(RUNTIME_FAILURE_RECOVERY.connection).toBe('reconnect');
  });

  it('uses a logical session identity — never a thread or process handle', () => {
    const id = SessionIdentity.parse({
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      sessionId: 'ses_1',
      correlationId: 'corr_1',
    });
    expect(id.sessionId).toBe('ses_1');
    const keys = Object.keys(SessionIdentity.shape);
    expect(keys).toEqual(['tenantId', 'cameraId', 'sessionId', 'correlationId']);
    for (const banned of ['threadId', 'pid', 'processId', 'host'])
      expect(keys).not.toContain(banned);
  });

  it('splits source-tier stats from pipeline-tier backpressure (no overlapping ownership)', () => {
    const ingestion = StreamIngestionStats.parse({
      state: 'connected',
      sourceType: 'rtsp',
      source: 'rtsp://camera.local:554/stream',
      framesRead: 300,
      reconnectCount: 1,
      availabilityPercent: 99.5,
      averageRecoveryMs: 820,
      uptimeSeconds: 600,
      failures: [{ category: 'connection', code: 'AI-CONN', count: 1, lastError: 'source closed' }],
    });
    expect(ingestion.failures[0]!.code).toBe('AI-CONN');
    // The source tier does not own queue/drop accounting.
    const ingestionKeys = Object.keys(StreamIngestionStats.shape);
    for (const owned of ['framesSkipped', 'framesDropped', 'queueDepth'])
      expect(ingestionKeys).not.toContain(owned);

    const backpressure = StreamBackpressureStats.parse({
      framesSkipped: 240, // execution policy
      framesDropped: 2, // real degradation
      framesProcessed: 58,
      queueCapacity: 32,
      queueDepth: 4,
      queueHighWatermark: 29,
      queueUtilization: 12.5,
      averageQueueDepth: 3.4,
      processingDelayMs: 18.2,
      maxProcessingDelayMs: 140,
    });
    expect(backpressure.framesSkipped).not.toBe(backpressure.framesDropped);
    expect(backpressure.queueHighWatermark).toBe(29);
    // The pipeline tier does not own connection state.
    const bpKeys = Object.keys(StreamBackpressureStats.shape);
    for (const owned of ['state', 'reconnectCount', 'availabilityPercent'])
      expect(bpKeys).not.toContain(owned);
  });

  it('assembles the three tiers into one session diagnostic', () => {
    const d = SessionDiagnostics.parse({
      identity: { tenantId: 'tnt_a', cameraId: 'cam_1', sessionId: 'ses_1' },
      state: 'running',
      ingestion: { state: 'connected', sourceType: 'usb', source: '/dev/video0' },
      backpressure: { queueCapacity: 16 },
      restartCount: 1,
    });
    expect(d.identity.sessionId).toBe('ses_1');
    expect(d.ingestion.state).toBe('connected');
    expect(d.backpressure.queueHighWatermark).toBe(0);
    expect(d.restartCount).toBe(1);
  });

  it('exposes AI-5b runtime metrics additively (absent for batch analysis)', () => {
    const m = RuntimeMetrics.parse({
      fps: 5,
      framesProcessed: 100,
      framesSkipped: 400,
      droppedFrames: 1,
      avgLatencyMs: 12,
      latencyP50Ms: 11,
      latencyP95Ms: 20,
      queueDepth: 0,
      uptimeSeconds: 60,
      reconnectCount: 2,
      restartCount: 1,
      streamAvailability: 98.5,
      averageRecoveryTime: 750,
      activeSessions: 4,
      queueHighWatermark: 29,
      queueUtilization: 12.5,
      averageQueueDepth: 3.4,
      processingDelayMs: 18.2,
    });
    expect(m.reconnectCount).toBe(2);
    expect(m.streamAvailability).toBe(98.5);
    expect(m.queueHighWatermark).toBe(29);
    expect(m.processingDelayMs).toBe(18.2);
    // The same schema still parses a batch snapshot with none of these present.
    const batch = RuntimeMetrics.parse({
      fps: 0,
      framesProcessed: 0,
      framesSkipped: 0,
      droppedFrames: 0,
      avgLatencyMs: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      queueDepth: 0,
      uptimeSeconds: 0,
    });
    expect(batch.reconnectCount).toBeUndefined();
    expect(batch.activeSessions).toBeUndefined();
    expect(batch.queueHighWatermark).toBeUndefined();
  });

  it('binds a live source to a session additively (source omitted = the G-3 session)', () => {
    expect(
      StartInferenceSessionInput.parse({
        cameraId: 'cam_1',
        capabilityId: 'perception.person-detection',
      }).source,
    ).toBeUndefined();
    const live = StartInferenceSessionInput.parse({
      cameraId: 'cam_1',
      capabilityId: 'perception.person-detection',
      source: { type: 'rtsp', uri: 'rtsp://camera.local/1' },
    });
    expect(live.source!.type).toBe('rtsp');
    const s = InferenceSession.parse({
      sessionId: 'ses_1',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      capabilityId: 'perception.person-detection',
      state: 'running',
      health: 'healthy',
      ingestion: { state: 'connected', sourceType: 'rtsp', source: 'rtsp://camera.local/1' },
      createdAt: now,
      updatedAt: now,
    });
    expect(s.ingestion!.state).toBe('connected');
  });

  it('summarizes multi-camera capacity', () => {
    const stats = SessionSupervisorStats.parse({
      activeSessions: 4,
      maxSessions: 8,
      byState: { running: 4, paused: 1 },
      degradedSessions: 1,
      totalReconnects: 3,
      averageAvailabilityPercent: 97.25,
    });
    expect(stats.byState.running).toBe(4);
    expect(SessionSupervisorStats.parse({ maxSessions: 8 }).activeSessions).toBe(0);
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

describe('scheduling + resource management (AI-5c)', () => {
  it('keeps compute hardware-independent — CUDA is one option among many', () => {
    expect(ComputeResourceKind.options).toEqual([
      'cpu',
      'cuda',
      'tensorrt',
      'openvino',
      'metal',
      'tpu',
      'npu',
    ]);
    // Capacity is an abstract budget, never cores or VRAM, so one scheduler serves every accelerator.
    const r = ComputeResource.parse({ id: 'node-a/cuda:0', kind: 'cuda', capacityUnits: 8 });
    expect(r.allocatedUnits).toBe(0);
    expect(r.id).toContain('node-a/'); // node-qualified ids allow future distributed scheduling
  });

  it('orders priorities and weights them consistently', () => {
    expect(SessionPriority.options).toEqual(['low', 'normal', 'high', 'critical']);
    expect(PRIORITY_WEIGHTS.critical).toBeGreaterThan(PRIORITY_WEIGHTS.high);
    expect(PRIORITY_WEIGHTS.high).toBeGreaterThan(PRIORITY_WEIGHTS.normal);
    expect(PRIORITY_WEIGHTS.normal).toBeGreaterThan(PRIORITY_WEIGHTS.low);
  });

  it('degrades gracefully along an ordered ladder before ever stopping a session', () => {
    expect(DegradationLevel.options).toEqual([
      'none',
      'reduced-fps',
      'reduced-resolution',
      'reduced-behaviors',
      'shedding-frames',
      'suspended',
    ]);
    // Cheapest quality loss first; suspension is the last rung, not the first response.
    expect(DEGRADATION_LADDER.indexOf('reduced-fps')).toBeLessThan(
      DEGRADATION_LADDER.indexOf('suspended'),
    );
    expect(DEGRADATION_LADDER[DEGRADATION_LADDER.length - 1]).toBe('suspended');
  });

  it('validates a scheduler policy with reservation and prediction defaults', () => {
    const p = SchedulerPolicy.parse({});
    expect(p.strategy).toBe('weighted-fair'); // fairness is the default, not strict priority
    expect(p.admissionControl).toBe(true);
    expect(p.reservedCapacityPercent).toBeGreaterThan(0); // headroom for recovery
    expect(p.reserveFor).toEqual(['critical']);
    expect(p.predictive).toBe(true);
    expect(p.recoverBelowQueuePercent).toBeLessThan(p.degradeAboveQueuePercent); // hysteresis
  });

  it('records an admission refusal with a reason and an explanation', () => {
    const v = AdmissionVerdict.parse({
      admitted: false,
      reason: 'reserve-protected',
      detail: 'only reserved capacity remains; priority normal may not use it',
    });
    expect(v.admitted).toBe(false);
    expect(v.detail.length).toBeGreaterThan(0); // a refusal is never silent
  });

  it('records why the scheduler acted, not just that it did', () => {
    const d = SchedulerDecision.parse({
      identity: { tenantId: 'tnt_a', cameraId: 'cam_1', sessionId: 'ses_1' },
      action: 'degraded',
      reason: 'predicted-pressure',
      fromLevel: 'none',
      toLevel: 'reduced-fps',
      measurement: { queueUtilization: 62.5, projectedUtilization: 97.1 },
    });
    expect(d.reason).toBe('predicted-pressure');
    expect(d.measurement.projectedUtilization).toBe(97.1);
  });

  it('tracks per-session SLA as target vs actual', () => {
    const sla = SessionSla.parse({
      identity: { tenantId: 'tnt_a', cameraId: 'cam_1', sessionId: 'ses_1' },
      targetFps: 5,
      actualFps: 2.5,
      attainmentPercent: 50,
      met: false,
    });
    expect(sla.met).toBe(false);
    expect(sla.attainmentPercent).toBe(50);
  });

  it('accounts per-session cost so the expensive camera is identifiable', () => {
    const usage = SessionResourceUsage.parse({
      identity: { tenantId: 'tnt_a', cameraId: 'cam_1', sessionId: 'ses_1' },
      priority: 'low',
      cpuPercent: 40,
      inferenceLatencyMs: 22,
    });
    expect(usage.cpuPercent).toBe(40);
    expect(usage.degradation).toBe('none');
  });

  it('separates operational from AI metrics with no overlap', () => {
    const operational = new Set(METRIC_GROUPS.operational);
    const ai = new Set(METRIC_GROUPS.ai);
    for (const key of operational) expect(ai.has(key)).toBe(false);
    expect(operational.has('streamAvailability')).toBe(true); // is the system healthy?
    expect(ai.has('activeTracks')).toBe(true); // is the system seeing correctly?
  });

  it('configures a deployment without touching runtime code', () => {
    const p = DeploymentProfile.parse({
      profile: 'hospital',
      targetFps: 5,
      queueCapacity: 64,
      maxSessions: 16,
      defaultPriority: 'critical',
      enabledBehaviors: ['intrusion', 'fire'],
      analyzerCosts: { costs: { fire: 3 }, protectedAnalyzers: ['fire'] },
      scheduler: { maxDegradation: 'shedding-frames' },
    });
    expect(p.defaultPriority).toBe('critical');
    expect(p.scheduler!.maxDegradation).toBe('shedding-frames'); // never suspends a camera
    // Portable: no tenant/camera/site identifiers in the shape at all.
    for (const banned of ['tenantId', 'cameraId', 'siteId'])
      expect(Object.keys(DeploymentProfile.shape)).not.toContain(banned);
  });

  it('models analyzer cost so degradation drops the expensive ones first', () => {
    const m = AnalyzerCostModel.parse({
      costs: { crowd: 3, occupancy: 1 },
      protectedAnalyzers: ['fire'],
    });
    expect(m.costs.crowd).toBeGreaterThan(m.costs.occupancy);
    expect(m.protectedAnalyzers).toContain('fire');
  });

  it('summarizes scheduler behaviour including fairness shares', () => {
    const s = SchedulerStats.parse({ strategy: 'weighted-fair', registeredSessions: 4 });
    expect(s.sharesBySession).toEqual({});
    expect(s.recentDecisions).toEqual([]);
    expect(s.admissionsRefused).toBe(0);
  });
});
