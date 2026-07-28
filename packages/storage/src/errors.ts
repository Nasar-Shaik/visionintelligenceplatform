/**
 * Raised on a storage-isolation violation (missing tenant, a key that escapes the tenant prefix)
 * or an unexpected store failure. A missing/blank tenant is a fail-closed programming invariant —
 * the wrapper refuses rather than touching an un-prefixed object (STORAGE_ARCHITECTURE §Failure).
 */
export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: 'tenant_required' | 'invalid_key' | 'storage_error' = 'storage_error',
  ) {
    super(message);
    this.name = 'StorageError';
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}
