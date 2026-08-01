import { describe, expect, it } from 'vitest';
import {
  Camera,
  CameraCapabilities,
  CameraMetadata,
  CameraProtocol,
  CameraValidationInput,
  CameraValidationResult,
  CaptureProfile,
  CreateCameraInput,
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
