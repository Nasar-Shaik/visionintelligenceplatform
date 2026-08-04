/**
 * Adapter: **StorageProvider selection** (Architect rec 3). Evidence bytes live behind the shared
 * `@vip/storage` `ObjectStore` port; the concrete provider is chosen by **config, not code**
 * (`EVIDENCE_STORAGE_PROVIDER`): `local` (filesystem — dev/tests) or `s3` (MinIO/S3 — prod). Azure Blob
 * / GCS drop in behind the same port later with no service change. Evidence keys are prefixed
 * `{tenant}/evidence/…` (via TenantObjectStore), distinct from media recordings in the same bucket.
 */
import { LocalFsObjectStore, S3ObjectStore, type ObjectStore } from '@vip/storage';
import type { ServiceConfig } from '../config/env.js';

export function buildStorageProvider(config: ServiceConfig): ObjectStore {
  if (config.evidence.storageProvider === 'local') {
    return new LocalFsObjectStore({
      baseDir: config.evidence.localDir,
      publicBaseUrl: config.evidence.localPublicBaseUrl,
    });
  }
  return new S3ObjectStore({
    endpoint: config.storage.endpoint,
    // ⚠️ Playback URLs are handed to a browser, so they must carry the public name — not the
    // container-internal one this service dials. See `StorageConfig.publicEndpoint`.
    publicEndpoint: config.storage.publicEndpoint,
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
    region: config.storage.region,
    bucket: config.storage.recordingsBucket,
    forcePathStyle: config.storage.forcePathStyle,
  });
}
