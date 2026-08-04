# P-5.8 — Production hardening: review package

**Milestone:** deployment, observability, recovery, backup/DR, capacity, security, real-CCTV status.
**Method:** the platform was deployed the way production runs it — Docker images, a TLS edge, no
`pnpm dev` anywhere — and then used through a browser until it broke.

|                    |                                                                               |
| ------------------ | ----------------------------------------------------------------------------- |
| Deployment         | 16 containers, Compose, Caddy edge, HTTPS, one host-port row                  |
| Defects found      | **9**, all fixed and verified in the deployment                               |
| Gate               | 28/28 test tasks · typecheck · lint (0 errors) · contracts · imports · format |
| Demo certification | passed — 11 steps, 10 clicks, browser only, 0 JS errors                       |
| ADRs               | [ADR-0036](../../adr/ADR-0036-browser-facing-object-storage-endpoint.md)      |

Contents: [VERIFICATION_MATRIX.md](VERIFICATION_MATRIX.md) ·
[PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md) · [CAPACITY.md](CAPACITY.md) ·
[CCTV_VALIDATION.md](CCTV_VALIDATION.md) · screenshots in this directory.

---

## The headline

**Playback did not work in a deployment, and had not since it was built.**

Evidence playback was the subject of three consecutive milestones. P-5.5 built it, P-5.6 hardened it
across four browser engines, P-5.7 verified it under network failure, at scale, and against an
operator workflow. All three passed. All three ran against `pnpm dev`.

The first time the platform was deployed, the playback API returned this:

```json
"url": "http://minio:9000/vip-recordings/tnt_dev/cam_dev_1/clip-003-h265.mp4?X-Amz-Signature=…"
```

`minio:9000` is a container-internal hostname. No browser can resolve it. It is plaintext `http://`
inside an HTTPS page, so the CSP blocks it as mixed content even in principle. Playback was not
degraded in a deployment — it was **completely non-functional**, in every browser, for every clip.

The cause is one line of coincidence: in development the browser and the services both reach MinIO at
`localhost:49000`, so a single endpoint serves two different roles and nothing distinguishes them.
[ADR-0036](../../adr/ADR-0036-browser-facing-object-storage-endpoint.md) separates them.

The defect was visible in one field of one JSON response for three milestones. Nothing looked,
because nothing had ever run the platform anywhere but the machine that wrote it.

---

## The nine defects

Each was found by deploying and using the platform, and each is fixed and re-verified in the running
deployment.

### 1. Playback URLs unusable in any deployment — _critical_

Signed URLs pointed at the container-internal object-store name.
**Fix:** `S3ObjectStore.publicEndpoint`, `S3_PUBLIC_ENDPOINT`, edge proxying `/vip-recordings/*`
(ADR-0036). **Verified:** `206 Partial Content` on a Range request, decoded 1280×720 in Chromium,
Firefox and WebKit.

### 2. The console was a blank page in production — _critical_

`manualChunks` matched `react-dom` as a path **substring**, which under pnpm also matches the peer
hash in the virtual-store directory (`…_@types+react-dom@19.2.3_react@19.2.7/…`). Radix, react-router
and sonner were swept into `vendor-react`; they import utilities from `vendor`, and `vendor` imports
React back — a **circular chunk dependency**. ES module cycles evaluate against uninitialised
bindings: `Cannot read properties of undefined (reading 'forwardRef')`, `#root` empty.

`vite build` succeeded, the bundle budget passed, 1,300 tests were green. None of them loads the
built bundle.
**Fix:** split by package **name**; `check-bundle-budget.mjs` now fails on any chunk cycle — proven
against the broken bundle before the fix landed.

### 3. `/health` and `/ready` returned the SPA — _high_

The console's fallback answers every unmatched path with `index.html` and HTTP 200. `GET /health`
returned the console's markup with a 200: an uptime monitor pointed at the obvious URL would have
reported the platform healthy with all ten services down.
**Fix:** explicit `handle` blocks at the edge. `/metrics` deliberately left unexposed.

### 4. The gateway's readiness probe could not fail — _high_

Every other service registers dependency checks; the gateway still had the Phase-0 empty registry, so
`/ready` answered `{"status":"pass","checks":[]}` unconditionally — on the one service a load balancer
gates traffic on.
**Fix:** a NATS check. Upstreams are deliberately **not** probed: the gateway can serve the other
eight when one is down, and failing readiness for one broken upstream would cause a larger outage
than the one being reported.

### 5. …and then it hung instead of failing — _high_

`flush()` blocks through the client's reconnect window. Measured: `/ready` returned nothing at all for
~25 s after the broker stopped. A probe that hangs is worse than one that fails.
**Fix:** bounded at 1 s; exceeding the bound _is_ the negative answer. Re-measured: 503 in 1.01 s,
deterministically.

### 6. A NATS restart broke the platform permanently — _high_

The client's default budget is ten attempts two seconds apart, so an outage longer than ~20 s closed
the connection for good. The gateway never recovered and reported `nats connection is closed` until
restarted. Every consumer shares this adapter, so one default turned a routine broker restart into a
platform-wide outage needing manual intervention.
**Fix:** unlimited reconnection with bounded jittered backoff. **Verified:** a 48-second outage,
recovery with no intervention.

### 7. A storage outage blamed the browser — _high_

With MinIO stopped mid-playback the overlay read _"This browser refused the recording… try another
browser or download the original."_ The browser refused nothing. `MEDIA_ERR_SRC_NOT_SUPPORTED` is
ambiguous: the engine reports it both when it genuinely refuses a fetchable file and when it could
not fetch one at all.
**Fix:** on that verdict the player asks — one `Range: bytes=0-0` against the same signed URL. It now
reads _"The connection dropped… this is a network problem between this browser and the evidence
store,"_ and one **Retry** click restores playback with no page refresh.

### 8. The production bootstrap set every password to `123456` — _high_

`docker compose --profile seed run --rm seed` is the documented first-tenant step, and the seed
hard-coded the development password on an **owner** account.
**Fix:** under `NODE_ENV=production` a 12+ character `SEED_PASSWORD` is required and the dev default
is refused outright; compose declares it `${SEED_PASSWORD:?}`. The password is never echoed when it
came from the environment — that output lands in the deployment log an operator pastes into a ticket.

### 9. Investigative metadata outlived sign-out — _medium_

Tokens were handled correctly (an access token is never persisted at all), but
`vip.workspace.state.<tenant>.<principal>` survived logout carrying the principal id and **the
incident ids the operator had open**. On a shared SOC terminal that tells the next person who was
here and what they were investigating.
**Fix:** cleared on logout, for every principal. `localStorage` is now empty after sign-out. Not
disabled — surviving a refresh is the feature; a session ending is the right boundary.

---

## Where my own harness was wrong, and how I knew

Four measurements in this milestone were invalid before they were valid. Reporting them would have
been worse than not measuring.

- **A recovery matrix that proved nothing.** Six restarts, six clean recoveries, every probe
  byte-identical to baseline. The clip was 10 seconds and fully buffered, so restarting the object
  store _could not_ affect it, and no action was taken that needed the restarted service. Rebuilt on
  the 1-hour clip with seeks past the buffer — and it produced a real finding (#7).
- **A readiness probe "failure" with NATS still running.** `$C="docker compose …"` does not
  word-split in zsh, so the stop never executed. Exit code 127 was the only clue.
- **Three security "failures".** DELETE/PUT/PATCH on evidence returned 400, not the 404/405/403 my
  assertion allowed. The routes genuinely do not exist — the 400s came from my harness sending a JSON
  content-type with no body. Evidence and custody were verified intact afterwards.
- **A demo certification that opened the wrong incident.** The capacity load left 27 incidents;
  the demo clicked one with no evidence. Test-data pollution, not a product defect — resolved by
  restoring the pre-load backup, which exercised the restore path a second time.

The rule that caught all four: **ask what a measurement is evidence of before reporting what it
appears to show** (ED-0067).

---

## What was proven

**Deployment.** 16 containers; exactly one publishes a host port. HTTPS with HSTS, CSP, and
`frame-ancestors 'none'`; HTTP 308s to HTTPS; zstd/gzip negotiated; `immutable` on fingerprinted
assets and `no-cache` on `index.html`; `no-store` on every API response.

**Observability.** Structured JSON logs; correlation id propagating edge → gateway → upstream (it did
not before — the gateway never forwarded one); client-supplied `X-Request-Id` stripped at both the
edge and the gateway; no secret, password or token in any log across a 20-minute window; Caddy
redacts `Authorization`; Prometheus metrics on all ten services, internal-only.

**Recovery.** Every dependency restarted under a live investigation. Five restarts completed faster
than the browser's next request and were not user-visible at all; the gateway restart produced real
network failures and recovered without a refresh. Sustained outages of MinIO and the gateway recover
on one Retry click.

**Backup and DR.** Volumes destroyed, stack rebuilt from nothing, restore applied: login, 1 incident,
3 evidence records, `HTTP 206` real media bytes, 7 custody entries. Proven twice.

**Security.** 25 checks: role boundaries, forged `x-tenant-id` cannot widen scope, unauthenticated
401s, re-signed and `alg:none` tokens rejected, internal headers stripped, tampered signature 403,
rewritten key 403, anonymous bucket listing 403, custody append-only, no delete/update route on
evidence, and signed-URL expiry genuinely enforced (`206 → 206 → 403`).

**Capacity.** Measured per-unit costs and a sizing table derived from them, labelled as arithmetic
rather than presented as a measurement — see [CAPACITY.md](CAPACITY.md).

---

## What was not proven

**Real CCTV and NVR hardware — still unavailable, still unverified.** No Hikvision, Dahua, CP Plus,
UNV or Axis device, and no NVR, was involved at any point. The clips are ffmpeg test patterns: real
H.264 and H.265 in real MP4 containers, which exercises the player honestly, and is not a claim about
what any camera produces. Details and the exact list of what remains unknown:
[CCTV_VALIDATION.md](CCTV_VALIDATION.md). TD-27, TD-28.

**Single host, single replica.** No clustering, no failover, no rate limiting at the edge, no log
shipping. MongoDB is a single node, so backups are per-collection consistent rather than
point-in-time. TD-38, TD-39.

**Load beyond one host.** 3,000 events through the real pipeline is a measurement; 500 cameras is
arithmetic on it.

---

## Recommendation

**The deployment is ready for a customer demonstration and for a pilot on a single host.** The
browser-only demonstration passes end to end with no developer intervention, and every defect this
milestone found is fixed and re-verified in the deployment rather than in a test.

Before a production installation with real cameras, two things must happen, and neither is code:

1. **Get hardware in front of it.** Playback correctness against real vendor recordings —
   variable bitrate, long durations, recording gaps, camera clock drift — is the single largest
   unverified area, and it has been carried since P-5.5. Everything else in this milestone was found
   by deploying; this one will only be found by connecting a camera.
2. **Decide the availability target.** Single-host with nightly backups means an RPO of up to 24
   hours and no failover. That is a legitimate choice for a pilot and a poor one for a customer who
   believes they bought continuous recording.

Suggested next milestone: **Demo Readiness v1** — the dashboards, reports and branding that make the
demonstration a product story rather than a workflow walkthrough. The architecture remains frozen;
nothing in this milestone needed a new service, and only one needed an ADR.
