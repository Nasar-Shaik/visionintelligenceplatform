/** Raised when a sealed value cannot be opened (wrong key, tampered ciphertext, malformed envelope). */
export class CryptoError extends Error {
  readonly code = 'crypto_error';

  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'CryptoError';
    Object.setPrototypeOf(this, CryptoError.prototype);
  }
}
