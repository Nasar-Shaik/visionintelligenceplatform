/**
 * The single error type raised by the tenancy guard. Any missing, empty, or mismatched
 * tenant context is a fail-closed violation — the operation is refused, never widened.
 */
export class TenancyError extends Error {
  /** Stable code for mapping to an API error / metric (never leak details to clients). */
  readonly code = 'tenancy_violation';

  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
    // Restore prototype chain under transpilation to ES2015+ targets.
    Object.setPrototypeOf(this, TenancyError.prototype);
  }
}
