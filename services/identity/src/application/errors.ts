/**
 * Application errors carrying an HTTP status + stable code. The transport error-handler renders
 * these into the public `ApiError` envelope. Auth failures use a single generic message to avoid
 * leaking whether an account exists (no user-enumeration).
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
