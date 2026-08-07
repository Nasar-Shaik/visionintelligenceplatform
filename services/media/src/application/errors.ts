/**
 * Application errors carrying an HTTP status + stable code. The transport error-handler renders
 * these into the public `ApiError` envelope. 4xx messages are safe to surface.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const notFound = (message: string): AppError => new AppError(404, 'not_found', message);
export const conflict = (message: string): AppError => new AppError(409, 'conflict', message);
export const badRequest = (message: string): AppError => new AppError(400, 'bad_request', message);
export const forbidden = (message = 'Forbidden'): AppError =>
  new AppError(403, 'forbidden', message);
export const notImplemented = (message: string): AppError =>
  new AppError(501, 'not_implemented', message);

/**
 * Two requests raced to claim the same analysis run number (P-8 Phase 8).
 *
 * ⚠️ **Raised by the store, not by a check.** Deciding a session's sequence is a read-then-write:
 * two operators pressing "run" together both see zero existing sessions and both claim number 1. No
 * amount of re-reading makes that atomic, so a unique index decides it and the loser lands here.
 *
 * It lives in the application layer so both the Mongo adapter and the in-memory one can raise it —
 * a test double that silently accepts a duplicate would make the race test vacuous.
 */
export class DuplicateSessionError extends Error {
  constructor(
    readonly analysisId: string,
    readonly sequence: number,
  ) {
    super(`session ${String(sequence)} already exists for analysis '${analysisId}'`);
    this.name = 'DuplicateSessionError';
    Object.setPrototypeOf(this, DuplicateSessionError.prototype);
  }
}
