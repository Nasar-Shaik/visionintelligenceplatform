# Production readiness checklist

Run before handing a deployment to anyone. Every item is verifiable from a terminal or a browser —
there is nothing here you have to take on trust, which is the point.

`✅` = verified in P-5.8 against the reference deployment. `☐` = you must check it for _your_
deployment.

---

## Before deploying

- ☐ Every secret in `.env.production` generated independently (`openssl rand -hex 32`)
- ☐ `CREDENTIAL_ENCRYPTION_KEY` backed up somewhere it will survive this host — it cannot be
  regenerated, and rotating it orphans every stored camera credential
- ☐ `VIP_PUBLIC_URL` set to the address operators will actually type
- ☐ DNS resolves that name to this host (if using a public certificate)
- ☐ Ports 80 and 443 reachable; nothing else needs to be
- ☐ Disk sized from [CAPACITY.md](CAPACITY.md) — recordings dominate everything else
- ☐ Backup destination exists and has room

## Deployment

- ☐ `infra/docker/prod.sh up -d --build` completes
- ☐ `prod.sh ps` shows all services healthy
- ☐ **Exactly one row has a host port** — the proxy. If Mongo, MinIO, Redis or NATS shows one, stop
  and fix it
- ✅ Containers run as a non-root user
- ✅ `tini` is PID 1 so SIGTERM reaches Node and shutdown drains
- ✅ Compose refuses to start with any secret unset

## TLS and the edge

- ☐ `curl -kfsS https://<host>/` returns the console
- ☐ `curl -sS -o /dev/null -w '%{http_code}' http://<host>/` returns **308**, not a connection reset
- ✅ `Strict-Transport-Security: max-age=63072000; includeSubDomains`
- ✅ `Content-Security-Policy` with `default-src 'self'` and `frame-ancestors 'none'`
- ✅ `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`
- ✅ `content-encoding: zstd` (or gzip) negotiated
- ✅ `/assets/*` → `public, max-age=31536000, immutable`
- ✅ `/` → `no-cache`
- ✅ `/api/*` → `no-store`
- ☐ Certificate is the one you intend (public CA vs Caddy's internal CA)

## Health and monitoring

- ☐ `curl -kfsS https://<host>/health` → `{"status":"ok"}` **as JSON, not HTML**
- ☐ `curl -kfsS https://<host>/ready` → JSON with a non-empty `checks` array
- ☐ Uptime monitor points at `/ready`, not `/health` — liveness cannot tell you a dependency died
- ✅ `/metrics` is **not** reachable from outside; Prometheus scrapes internally
- ☐ Alerting distinguishes 503 from `/ready` (a dependency is down) from a timeout (the host is gone)
- ✅ Logs are structured JSON, rotated at 10 MB × 5 per container
- ☐ A log collector is wired if you need retention beyond that

> Verify the health check can actually **fail**: stop NATS and confirm `/ready` returns 503 within a
> couple of seconds. A probe that always passes is not a probe (CONSTRAINTS §44).

## Data and bootstrap

- ☐ First tenant seeded (`--profile seed run --rm seed`)
- ☐ `SEED_PASSWORD` is strong — the seed refuses the development password under `NODE_ENV=production`
- ☐ Every seeded account's password changed at first login
- ☐ Unused seeded accounts disabled

## Security

- ✅ Unauthenticated requests → 401 on every API surface
- ✅ A forged `x-tenant-id` cannot widen scope
- ✅ Re-signed and `alg:none` tokens rejected
- ✅ `x-principal-id` / `x-roles` / `x-internal-key` stripped at the gateway
- ✅ Tampered signature → 403; rewritten object key → 403
- ✅ Anonymous bucket listing → 403; unsigned object GET → 403
- ✅ Signed URLs expire and stop working (verified 206 → 206 → 403)
- ✅ Custody is append-only; no delete or update route exists on evidence
- ✅ No JWT persisted in browser storage; `localStorage` empty after logout
- ✅ No secret, password or token appears in any log
- ☐ `EVIDENCE_DOWNLOAD_TTL_SECONDS` matches your policy (default 900)
- ☐ A rate limiter in front of the edge if this is internet-facing (TD-39)

## Backup and recovery

- ☐ `infra/docker/backup.sh` runs and produces all three artefacts
- ☐ Backup directory permissions match its contents — it holds live secrets
- ☐ Nightly backup scheduled
- ☐ **A restore has been tested into a clean environment** — an untested backup is a hypothesis
- ☐ RPO understood and accepted: your backup interval, with no continuous replication
- ☐ Someone other than the person who deployed it has followed
  [BACKUP.md](../../runbooks/BACKUP.md) successfully

## The browser check — the one that matters

No developer tools. No database access. No scripts. Ten clicks:

- ☐ Sign in
- ☐ Incidents lists incidents
- ☐ Open an incident
- ☐ **Open investigation** is visible and works
- ☐ Evidence is listed
- ☐ **A recording plays** — moving picture, not a black rectangle
- ☐ The timeline scrubs
- ☐ A bookmark can be created
- ☐ The evidence chain shows custody
- ☐ Sign out, and the back button does not reveal the workspace

> Do not skip the playback step. Every health check was green throughout the P-5.8 deployment in
> which playback was completely broken. A person pressing play is the only thing that found it.

## Known limits — accept or address

- ☐ **No real CCTV or NVR validation** ([CCTV_VALIDATION.md](CCTV_VALIDATION.md)) — TD-27, TD-28
- ☐ Single host, single replica: no failover; restarting a service is a brief outage
- ☐ MongoDB is a single node: backups are per-collection consistent, not point-in-time (TD-38)
- ☐ No rate limiting at the edge (TD-39)
- ☐ `style-src 'unsafe-inline'` in the CSP — required by runtime-computed layout geometry (TD-36)
- ☐ Verified to ~100 cameras in shape; 500 is a projection, not a measurement
