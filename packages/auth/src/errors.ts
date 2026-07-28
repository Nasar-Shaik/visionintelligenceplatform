/** Raised when authentication fails (bad credentials, invalid/expired token). Maps to 401. */
export class AuthError extends Error {
  readonly code = 'unauthenticated';

  constructor(message = 'authentication failed') {
    super(message);
    this.name = 'AuthError';
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}
