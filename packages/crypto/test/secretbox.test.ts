import { describe, it, expect } from 'vitest';
import { SecretBox, seal, open, deriveKey, CryptoError } from '../src/index.js';

const SECRET = 'change_me_dev_only_min_16_chars';

describe('deriveKey', () => {
  it('is deterministic — same secret yields the same 32-byte key', () => {
    const a = deriveKey(SECRET);
    const b = deriveKey(SECRET);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it('yields different keys for different secrets', () => {
    expect(deriveKey(SECRET).equals(deriveKey(SECRET + '!'))).toBe(false);
  });

  it('rejects a too-short secret', () => {
    expect(() => deriveKey('short')).toThrow(CryptoError);
  });
});

describe('seal / open round-trip', () => {
  const key = deriveKey(SECRET);

  it('opens what it sealed', () => {
    const plaintext = JSON.stringify({ username: 'cam', password: 'p@ss w0rd/ünïcode' });
    expect(open(seal(plaintext, key), key)).toBe(plaintext);
  });

  it('produces a versioned, self-describing envelope and never leaks the plaintext', () => {
    const sealed = seal('rtsp-secret', key);
    expect(sealed.startsWith('v1.gcm.')).toBe(true);
    expect(sealed).not.toContain('rtsp-secret');
    expect(sealed.split('.')).toHaveLength(5);
  });

  it('uses a fresh IV each time (ciphertext differs for identical input)', () => {
    expect(seal('same', key)).not.toBe(seal('same', key));
  });

  it('handles empty strings', () => {
    expect(open(seal('', key), key)).toBe('');
  });
});

describe('open — tamper & wrong-key detection (fail loud, never silent)', () => {
  const key = deriveKey(SECRET);

  it('rejects decryption under a different key', () => {
    const sealed = seal('secret', key);
    expect(() => open(sealed, deriveKey('a_completely_different_secret'))).toThrow(CryptoError);
  });

  it('rejects a tampered ciphertext (GCM auth failure)', () => {
    const sealed = seal('secret', key);
    const parts = sealed.split('.');
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[4] = ct.toString('base64url');
    expect(() => open(parts.join('.'), key)).toThrow(CryptoError);
  });

  it('rejects a malformed / unsupported envelope', () => {
    expect(() => open('not-an-envelope', key)).toThrow(CryptoError);
    expect(() => open('v2.gcm.a.b.c', key)).toThrow(CryptoError);
    expect(() => open('v1.cbc.a.b.c', key)).toThrow(CryptoError);
  });
});

describe('SecretBox', () => {
  it('seals and opens through a held key', () => {
    const box = SecretBox.fromSecret(SECRET);
    const sealed = box.seal('hello');
    expect(box.open(sealed)).toBe('hello');
  });

  it('a box from a different secret cannot open another box’s output', () => {
    const a = SecretBox.fromSecret(SECRET);
    const b = SecretBox.fromSecret('another_secret_at_least_16');
    expect(() => b.open(a.seal('x'))).toThrow(CryptoError);
  });
});
