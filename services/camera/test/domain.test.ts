/**
 * Domain unit tests — pure record construction/transitions and the credential-vaulting invariant:
 * plaintext is sealed before it reaches the domain, `toCamera` reduces it to `hasCredentials`, and
 * the sealed cipher is decryptable only via the vault (never exposed).
 */
import { describe, expect, it } from 'vitest';
import { SecretBox } from '@vip/crypto';
import type { CreateCameraInput } from '@vip/contracts';
import {
  applyCameraUpdate,
  defaultCapabilities,
  defaultMetadata,
  newCamera,
  toCamera,
  validateCameraConfig,
  type CameraDoc,
} from '../src/domain/camera.js';

const at = new Date('2026-07-28T00:00:00.000Z');
const vault = SecretBox.fromSecret('test-secret-at-least-16-chars');

const input: CreateCameraInput = {
  zoneId: 'on_zone1',
  name: 'Lobby',
  protocol: 'rtsp',
  streamUrl: 'rtsp://cam.local:554/stream',
  capture: { codec: 'h264', ptz: false },
};

describe('newCamera', () => {
  it('builds an enabled camera with unknown health and no credentials', () => {
    const doc = newCamera('tnt_a', 'cam_1', input, null, at);
    expect(doc).toMatchObject({
      _id: 'cam_1',
      tenantId: 'tnt_a',
      status: 'enabled',
      health: { status: 'unknown' },
      credentialCipher: null,
    });
    expect(toCamera(doc).hasCredentials).toBe(false);
  });

  it('stores a sealed cipher when credentials are vaulted; never the plaintext', () => {
    const cipher = vault.seal(JSON.stringify({ username: 'admin', password: 's3cr3t' }));
    const doc = newCamera('tnt_a', 'cam_1', input, cipher, at);
    expect(doc.credentialCipher).toBe(cipher);
    expect(doc.credentialCipher).not.toContain('s3cr3t');
    // Only the vault can recover it.
    expect(JSON.parse(vault.open(doc.credentialCipher!)).password).toBe('s3cr3t');
    // The public shape hides everything but the boolean.
    const pub = toCamera(doc);
    expect(pub.hasCredentials).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('s3cr3t');
  });

  it('defaults the capture profile when none is supplied', () => {
    const doc = newCamera('tnt_a', 'cam_1', { ...input, capture: undefined }, null, at);
    expect(doc.capture).toEqual({ ptz: false });
  });
});

describe('applyCameraUpdate', () => {
  const base = (): CameraDoc => newCamera('tnt_a', 'cam_1', input, null, at);

  it('applies only provided fields and bumps updatedAt', () => {
    const later = new Date('2026-07-29T00:00:00.000Z');
    const updated = applyCameraUpdate(
      base(),
      { name: 'Front', status: 'disabled' },
      undefined,
      later,
    );
    expect(updated.name).toBe('Front');
    expect(updated.status).toBe('disabled');
    expect(updated.zoneId).toBe('on_zone1'); // untouched
    expect(updated.updatedAt).toBe(later.toISOString());
  });

  it('leaves the cipher untouched when no new credentials are given', () => {
    const withCreds = newCamera('tnt_a', 'cam_1', input, vault.seal('x'), at);
    const updated = applyCameraUpdate(withCreds, { name: 'Front' }, undefined, at);
    expect(updated.credentialCipher).toBe(withCreds.credentialCipher);
  });

  it('re-vaults when a new cipher is supplied', () => {
    const next = vault.seal('new');
    const updated = applyCameraUpdate(base(), { name: 'Front' }, next, at);
    expect(updated.credentialCipher).toBe(next);
  });
});

// --- P2-2 G-1 ---

describe('capabilities & metadata (G-1)', () => {
  it('derives default capabilities from protocol + capture', () => {
    const caps = defaultCapabilities('rtsp', { codec: 'h264', resolution: '1920x1080', ptz: true });
    expect(caps).toEqual({
      ptz: true,
      audio: false,
      snapshot: true,
      codecs: ['h264'],
      resolutions: ['1920x1080'],
      protocols: ['rtsp'],
      // AI-5c additions. `fpsRange` is deliberately absent: an invented range would make the
      // inference runtime clamp against a number nobody verified.
      streamProfiles: [],
      onvif: false,
      // AI-5e: an ONVIF metadata stream is a discovery finding, so it stays false until confirmed.
      metadataStream: false,
    });
  });

  it('newCamera derives capabilities and empty metadata by default', () => {
    const doc = newCamera('tnt_a', 'cam_1', input, null, at);
    expect(doc.capabilities).toEqual(defaultCapabilities('rtsp', doc.capture));
    expect(doc.metadata).toEqual({ tags: [] });
    expect(toCamera(doc).capabilities?.protocols).toEqual(['rtsp']);
  });

  it('newCamera honours an operator capabilities/metadata declaration', () => {
    const doc = newCamera(
      'tnt_a',
      'cam_1',
      {
        ...input,
        capabilities: {
          ptz: true,
          audio: true,
          snapshot: false,
          codecs: ['h265'],
          resolutions: [],
          protocols: ['rtsp'],
        },
        metadata: { manufacturer: 'Axis', tags: ['lobby'] },
      },
      null,
      at,
    );
    expect(doc.capabilities?.audio).toBe(true);
    expect(doc.metadata?.manufacturer).toBe('Axis');
  });

  it('applyCameraUpdate replaces metadata/capabilities only when provided', () => {
    const doc = newCamera('tnt_a', 'cam_1', input, null, at);
    const updated = applyCameraUpdate(doc, { metadata: { tags: ['exterior'] } }, undefined, at);
    expect(updated.metadata).toEqual({ tags: ['exterior'] });
    expect(updated.capabilities).toEqual(doc.capabilities); // untouched
  });

  it('toCamera backfills defaults for a pre-G-1 document', () => {
    const legacy = newCamera('tnt_a', 'cam_1', input, null, at);
    delete legacy.capabilities;
    delete legacy.metadata;
    const pub = toCamera(legacy);
    expect(pub.capabilities).toEqual(defaultCapabilities('rtsp', legacy.capture));
    expect(pub.metadata).toEqual(defaultMetadata());
  });
});

describe('validateCameraConfig (G-1)', () => {
  it('passes a well-formed rtsp config; reachability is informational only', () => {
    const result = validateCameraConfig({
      protocol: 'rtsp',
      streamUrl: 'rtsp://cam.local:554/stream',
      capture: { resolution: '1920x1080', ptz: false },
    });
    expect(result.valid).toBe(true);
    const reach = result.checks.find((c) => c.name === 'reachability');
    expect(reach?.informational).toBe(true);
    expect(reach?.passed).toBe(true);
  });

  it('fails when the URL scheme does not match the protocol', () => {
    const result = validateCameraConfig({ protocol: 'rtsp', streamUrl: 'rtmp://cam.local/live' });
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.name === 'protocol-matches-url')?.passed).toBe(false);
  });

  it('fails when credentials are embedded in the URL', () => {
    const result = validateCameraConfig({
      protocol: 'rtsp',
      streamUrl: 'rtsp://admin:secret@cam.local:554/stream',
    });
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.name === 'no-embedded-credentials')?.passed).toBe(false);
  });

  it('fails on a malformed resolution', () => {
    const result = validateCameraConfig({
      protocol: 'rtsp',
      streamUrl: 'rtsp://cam.local/s',
      capture: { resolution: 'huge', ptz: false },
    });
    expect(result.valid).toBe(false);
    expect(result.checks.find((c) => c.name === 'capture-resolution-format')?.passed).toBe(false);
  });
});
