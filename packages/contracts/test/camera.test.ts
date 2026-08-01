import { describe, expect, it } from 'vitest';
import {
  Camera,
  CameraCapabilities,
  CameraDeviceIdentity,
  CameraLifecycle,
  CameraLifecycleState,
  CameraMetadata,
  CameraOperationalHealth,
  CameraProtocol,
  CameraValidationInput,
  CameraValidationResult,
  CameraHealthSummary,
  CameraTimeline,
  CameraTimelineEntry,
  CapabilityCache,
  CapabilityRefreshReason,
  CapabilityRefreshResult,
  CaptureProfile,
  CreateCameraInput,
  DiscoveredCamera,
  HealthObservationSource,
  LifecycleEvidence,
  StreamProbeRequest,
  StreamProbeResult,
  StreamUrl,
  UpdateCameraInput,
} from '../src/camera/camera.js';
import { isKnownEventType } from '../src/events/catalog.js';

const now = '2026-07-28T00:00:00.000Z';

describe('StreamUrl', () => {
  it('accepts rtsp/rtmp (and TLS variants) URLs', () => {
    expect(StreamUrl.safeParse('rtsp://cam.local:554/stream').success).toBe(true);
    expect(StreamUrl.safeParse('rtmps://cam.local/live').success).toBe(true);
  });

  it('rejects non-stream schemes', () => {
    expect(StreamUrl.safeParse('http://cam.local/stream').success).toBe(false);
  });

  it('rejects credentials embedded in the URL (must be vaulted separately)', () => {
    expect(StreamUrl.safeParse('rtsp://admin:secret@cam.local:554/stream').success).toBe(false);
  });
});

describe('CreateCameraInput', () => {
  const base = {
    zoneId: 'on_zone1',
    name: 'Lobby',
    protocol: 'rtsp' as const,
    streamUrl: 'rtsp://cam.local:554/stream',
  };

  it('accepts a minimal valid camera', () => {
    expect(CreateCameraInput.safeParse(base).success).toBe(true);
  });

  it('accepts optional credentials + capture profile', () => {
    const r = CreateCameraInput.safeParse({
      ...base,
      credentials: { username: 'admin', password: 'p@ss' },
      capture: { codec: 'h264', resolution: '1920x1080', fps: 25, ptz: true },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a streamUrl whose scheme mismatches the protocol', () => {
    const r = CreateCameraInput.safeParse({ ...base, protocol: 'rtmp' });
    expect(r.success).toBe(false);
  });

  it('rejects a bad resolution format', () => {
    const r = CreateCameraInput.safeParse({ ...base, capture: { resolution: '1080p' } });
    expect(r.success).toBe(false);
  });
});

describe('UpdateCameraInput', () => {
  it('requires at least one field', () => {
    expect(UpdateCameraInput.safeParse({}).success).toBe(false);
  });
  it('accepts a single field', () => {
    expect(UpdateCameraInput.safeParse({ status: 'disabled' }).success).toBe(true);
  });
  it('has no protocol field (protocol is immutable)', () => {
    const r = UpdateCameraInput.parse({ name: 'x', protocol: 'rtmp' } as never);
    expect('protocol' in r).toBe(false);
  });
});

describe('Camera (returned shape)', () => {
  it('parses a full record and never carries credentials', () => {
    const cam = {
      id: 'cam_1',
      tenantId: 'tnt_a',
      zoneId: 'on_zone1',
      name: 'Lobby',
      protocol: 'rtsp',
      streamUrl: 'rtsp://cam.local:554/stream',
      status: 'enabled',
      capture: { ptz: false },
      health: { status: 'unknown' },
      capabilities: {
        ptz: false,
        audio: false,
        snapshot: true,
        codecs: [],
        resolutions: [],
        protocols: ['rtsp'],
      },
      metadata: { tags: [] },
      lifecycle: { state: 'configured', since: now, evidence: 'declared' },
      hasCredentials: true,
      createdAt: now,
      updatedAt: now,
    };
    const parsed = Camera.parse(cam);
    expect(parsed.hasCredentials).toBe(true);
    expect('credentials' in parsed).toBe(false);
    expect('password' in parsed).toBe(false);
  });
});

describe('CaptureProfile', () => {
  it('defaults ptz to false', () => {
    expect(CaptureProfile.parse({}).ptz).toBe(false);
  });
});

describe('CameraCapabilities (G-1)', () => {
  it('applies sensible defaults', () => {
    const caps = CameraCapabilities.parse({});
    expect(caps).toEqual({
      ptz: false,
      audio: false,
      snapshot: true,
      codecs: [],
      resolutions: [],
      protocols: [],
      // AI-5c additions — additive and defaulted, so an existing camera record still parses.
      streamProfiles: [],
      onvif: false,
      // AI-5e — populated by ONVIF discovery; defaulted so pre-discovery records still parse.
      metadataStream: false,
    });
  });

  it('declares fps range, stream profiles and ONVIF so the runtime need not probe (AI-5c)', () => {
    const caps = CameraCapabilities.parse({
      fpsRange: { min: 1, max: 25 },
      onvif: true,
      streamProfiles: [
        { name: 'main', resolution: '1920x1080', fps: 25 },
        { name: 'sub', resolution: '640x360', fps: 10, preferredForAnalysis: true },
      ],
    });
    expect(caps.fpsRange).toEqual({ min: 1, max: 25 });
    expect(caps.onvif).toBe(true);
    expect(caps.streamProfiles[1]!.preferredForAnalysis).toBe(true);
    expect(caps.streamProfiles[0]!.preferredForAnalysis).toBe(false);
  });

  it('rejects an inverted fps range', () => {
    expect(CameraCapabilities.safeParse({ fpsRange: { min: 30, max: 5 } }).success).toBe(false);
  });

  it('rejects a malformed resolution', () => {
    expect(CameraCapabilities.safeParse({ resolutions: ['huge'] }).success).toBe(false);
  });
});

describe('CameraMetadata (G-1)', () => {
  it('defaults tags to an empty array', () => {
    expect(CameraMetadata.parse({}).tags).toEqual([]);
  });

  it('accepts descriptive fields', () => {
    const m = CameraMetadata.parse({ manufacturer: 'Axis', model: 'P3245', tags: ['lobby'] });
    expect(m.manufacturer).toBe('Axis');
    expect(m.tags).toEqual(['lobby']);
  });
});

describe('CameraValidation (G-1)', () => {
  it('CameraValidationInput is lenient (accepts a non-stream URL for reporting)', () => {
    // Unlike StreamUrl, the validation input does not reject — it lets the service report checks.
    expect(
      CameraValidationInput.safeParse({ protocol: 'rtsp', streamUrl: 'http://x/y' }).success,
    ).toBe(true);
  });

  it('CameraValidationResult carries checks with an informational flag defaulting false', () => {
    const r = CameraValidationResult.parse({
      valid: true,
      checks: [{ name: 'stream-url-scheme', passed: true }],
    });
    expect(r.checks[0]?.informational).toBe(false);
  });
});

describe('camera event catalog', () => {
  it('registers the camera lifecycle events', () => {
    for (const t of [
      'camera.registered',
      'camera.updated',
      'camera.removed',
      'camera.health.changed',
    ]) {
      expect(isKnownEventType(t)).toBe(true);
    }
  });
});

describe('CameraProtocol', () => {
  it('is rtsp | rtmp', () => {
    expect(CameraProtocol.options).toEqual(['rtsp', 'rtmp']);
  });
});

// -------------------------------------------------------------------------------------------
// P-2: lifecycle, identity, operational health, probe, capability cache
// -------------------------------------------------------------------------------------------

describe('CameraLifecycleState (P-2)', () => {
  it('is the Architect-specified state machine, in order', () => {
    expect(CameraLifecycleState.options).toEqual([
      'discovered',
      'validated',
      'configured',
      'connected',
      'monitoring',
      'degraded',
      'offline',
      'retired',
    ]);
  });

  it('separates declared evidence from measured evidence', () => {
    expect(LifecycleEvidence.options).toEqual([
      'declared',
      'validated',
      'measured',
      'administrative',
    ]);
  });
});

describe('CameraLifecycle + CameraTimeline (P-2)', () => {
  it('separates the current position from the history that explains it', () => {
    const lc = CameraLifecycle.parse({ state: 'configured', since: now, evidence: 'declared' });
    expect(lc.state).toBe('configured');
    expect('history' in lc).toBe(false);
  });

  it('records more than state changes, because that is what explains a state change', () => {
    const entry = CameraTimelineEntry.parse({
      at: now,
      kind: 'firmware-changed',
      evidence: 'measured',
      detail: 'firmware V5.7.3 → V5.7.9',
    });
    expect(entry.kind).toBe('firmware-changed');
    expect(entry.from).toBeUndefined();
  });

  it('caps the timeline so a flapping camera cannot grow its own document without limit', () => {
    const entry = {
      at: now,
      kind: 'state-changed',
      evidence: 'measured',
      from: 'connected',
      to: 'offline',
      detail: 'no frames',
    };
    expect(CameraTimeline.safeParse(Array.from({ length: 50 }, () => entry)).success).toBe(true);
    expect(CameraTimeline.safeParse(Array.from({ length: 51 }, () => entry)).success).toBe(false);
  });
});

describe('CameraDeviceIdentity (P-2)', () => {
  it('accepts a device that only knows its own serial number', () => {
    expect(CameraDeviceIdentity.safeParse({ serialNumber: 'DS-2CD-0001' }).success).toBe(true);
  });

  it('normalises MAC format so two spellings of one device cannot look like two devices', () => {
    expect(CameraDeviceIdentity.safeParse({ macAddress: 'a4:14:37:0b:2c:9d' }).success).toBe(true);
    expect(CameraDeviceIdentity.safeParse({ macAddress: 'A4-14-37-0B-2C-9D' }).success).toBe(false);
  });

  it('keeps the network address out of identity — that is the field expected to change', () => {
    const id = CameraDeviceIdentity.parse({
      onvifUuid: 'urn:uuid:abc',
      lastKnownAddress: '10.0.0.64',
    });
    expect(id.onvifUuid).toBe('urn:uuid:abc');
    expect(id.lastKnownAddress).toBe('10.0.0.64');
  });
});

describe('CameraOperationalHealth (P-2)', () => {
  it('leaves unmeasured signals absent rather than defaulting them to a false measurement', () => {
    const health = CameraOperationalHealth.parse({
      observedAt: now,
      source: 'configuration',
      evidenceClass: 'simulated',
    });
    expect(health.reachable).toBeUndefined();
    expect(health.streamAvailable).toBeUndefined();
    expect(health.rtspLatencyMs).toBeUndefined();
    // Authentication is the one exception, and its default is the honest one.
    expect(health.authentication).toBe('unknown');
  });

  it('records what produced the observation, because that bounds what it may claim', () => {
    expect(HealthObservationSource.options).toEqual([
      'configuration',
      'stream-probe',
      'onvif',
      'ingestion',
    ]);
  });
});

describe('StreamProbeResult (P-2)', () => {
  it('carries the evidence class of the source it probed', () => {
    const result = StreamProbeResult.parse({
      probedAt: now,
      evidenceClass: 'hardware',
      reachable: true,
      framesRead: 3,
      resolution: '1920x1080',
    });
    expect(result.evidenceClass).toBe('hardware');
    expect(result.authentication).toBe('unknown');
  });

  it('can express the device that opens and then stalls', () => {
    const result = StreamProbeResult.parse({
      probedAt: now,
      evidenceClass: 'hardware',
      reachable: true,
      framesRead: 0,
      error: 'stream opened but produced no frames within 8s',
    });
    expect(result.reachable).toBe(true);
    expect(result.framesRead).toBe(0);
  });

  it('reports checks the probe never reached as not-executed, not as failures', () => {
    const result = StreamProbeResult.parse({
      probedAt: now,
      evidenceClass: 'hardware',
      reachable: true,
      framesRead: 0,
      checks: [
        { name: 'reachability', status: 'pass' },
        { name: 'authentication', status: 'fail', detail: '401 from the device' },
        { name: 'stream-open', status: 'not-executed' },
        { name: 'frames-received', status: 'not-executed' },
      ],
    });
    // Blaming the stream for a credential problem is how an installer ends up re-running cable.
    expect(result.checks.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual([
      'authentication',
    ]);
    expect(result.checks.filter((c) => c.status === 'not-executed')).toHaveLength(2);
  });
});

describe('StreamProbeRequest (P-2)', () => {
  it('is lenient about the URL — a probe reports a bad URL rather than refusing it', () => {
    expect(StreamProbeRequest.safeParse({ protocol: 'rtsp', streamUrl: 'not-a-url' }).success).toBe(
      true,
    );
  });

  it('reads more than one frame by default, which is what catches a stalled stream', () => {
    const req = StreamProbeRequest.parse({ streamUrl: 'rtsp://cam.local/stream' });
    expect(req.frames).toBeGreaterThan(1);
    expect(req.timeoutSeconds).toBe(8);
  });
});

describe('CapabilityCache (P-2)', () => {
  it('says whether the device was actually contacted', () => {
    const cached = CapabilityRefreshResult.parse({
      cameraId: 'cam_1',
      capabilities: CameraCapabilities.parse({}),
      cache: CapabilityCache.parse({}),
      reason: 'cached',
      refreshed: false,
    });
    expect(cached.refreshed).toBe(false);
    expect(CapabilityRefreshReason.options).toContain('firmware-changed');
  });

  it('records what the capabilities were read against, so staleness is decidable', () => {
    const cache = CapabilityCache.parse({
      firmware: 'V5.7.3',
      discoveredAt: now,
      lastRefreshedAt: now,
      refreshReason: 'forced',
    });
    expect(cache.cacheVersion).toBe(1);
    expect(cache.refreshCount).toBe(0);
    expect(cache.firmware).toBe('V5.7.3');
  });
});

describe('CameraHealthSummary (P-2)', () => {
  it('reports how much evidence is behind a trend, and omits a percentage it cannot support', () => {
    const summary = CameraHealthSummary.parse({
      cameraId: 'cam_1',
      windowStart: now,
      windowEnd: now,
      observations: 1,
      reconnects: 0,
      credentialFailures: 0,
      offlineSeconds: 0,
      capabilityRefreshes: 0,
      firmwareChanges: 0,
    });
    expect(summary.observations).toBe(1);
    expect(summary.availabilityPercent).toBeUndefined();
  });
});

describe('DiscoveredCamera (P-2 identity)', () => {
  it('flags a device recognised by identity at a new address', () => {
    const device = DiscoveredCamera.parse({
      endpoint: 'http://10.0.0.99/onvif/device_service',
      metadata: { tags: [] },
      capabilities: CameraCapabilities.parse({}),
      alreadyOnboarded: true,
      cameraId: 'cam_1',
      identity: { onvifUuid: 'urn:uuid:abc' },
      addressChanged: true,
    });
    expect(device.addressChanged).toBe(true);
    expect(device.alreadyOnboarded).toBe(true);
  });

  it('defaults addressChanged to false', () => {
    const device = DiscoveredCamera.parse({
      endpoint: 'http://10.0.0.64/onvif/device_service',
      metadata: { tags: [] },
      capabilities: CameraCapabilities.parse({}),
    });
    expect(device.addressChanged).toBe(false);
  });
});
