# Troubleshooting

Symptom → cause → fix. Every entry here is a failure that actually occurred during P-5.8
verification, or one the design makes likely enough to write down.

---

## First moves

```sh
infra/docker/prod.sh ps                        # what is running and healthy
curl -kfsS https://localhost/ready             # dependencies reachable?
infra/docker/prod.sh logs --since 15m | grep '"level":50'   # errors
infra/docker/prod.sh logs -f <service>
```

Every error response carries a `correlationId`. It is the same value as `reqId` in the logs of the
gateway **and** the upstream service, so one user report maps to exact lines across services:

```sh
infra/docker/prod.sh logs --since 1h | grep <correlationId>
```

---

## The stack will not start

**`error while interpolating … required variable JWT_SECRET is missing`**
Working as designed. Every secret is `${VAR:?}` so Compose refuses rather than deploying with a
development key. Fill in `.env.production` ([DEPLOYMENT.md §2](DEPLOYMENT.md)).

**A service restarts in a loop**
Almost always fail-fast config validation. `infra/docker/prod.sh logs <service> --tail 40` names the
variable. Ten services restarting together usually means one shared value (`MONGO_URI`, `NATS_URL`)
is wrong, not ten separate problems.

**`up -d` hangs on "waiting"**
A dependency is not becoming healthy. `infra/docker/prod.sh ps` shows which. Services wait for Mongo
and NATS to be _healthy_, not merely started, because a service that boots before its dependency dies
and restarts in a way that looks identical to a broken build.

---

## The console is blank

**White page, `Cannot read properties of undefined (reading 'forwardRef')` in the browser console**
A circular chunk dependency in the built bundle. Circular ES modules evaluate against uninitialised
bindings. This shipped once, in P-5.8, from a `manualChunks` rule that matched `react-dom` as a
_substring_ — which under pnpm also matches the peer hash in the virtual-store path, sweeping Radix
and react-router into the React chunk.

`apps/console/scripts/check-bundle-budget.mjs` now fails the build on any chunk cycle, so a bundle
with this defect cannot be produced. If you see it, you are running an image built before that gate:
rebuild (`infra/docker/prod.sh up -d --build console`).

**Page loads but every API call 502s**
The gateway is down or restarting. `infra/docker/prod.sh ps gateway`. The console shows an honest
error and recovers on its own once the gateway returns — no page refresh needed.

---

## Playback

**"The connection dropped … a network problem between this browser and the evidence store"**
Accurate: the object store is unreachable. `infra/docker/prod.sh ps minio`. Press **Retry** in the
player once it is back — verified to recover without a page refresh.

**"This browser cannot decode this file … no H.265 (HEVC) decoder"**
Not a fault. HEVC support is a licensing decision made when the browser is built; open-source
Chromium builds refuse H.265 that branded Chrome, Edge, Safari and Firefox play. The evidence is
intact — the overlay says so, and offers the download.

**"This browser refused the recording"**
The engine declined a file it _could_ fetch. A positive `canPlayType` is advisory, not a guarantee
(measured across engines in P-5.6). Try another browser or download the original.

**Video never loads; the URL contains `minio:9000`**
`S3_PUBLIC_ENDPOINT` is unset or wrong. Services reach object storage at a container-internal name no
browser can resolve. It must be your public URL — `docker-compose.prod.yml` sets it from
`VIP_PUBLIC_URL`. See [ADR-0036](../adr/ADR-0036-browser-facing-object-storage-endpoint.md).

**Every playback URL returns 403**
The signature covers the `Host` header. If a proxy in front of Caddy rewrites `Host`, MinIO validates
against a name that was never signed. Preserve it (Caddy does by default; nginx needs
`proxy_set_header Host $host`). Also check clock skew — SigV4 is time-bound.

**Playback worked, then stopped after ~15 minutes**
Signed URLs expire (`EVIDENCE_DOWNLOAD_TTL_SECONDS`, default 900). The player detects this and offers
"Resume playback", which fetches a new link. Short lifetimes are deliberate: a signed URL is a bearer
link for one object until it expires.

---

## Health and readiness

**`/health` returns HTML with a 200**
The probe is not reaching the gateway — the SPA fallback answers every unmatched path with
`index.html`. Check the `handle /health` block in `infra/docker/Caddyfile`. This exact failure would
have had an uptime monitor reporting the platform healthy with all ten services down.

**`/ready` says `{"status":"fail",…,"nats did not respond in 1000ms"}`**
NATS is unreachable. `infra/docker/prod.sh ps nats`. The probe is bounded at one second on purpose: a
readiness endpoint that hangs is worse than one that fails, because a stalled probe consumes its
timeout and tells you nothing.

**A service reports ready but events are not flowing**
Only the gateway checks NATS. Other services check their database, so a dead backbone does not make
them unready. Check the backbone directly:
`infra/docker/prod.sh exec nats wget -qO- http://localhost:8222/healthz`.

---

## Data and events

**Events published but no incidents raised**
The pipeline is capability output → events → rules → workflow → notify. Find where it stops:

```sh
for s in events rules workflow notify; do
  echo "== $s"; infra/docker/prod.sh logs $s --since 10m --tail 5
done
```

A common cause is no enabled rule matching the event type. Rules are versioned and immutable —
"editing" a rule creates a new version, so check you enabled the version you edited.

**Fewer incidents than events, by a lot**
Working as designed. Candidates are de-duplicated within
`RULES_CANDIDATE_DEDUP_WINDOW_MS` (default 60 s). P-5.8 measured 3,000 events collapsing to 27
incidents — that is the dedup window, not lost data.

**A NATS restart broke the pipeline permanently**
Fixed in P-5.8: the client's default budget was ten reconnect attempts two seconds apart, so an
outage over ~20 s closed the connection for good and the gateway never recovered. Reconnection is now
unlimited with bounded jittered backoff. If you see this, you are running an image built before that
fix.

---

## Certificates

**Browser warns about the certificate**
Expected with `VIP_PUBLIC_URL=https://localhost` — Caddy's internal CA is genuine TLS from a root
your machine has not been told to trust. For a public certificate, set a real hostname with public
DNS and reachable ports 80 and 443.

**ACME will not issue**
Caddy needs inbound :80 for the HTTP-01 challenge. Check the firewall, that DNS resolves to this
host, and `infra/docker/prod.sh logs proxy | grep -i acme`.

---

## Performance

Measured baselines on a 4-core dev host, for comparison rather than as thresholds
([CAPACITY.md](../review/p58/CAPACITY.md)):

|                                | Measured                |
| ------------------------------ | ----------------------- |
| Idle memory, all 16 containers | ~1.2 GB                 |
| Idle CPU                       | < 1 % per service       |
| Event ingest, end to end       | ≥ 600 events/s          |
| Incident list, 25 rows         | p50 9 ms · p95 13 ms    |
| Events page over 3,001 events  | p50 9 ms · p95 11 ms    |
| 100 concurrent list requests   | p50 117 ms · p95 184 ms |

If reads are far slower than this, check that indexes were built — a service reconciles them at
startup, and a large collection takes time on first start after an upgrade.

---

## Disk

**MinIO out of space**
Recordings dominate storage. Check `EVIDENCE_DEFAULT_RETENTION_DAYS` (0 = indefinite) and the sizing
table in [CAPACITY.md](../review/p58/CAPACITY.md). Never delete objects out from under the manifest:
evidence is immutable and the custody chain records what should exist. Retire evidence through the
platform, not through `mc rm`.

**Logs filling the disk**
Capped at 10 MB × 5 per container by compose. If they are growing anyway, something is overriding the
logging driver.
