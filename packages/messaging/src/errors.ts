/** Raised when a subject is malformed, a tenant id is unsafe, or a payload cannot be decoded. */
export class MessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingError';
  }
}
