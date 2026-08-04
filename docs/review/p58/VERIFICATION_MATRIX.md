# P-5.8 verification matrix

Every row states what was checked, **how**, and the measured result. A row marked _not verified_ says
so rather than being omitted — a check that could not run is not a check that passed (CONSTRAINTS
§44).

Environment: `docker-compose.prod.yml`, 16 containers, Caddy edge with `tls internal`,
`https://localhost`, macOS arm64 host, 4 cores / 7.75 GB available to Docker.

---

## 1. Deployment

| #    | Check                           | Method                                     | Result                                                                         |
| ---- | ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| 1.1  | Whole stack deploys from source | `prod.sh up -d --build` from a clean clone | ✅ 15 healthy + 1 one-shot                                                     |
| 1.2  | Only the edge is reachable      | `prod.sh ps` host-port column              | ✅ 1 row (proxy 80/443)                                                        |
| 1.3  | HTTPS with a real certificate   | `curl -k -D-`                              | ✅ HTTP/2 200, TLS via internal CA                                             |
| 1.4  | HTTP redirects to HTTPS         | `curl http://localhost/`                   | ✅ 308 → `https://localhost/` (was **connection reset** — fixed)               |
| 1.5  | HSTS                            | response headers                           | ✅ `max-age=63072000; includeSubDomains`                                       |
| 1.6  | CSP                             | response headers                           | ✅ `default-src 'self'; …; frame-ancestors 'none'`                             |
| 1.7  | Other security headers          | response headers                           | ✅ `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` |
| 1.8  | Compression                     | `Accept-Encoding: gzip, zstd`              | ✅ `content-encoding: zstd`, `vary: Accept-Encoding`                           |
| 1.9  | Immutable asset caching         | GET `/assets/index-*.js`                   | ✅ `public, max-age=31536000, immutable`                                       |
| 1.10 | `index.html` never cached       | GET `/`                                    | ✅ `no-cache`                                                                  |
| 1.11 | API responses never cached      | GET `/api/*`                               | ✅ `no-store`                                                                  |
| 1.12 | Non-root containers             | Dockerfile                                 | ✅ `USER vip`                                                                  |
| 1.13 | Graceful shutdown               | `tini` as PID 1, `stop_grace_period: 20s`  | ✅ SIGTERM reaches Node                                                        |
| 1.14 | Secrets fail closed             | unset `JWT_SECRET`                         | ✅ compose refuses to start                                                    |
| 1.15 | No `.env` in images             | `.dockerignore`                            | ✅ excluded                                                                    |

## 2. Health and readiness

| #   | Check                              | Method                           | Result                                                            |
| --- | ---------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| 2.1 | `/health` reaches the gateway      | `curl https://localhost/health`  | ✅ `{"status":"ok"}` (was **200 text/html** from the SPA — fixed) |
| 2.2 | `/ready` reaches the gateway       | `curl https://localhost/ready`   | ✅ JSON with checks                                               |
| 2.3 | Readiness can actually fail        | stop NATS                        | ✅ 503 in 1.01 s (was **`pass` with `checks: []`** — fixed)       |
| 2.4 | Readiness does not hang            | stop NATS, time 6 probes         | ✅ 1.01–1.02 s each (was **~25 s of no response** — fixed)        |
| 2.5 | Container healthchecks             | `prod.sh ps`                     | ✅ all 15 healthy                                                 |
| 2.6 | `/metrics` not exposed at the edge | `curl https://localhost/metrics` | ✅ SPA fallback, not the registry                                 |
| 2.7 | Metrics available internally       | `exec <svc> curl :PORT/metrics`  | ✅ 32–42 families per service, 10/10                              |

## 3. Observability

| #   | Check                                    | Method                        | Result                                                                             |
| --- | ---------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| 3.1 | Structured logs                          | `prod.sh logs gateway`        | ✅ JSON: level, time, reqId, req, res, responseTime                                |
| 3.2 | Correlation id on errors                 | 404 response body             | ✅ `correlationId` present                                                         |
| 3.3 | Id propagates across the hop             | correlate one request         | ✅ same `reqId` in gateway **and** workflow (previously two unrelated ids — fixed) |
| 3.4 | Client cannot forge an id                | send `X-Request-Id: FORGED-…` | ✅ 0 occurrences downstream                                                        |
| 3.5 | No password in logs                      | grep across all containers    | ✅ 0                                                                               |
| 3.6 | No bearer token in logs                  | grep `eyJhbGciOiJIUzI1NiI`    | ✅ 0                                                                               |
| 3.7 | No secret from `.env.production` in logs | grep 5 secrets, 20 min        | ✅ 0 each                                                                          |
| 3.8 | Proxy redacts `Authorization`            | Caddy error log               | ✅ `"Authorization": ["REDACTED"]`                                                 |
| 3.9 | Log rotation                             | compose                       | ✅ 10 MB × 5 per container                                                         |

## 4. Recovery — restart under a live investigation

Method: a real browser with an open investigation streaming the 1-hour clip; each dependency
restarted; **no page reload at any point**. Container restart confirmed by `StartedAt` changing.

| #   | Restarted                             | User-visible disturbance                         | Recovered without refresh                                         |
| --- | ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| 4.1 | gateway                               | 3 network failures (SSE + a video Range request) | ✅ yes                                                            |
| 4.2 | workflow                              | none — restart finished before the next request  | ✅ n/a                                                            |
| 4.3 | evidence                              | none                                             | ✅ n/a                                                            |
| 4.4 | minio                                 | none                                             | ✅ n/a                                                            |
| 4.5 | mongodb                               | none                                             | ✅ n/a                                                            |
| 4.6 | nats                                  | none                                             | ✅ n/a                                                            |
| 4.7 | **minio held down**, then returned    | player showed _"The connection dropped…"_        | ✅ one Retry click                                                |
| 4.8 | **gateway held down**, then returned  | buffered playback continued                      | ✅ one Retry click                                                |
| 4.9 | NATS outage > reconnect budget (48 s) | gateway `/ready` 503 throughout                  | ✅ automatic, unattended (previously **never recovered** — fixed) |

## 5. Backup and disaster recovery

| #    | Check                                        | Method                          | Result                                                  |
| ---- | -------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| 5.1  | Backup produces all three states             | `backup.sh`                     | ✅ mongo 10 kB, objects 11 MB, config 3.9 kB + MANIFEST |
| 5.2  | Config saved with restricted permissions     | `ls -l`                         | ✅ 0600                                                 |
| 5.3  | **Deployment destroyed**                     | `down -v`                       | ✅ all volumes removed                                  |
| 5.4  | Clean stack is genuinely empty               | login attempt before restore    | ✅ 401 unauthenticated                                  |
| 5.5  | Restore into the clean environment           | `restore.sh`                    | ✅ completed                                            |
| 5.6  | Users restored                               | login                           | ✅ OK                                                   |
| 5.7  | Incidents restored                           | API                             | ✅ 1/1                                                  |
| 5.8  | Evidence manifests restored                  | API                             | ✅ 3/3                                                  |
| 5.9  | **Recording bytes restored**                 | signed URL + Range              | ✅ HTTP 206, 4096 bytes                                 |
| 5.10 | Custody chain preserved                      | API                             | ✅ 7 entries                                            |
| 5.11 | Restore is repeatable                        | second restore, after load test | ✅ 27 incidents → 1, clean                              |
| 5.12 | Point-in-time consistency across collections | —                               | ⚠️ **not provided** — single-node `mongodump` (TD-38)   |

## 6. Security

25 checks; full script and output in the milestone record.

| #    | Check                                                    | Result                                                                |
| ---- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| 6.1  | Viewer refused rule creation                             | ✅ 403                                                                |
| 6.2  | Forged `x-tenant-id` cannot widen scope                  | ✅ 200, own tenant only                                               |
| 6.3  | Unauthenticated → 401 on 5 surfaces                      | ✅ 401 × 5                                                            |
| 6.4  | Re-signed payload token rejected                         | ✅ 401                                                                |
| 6.5  | `alg:none` token rejected                                | ✅ 401                                                                |
| 6.6  | `x-principal-id` / `x-roles` / `x-internal-key` stripped | ✅ scope unchanged                                                    |
| 6.7  | Playback URL is HTTPS and signed                         | ✅                                                                    |
| 6.8  | Signature lifetime short                                 | ✅ 900 s                                                              |
| 6.9  | Tampered signature refused                               | ✅ 403                                                                |
| 6.10 | Rewritten object key refused                             | ✅ 403                                                                |
| 6.11 | Anonymous bucket listing refused                         | ✅ 403                                                                |
| 6.12 | Unsigned object GET refused                              | ✅ 403                                                                |
| 6.13 | **Signed URL expiry enforced**                           | ✅ 206 → 206 → **403** across a 30 s window                           |
| 6.14 | Custody is append-only                                   | ✅ 19 → 20 on access                                                  |
| 6.15 | No delete/update route on evidence                       | ✅ 404, evidence + custody intact after attempts                      |
| 6.16 | No JWT in browser storage                                | ✅ access token never persisted                                       |
| 6.17 | Refresh token + tenant cleared on logout                 | ✅                                                                    |
| 6.18 | No cookies remain                                        | ✅ none                                                               |
| 6.19 | Back button after logout                                 | ✅ redirects to login, no protected content                           |
| 6.20 | **No investigative metadata after logout**               | ✅ `localStorage` empty (previously leaked open incident ids — fixed) |
| 6.21 | Replay of a signed URL inside its window                 | ℹ️ succeeds — bearer-link semantics, by design                        |

## 7. Browsers — against the production deployment

| Engine       | Console loads | Login | Workspace | H.264 decode | Timeline seek | Notes                                                              |
| ------------ | ------------- | ----- | --------- | ------------ | ------------- | ------------------------------------------------------------------ |
| Chromium 141 | ✅            | ✅    | ✅        | ✅ 1280×720  | ✅            | H.265 correctly refused — no HEVC decoder in the open-source build |
| Firefox 145  | ✅            | ✅    | ✅        | ✅ 1280×720  | ✅            | reports the Zod JIT CSP violation (below)                          |
| WebKit 26.4  | ✅            | ✅    | ✅        | ✅ 1280×720  | ✅            | clean                                                              |

**One CSP violation, benign and correct.** Zod v4 probes for codegen with `new Function("")` inside a
`try/catch` to decide whether to use its JIT path. The CSP denial _is_ the answer it wants; it falls
back to interpreted validation. Login, incidents and the workspace all render, and every one of those
responses is Zod-parsed — so validation demonstrably works. **Adding `'unsafe-eval'` to silence it
would trade a real boundary for a quieter console and was refused.**

Edge and Safari were not driven directly — Playwright's WebKit is the Safari engine and Edge is
Chromium; branded-build differences (notably HEVC licensing) remain untested. Stated rather than
implied.

## 8. Capacity — see [CAPACITY.md](CAPACITY.md)

| #   | Check                            | Result                                                               |
| --- | -------------------------------- | -------------------------------------------------------------------- |
| 8.1 | Idle footprint, 16 containers    | ✅ 1,204 MiB, < 1 % CPU per service                                  |
| 8.2 | Ingest through the real pipeline | ✅ 3,000 detections → 3,000 events → 27 incidents → 27 notifications |
| 8.3 | Storage per event                | ✅ 845 B document + 464 B index                                      |
| 8.4 | Read latency at 3,001 events     | ✅ p50 9 ms, p95 11 ms                                               |
| 8.5 | 100 concurrent list requests     | ✅ p50 117 ms, p95 184 ms                                            |
| 8.6 | 500-camera deployment            | ⚠️ **not measured** — derived arithmetic, labelled as such           |

## 9. Demo certification

| #    | Step                                  | Clicks | Result                                       |
| ---- | ------------------------------------- | ------ | -------------------------------------------- |
| 9.1  | Open the console over HTTPS           | 0      | ✅                                           |
| 9.2  | Sign in                               | 1      | ✅                                           |
| 9.3  | Incidents                             | 2      | ✅ 1 incident                                |
| 9.4  | Open the incident                     | 3      | ✅                                           |
| 9.5  | Open investigation                    | 4      | ✅                                           |
| 9.6  | Select evidence and play              | 5      | ✅ 1280×720, playing, no error               |
| 9.7  | Scrub the timeline                    | 6      | ✅ t=4.1 s                                   |
| 9.8  | Create a bookmark                     | 7      | ✅                                           |
| 9.9  | Evidence chain + why it fired         | 7      | ✅ both present                              |
| 9.10 | H.265 clip — honest unsupported state | 8      | ✅ _"This browser cannot decode this file…"_ |
| 9.11 | Sign out                              | 10     | ✅ `localStorage` empty                      |

**No developer tools, no database edits, no API calls, no scripts.** 10 clicks, 0 JavaScript errors.

## 10. Gates

| Gate                                  | Result                                      |
| ------------------------------------- | ------------------------------------------- |
| `pnpm test`                           | ✅ 28/28 tasks                              |
| `pnpm typecheck`                      | ✅ 28/28                                    |
| `pnpm lint`                           | ✅ 0 errors (2 pre-existing warnings)       |
| `pnpm verify:contracts`               | ✅ 70 schemas                               |
| `pnpm check:imports`                  | ✅                                          |
| `pnpm format:check`                   | ✅                                          |
| Bundle budget + **chunk-cycle check** | ✅ entry 43.5 kB, vendor 1,066 kB, 0 cycles |
