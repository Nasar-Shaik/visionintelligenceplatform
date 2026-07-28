# @vip/storage

**Tenant-isolated object storage** over S3/MinIO — the MinIO counterpart of the
[@vip/tenancy](../tenancy/README.md) fail-closed Mongo guard. Services work in **relative keys**;
`TenantObjectStore` transparently prefixes every object with `{tenantId}/`, so a service can never
address another tenant's media ([STORAGE_ARCHITECTURE](../../docs/architecture/phase1/STORAGE_ARCHITECTURE.md)).

First consumer: recording ingested media under `{tenantId}/{cameraId}/…` (P1-4). Reused later for
evidence clips/snapshots.

## Why

Prefix isolation must be structural, not per-service discipline. A blank tenant or a key that tries
to escape its prefix (`..`, absolute, empty segment) is **refused** (`StorageError`, fail-closed) —
the same guarantee `@vip/tenancy` gives Mongo. Media is never public: access is via short-lived
**pre-signed URLs** only.

## API

```ts
import { S3ObjectStore, TenantObjectStore } from '@vip/storage';

// Adapter (composition root): AWS SDK v3, MinIO-compatible (path-style).
const s3 = new S3ObjectStore({ endpoint, accessKeyId, secretAccessKey, bucket }); // + ping()

// Per-tenant, fail-closed wrapper — the only thing services touch.
const store = new TenantObjectStore(s3, tenantId); // blank tenantId → throws
const key = store.keyFor(cameraId, 'recordings', name); // safe relative key
await store.put(key, bytes, 'video/mp4'); // → {tenantId}/{cameraId}/recordings/name
const url = await store.presignGet(key, 900); // 15-min signed GET
const segs = await store.list(cameraId + '/'); // only THIS tenant's objects (relative keys)
```

`put` · `get` · `head` · `list` · `delete` · `presignGet` — all in relative keys; `list('')` scopes
to the tenant. `S3ObjectStore` (pure-JS AWS SDK v3, no native build) is the only S3-protocol module.

## Non-goals (Phase 1)

Multipart/streaming uploads, lifecycle/retention tags, object-lock/legal-hold, and per-tenant KMS
envelope encryption are future extensions ([15 §4](../../docs/architecture/15-SECURITY-ARCHITECTURE.md)).

## Test

```bash
pnpm --filter @vip/storage test    # isolation units everywhere; real-MinIO integration when reachable
```

Config comes from `@vip/config` (`storage` group: `S3_ENDPOINT`, `AWS_*`, `S3_RECORDINGS_BUCKET`).
The integration suite runs against the dev-stack MinIO (`pnpm dev:stack`) and skips otherwise.
