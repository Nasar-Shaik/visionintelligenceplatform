# Production deployment

Deploys the whole platform — ten services, the console, the backing infrastructure and one TLS edge
— onto a single host with Docker Compose.

**This guide is the entire procedure.** It was written by deploying from an empty state and
recording what was actually required; a second engineer following it needs nothing that is not on
this page. If a step here is insufficient, that is a defect in this document, not something for the
next person to work out.

---

## 1. What you need

|           |                                                                                    |
| --------- | ---------------------------------------------------------------------------------- |
| Host      | Linux or macOS, x86-64 or arm64                                                    |
| Docker    | Engine 24+ with Compose v2 (`docker compose version`)                              |
| CPU / RAM | 4 vCPU, 8 GB minimum — see [capacity sizing](../review/p58/CAPACITY.md)            |
| Disk      | 40 GB for the platform; recordings need far more (sizing table in the same file)   |
| Ports     | 80 and 443 on the host. Nothing else is published                                  |
| DNS       | An A record for the hostname operators will type, if you want a public certificate |

No Node, no pnpm, no toolchain on the host. Everything builds inside Docker.

---

## 2. Configure

```sh
git clone <repo> vip && cd vip
cp .env.production.example .env.production
```

Generate a distinct value for **every** empty variable:

```sh
openssl rand -hex 32
```

| Variable                    | What it does                                          | If you lose it                                                    |
| --------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `JWT_SECRET`                | signs access/refresh tokens                           | everyone is logged out; nothing else                              |
| `CREDENTIAL_ENCRYPTION_KEY` | derives the key encrypting camera credentials at rest | **every stored camera credential becomes permanently unreadable** |
| `INTERNAL_API_KEY`          | authenticates service-to-service calls                | rotate freely                                                     |
| `MONGO_PASSWORD`            | database                                              | rotate with the database                                          |
| `REDIS_PASSWORD`            | cache                                                 | rotate freely                                                     |
| `MINIO_ROOT_PASSWORD`       | object storage                                        | rotate with storage                                               |
| `SEED_PASSWORD`             | first-login password for the bootstrap accounts       | change at first login anyway                                      |

> ⚠️ `CREDENTIAL_ENCRYPTION_KEY` is the one irreplaceable value. Rotating it does not re-encrypt
> anything — it orphans what is already stored. Back up `.env.production` before you go live, and
> keep it as carefully as the database itself. See [BACKUP.md](BACKUP.md).

Then set the public identity:

```sh
VIP_PUBLIC_URL=https://vip.example.com
```

This one variable drives three things: the address Caddy serves, the certificate it obtains, and the
host that signed playback URLs are signed against (ADR-0036). They must agree, which is why it is
one variable rather than three.

| Value                     | TLS behaviour                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `https://vip.example.com` | Caddy obtains a real certificate over ACME. Needs public DNS and reachable :80/:443 |
| `https://localhost`       | Caddy's internal CA — genuine TLS, locally-trusted root. Correct for evaluation     |
| `http://…`                | plaintext. Don't: HSTS and secure cookies both assume TLS                           |

**There are no working defaults.** Every secret is declared `${VAR:?}`, so Compose refuses to start
until it is set. A deployment that comes up healthy while signing tokens with a key published in
this repository is worse than one that will not start.

---

## 3. Deploy

```sh
infra/docker/prod.sh up -d --build
```

First build is ~5–10 minutes. Use `prod.sh` rather than `docker compose` directly — it pins both the
compose file and `--env-file`, and forgetting the latter silently falls back to the _development_
`.env`.

Watch it come up:

```sh
infra/docker/prod.sh ps
```

Expect 15 containers `healthy` and exactly **one** row with a host port — the proxy on 80/443.
Mongo, Redis, MinIO, NATS and all ten services are reachable only on the internal network. If any of
them shows a host port, that is a misconfiguration, not a convenience.

---

## 4. Bootstrap the first tenant

```sh
infra/docker/prod.sh --profile seed run --rm seed
```

Creates a tenant, an organisation root, four accounts (one per role) and a sample camera and rule.
It runs **inside** the network, because the host cannot reach the database — which is the point.

Under `NODE_ENV=production` the seed refuses to run without a strong `SEED_PASSWORD`, and refuses
the development password outright.

> This is a bootstrap for evaluation. A real tenant is created through the API/console; the seed
> exists so the console has something to show on first login.

Optional demo evidence — three generated clips, registered through the **real** evidence API so
custody opens and the integrity hash is computed from the stored bytes:

```sh
mkdir -p .data/demo-clips   # generate clips with ffmpeg first — see tools/seed/evidence.ts
SEED_EVIDENCE_DIR=$(pwd)/.data/demo-clips infra/docker/prod.sh --profile seed run --rm seed-evidence
```

> The clips are ffmpeg test patterns: real H.264/H.265 in real MP4 containers, not CCTV. See
> [CCTV_VALIDATION.md](../review/p58/CCTV_VALIDATION.md).

---

## 5. Verify before you hand it over

```sh
curl -kfsS https://localhost/health   # {"status":"ok"}
curl -kfsS https://localhost/ready    # {"status":"pass","checks":[{"name":"nats",…}]}
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost/   # 308 → https
```

Then, in a browser, the full loop with no developer tools: sign in → Incidents → open an incident →
**Open investigation** → play a clip → scrub the timeline → bookmark → read the evidence chain →
sign out. Ten clicks. If any step needs a script or a database edit, the deployment is not finished.

The complete list is [PRODUCTION_CHECKLIST.md](../review/p58/PRODUCTION_CHECKLIST.md).

---

## 6. What the edge does

`infra/docker/Caddyfile` terminates TLS and is the only thing on the host that listens.

| Path                | Goes to | Cache                                                          |
| ------------------- | ------- | -------------------------------------------------------------- |
| `/api/*`            | gateway | `no-store` — every response is authorization-dependent         |
| `/vip-recordings/*` | MinIO   | as signed; the signature is still verified by MinIO            |
| `/health`, `/ready` | gateway | `no-store`                                                     |
| `/assets/*`         | console | `public, max-age=31536000, immutable` (Vite fingerprints them) |
| everything else     | console | `no-cache` on `index.html`, SPA fallback                       |

Applied to every response: HSTS (2 years), `X-Frame-Options: DENY`, `X-Content-Type-Options`,
`Referrer-Policy`, `Permissions-Policy` denying camera/microphone/geolocation, and a CSP with
`default-src 'self'` and `frame-ancestors 'none'`.

`/metrics` is deliberately **not** exposed. Prometheus scrapes each service on the internal network,
where reaching it already requires being inside the deployment.

> ⚠️ `/health` and `/ready` are routed explicitly because the SPA fallback answers every unmatched
> path with `index.html` and HTTP 200. Before that routing existed, `GET /health` returned the
> console's markup with a 200 — an uptime monitor would have reported the platform healthy with all
> ten services down.

---

## 7. Day-two operations

| Task                     | Guide                                    |
| ------------------------ | ---------------------------------------- |
| Back up / restore        | [BACKUP.md](BACKUP.md)                   |
| Upgrade to a new version | [UPGRADE.md](UPGRADE.md)                 |
| Roll back a bad release  | [ROLLBACK.md](ROLLBACK.md)               |
| Something is broken      | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

Logs are structured JSON on stdout, capped at 10 MB × 5 files per container:

```sh
infra/docker/prod.sh logs -f gateway
infra/docker/prod.sh logs --since 1h | grep '"level":50'   # errors
```

Every request carries a `reqId` that propagates from the edge through the gateway into the upstream
service, and is returned to the caller as `correlationId` on any error — so a user-reported failure
maps to exact log lines across services.

---

## 8. Hardening beyond this guide

Everything above is verified. These are not, and are recorded rather than implied:

- **Single host, single replica.** No clustering, no failover. Restarting a service is a brief
  outage for that service; the console recovers without a page refresh.
- **MongoDB is a single node.** Backups are per-collection consistent, not point-in-time across
  collections. A deployment that cannot tolerate that needs a replica set and `mongodump --oplog`
  (TD-38).
- **No rate limiting at the edge.** The gateway enforces authorization on every request; it does not
  throttle. Put a rate limiter in front for an internet-facing deployment (TD-39).
- **No log shipping.** Logs are JSON on stdout and are rotated locally. Wire a collector for
  retention beyond that.
