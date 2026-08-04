# ADR-0036 — A browser-facing endpoint for signed object-storage URLs

- **Status:** Accepted
- **Date:** 2026-08-04
- **Milestone:** P-5.8 (production hardening)
- **Supersedes / amends:** none — additive to `@vip/storage` and `@vip/config`
- **Related:** [ADR-0018](ADR-0018-env-only-secrets-and-centralized-config.md) (env-only config),
  [ADR-0035](ADR-0035-evidence-playback.md) (evidence playback)

## Context

The Evidence Foundation hands a browser a **pre-signed URL** to stream a recording. That URL is
produced by `S3ObjectStore.presignGet()`, which signs against the endpoint the store was constructed
with — the same endpoint the service uses for its own `get`/`put`/`head` calls.

In development those two are the same string. The browser and the services both reach MinIO at
`http://localhost:49000`, so one endpoint is enough and nothing reveals that two roles are being
served by one value.

In **any containerised deployment they are different**. A service reaches object storage at
`http://minio:9000` — a name that resolves on the container network and nowhere else. P-5.8 deployed
the platform for the first time and measured the result:

```
GET /api/evidence/evidence/{id}/playback
  "url": "http://minio:9000/vip-recordings/tnt_dev/cam_dev_1/clip-003-h265.mp4?X-Amz-Signature=…"
```

Playback was **completely non-functional**. Not degraded — the browser cannot resolve the host at
all, and even if it could, the URL is plaintext `http://` embedded in an HTTPS page, which the
Content-Security-Policy blocks as mixed content.

This had been true since evidence playback was built. P-5.5, P-5.6 and P-5.7 each verified playback
extensively — cross-engine codec probing, touch gestures, long recordings, thousands of bookmarks,
network resilience — and all of it ran against `pnpm dev`, where the coincidence held.

## Decision

Give the object store a second, optional endpoint used **only** for signing browser-facing URLs.

- `S3ObjectStoreOptions.publicEndpoint?: string` — defaults to `endpoint`.
- A second `S3Client` is constructed only when the two differ; `presignGet` signs with it. Every
  other operation continues to use the internal client. When the values match (development), the
  same client is reused and behaviour is byte-for-byte unchanged.
- `@vip/config` exposes `StorageConfig.publicEndpoint`, from `S3_PUBLIC_ENDPOINT`, defaulting to
  `S3_ENDPOINT`.
- `docker-compose.prod.yml` sets `S3_PUBLIC_ENDPOINT=${VIP_PUBLIC_URL}`, and the edge proxies
  `/vip-recordings/*` to MinIO.

### Why signing against a different host is sound

SigV4 covers the `Host` header. The signature is computed for the public name, so the object store
validates it against **the name the browser actually used**. The reverse proxy must forward `Host`
unchanged — Caddy does by default; nginx needs `proxy_set_header Host $host`. Getting that wrong
produces a uniform 403, which is the correct failure: the proxy extends reach, never authority.

Verified in the deployed stack: `206 Partial Content` on a Range request, tampered signature `403`,
rewritten object key `403`, unsigned GET `403`, and expiry enforced (`206 → 206 → 403` across a
30-second window).

## Alternatives rejected

**Publish MinIO on a host port.** Removes the one property that distinguishes the deployment from a
development stack — that nothing but the edge is reachable. It also puts object storage on a second
origin, which forces a `media-src` exception in the CSP and reintroduces CORS.

**Stream evidence bytes through the evidence service.** Makes a stateless service proxy multi-gigabyte
range requests, and discards the reason pre-signed URLs exist. It would also put evidence bytes
through a hop that has no business touching them.

**Rewrite the URL in the console.** Client-side string surgery on a signed URL: the signature would
not match the rewritten host, so every request would 403. The signature is precisely what makes this
a server-side decision.

## Consequences

- One additional `S3Client` per store in deployments where the names differ. No request is made by
  it; it exists to compute signatures.
- A deployment where the browser and the services reach storage by different names **must** set
  `S3_PUBLIC_ENDPOINT`. Left unset it silently signs the internal name — the exact failure this ADR
  exists to remove. `.env.production.example` sets it, and `.env.example` documents why development
  deliberately does not.
- Pinned by `packages/storage/test/s3-public-endpoint.test.ts`, which asserts the internal name
  appears nowhere in a signed URL and that the two endpoints produce different signatures — proof the
  host is genuinely covered, decidable offline with no MinIO running.

## The lesson this records

The defect was visible in one field of one JSON response for three milestones. Nothing looked,
because nothing had ever run the platform anywhere other than the machine that wrote it. A test
suite, a screenshot and a browser-engine matrix all agreed playback worked. They were all correct
about the environment they ran in, and that environment was the only one where it did.
