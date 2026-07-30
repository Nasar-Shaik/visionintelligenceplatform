/**
 * @vip/storage — tenant-isolated object storage over S3/MinIO. The MinIO counterpart of the
 * @vip/tenancy Mongo guard: `TenantObjectStore` enforces the `{tenantId}/…` object prefix
 * (fail-closed) so a service works in relative keys and can never reach another tenant's media;
 * `S3ObjectStore` is the AWS-SDK-v3 adapter (pure-JS, MinIO-compatible); `LocalFsObjectStore` is the
 * filesystem provider for dev + deterministic tests. Both sit behind the same `ObjectStore` port, so a
 * provider is chosen by config, not code. Signed URLs only for access.
 * See docs/architecture/phase1/STORAGE_ARCHITECTURE.md.
 */
export { StorageError } from './errors.js';
export type { ObjectStore, ObjectBody, ObjectSummary, PutObjectInput } from './object-store.js';
export { S3ObjectStore, type S3ObjectStoreOptions } from './s3-object-store.js';
export { LocalFsObjectStore, type LocalFsObjectStoreOptions } from './local-fs-object-store.js';
export { TenantObjectStore } from './tenant-object-store.js';

/** Package version — bump per Constitution §7. */
export const STORAGE_VERSION = '0.1.0';
