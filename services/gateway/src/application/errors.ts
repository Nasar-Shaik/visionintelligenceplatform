/** Application errors carrying an HTTP status + stable code, rendered into the ApiError envelope. */
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

export const badGateway = (message = 'Bad Gateway'): AppError =>
  new AppError(502, 'bad_gateway', message);
export const notFound = (message: string): AppError => new AppError(404, 'not_found', message);
