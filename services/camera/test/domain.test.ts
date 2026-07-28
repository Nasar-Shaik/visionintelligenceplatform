/**
 * Domain unit tests — pure record construction/transitions and the credential-vaulting invariant:
 * plaintext is sealed before it reaches the domain, `toCamera` reduces it to `hasCredentials`, and
 * the sealed cipher is decryptable only via the vault (never exposed).
 */
import { describe, expect, it } from 'vitest';
import { SecretBox } from '@vip/crypto';
import type { CreateCameraInput } from '@vip/contracts';
import { applyCameraUpdate, newCamera, toCamera, type CameraDoc } from '../src/domain/camera.js';

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
