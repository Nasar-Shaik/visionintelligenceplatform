# End-to-End Test Guide

> **The engineer's version of [UAT_GUIDE](UAT_GUIDE.md).** From a clean machine to a full
> verification gate, with the commands that produce the evidence.

---

## 0 · Prerequisites

| | |
| --- | --- |
| Docker Desktop | ≥ 8 GB and ≥ 4 CPUs to the VM. ⚠️ Below this the runtime is the bottleneck and every timing is meaningless |
| Node | ≥ 22 |
| pnpm | ≥ 10 (`packageManager` pins 11.17.0) |
| Disk | ~15 GB — images, models, fixtures, MinIO |
| ⚠️ ffmpeg | **Not needed on the host.** Every ffmpeg call runs in a container, deliberately: a host binary would be an undeclared dependency whose version nobody controls |

## 1 · Bring the stack up

```sh
pnpm install
./infra/docker/prod.sh build            # first time, ~15 min
./infra/docker/prod.sh up -d
./infra/docker/prod.sh --profile seed run --rm seed
```

> ⛔ **Always `prod.sh`, never bare `docker compose`.** Without `--env-file .env.production`, compose
> silently falls back to `.env` — the *development* file — and the stack comes up with the dev JWT
> secret and the dev Mongo password while every container reports healthy.

### Environment variables that matter

| Variable | Where | Why |
| --- | --- | --- |
| `SEED_TENANT_ID` / `SEED_EMAIL` / `SEED_PASSWORD` | `.env.production` | The first login. ⚠️ Change before any real deployment |
| `INTERNAL_API_KEY` | `.env.production` | Service-to-service (ADR-0018). ⛔ Never leaves a container — expand it *inside* one |
| `INFERENCE_CAPABILITY_ID` | media | Default `perception.person-detection` |
| `INFERENCE_TRACKING_ENABLED` | inference | Default on |
| `VIP_BASE_URL` | browser suite | Defaults `https://localhost` |

## 2 · Verify the deployment

```sh
node tools/validation/verify-deployment.mjs          # 31 checks
node tools/validation/verify-deployment.mjs --json   # machine-readable evidence
```

Checks 17 containers, edge TLS + headers + the plaintext redirect, an unauthenticated 401, login,
8 services through the gateway, the runtime, MinIO through the edge, the console's hashed bundle,
and JetStream.

⛔ **Nothing below is meaningful if this fails.**

## 3 · Test accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | `security.manager@northgate.demo` | `12345678` |
| Viewer | `loss.prevention@northgate.demo` | `12345678` |

Tenant `tnt_demo_retail`. ⚠️ Seeded demo credentials, local deployments only.

```sh
TOKEN=$(curl -sk -X POST https://localhost/api/identity/auth/login \
  -H 'content-type: application/json' -H 'x-tenant-id: tnt_demo_retail' \
  -d '{"email":"security.manager@northgate.demo","password":"12345678"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')
```

## 4 · Sample videos

```sh
node tools/dataset/generate.mjs --verify   # 37 clips + measured manifest, ~10 min
node tools/dataset/large.mjs               # duration ladder, on demand
```

⚠️ Needs the deployment up — sprites are cropped at boxes the **live model** returns, and `--verify`
asks it what it sees. See [TEST_DATASET.md](TEST_DATASET.md).

---

## 5 · Execution order

⛔ **The order matters.** Each stage assumes the previous one passed; running the browser suite
against a stack whose runtime is broken produces failures that describe the wrong subsystem.

```sh
# 1 — the repo gate. No Docker. ~2 min.
pnpm turbo lint typecheck test

# 2 — the Python runtime. 1 057 tests.
docker exec vip-prod-inference-1 sh -c \
  'cd /app && PYTHONPATH=/app python -m unittest discover -s /app/tests -p "test_*.py" -t /app/tests'

# 3 — the deployment is online.
node tools/validation/verify-deployment.mjs

# 4 — the dataset is trustworthy (re-measures ground truth).
node tools/dataset/generate.mjs --verify

# 5 — the product, through the real API. ~15 min for --all.
node tools/validation/validate.mjs --out=artifacts/validation/run.json
node tools/validation/validate.mjs --all --out=artifacts/validation/full.json

# 6 — the product, in four real browsers.
pnpm --filter @vip/e2e-browser certify
pnpm --filter @vip/e2e-browser exec playwright test --project=firefox --project=webkit --project=edge
```

## 6 · Expected results

| Stage | Expect |
| --- | --- |
| 1 · repo gate | **69/69 tasks**, 0 failures |
| 2 · Python | **1 057 tests**, ⚠️ 6 pre-existing environmental failures (`test_dataset`, `test_camera_registry`, `test_detection_identity` read repo files absent from the image) |
| 3 · deployment | **31/31** |
| 4 · dataset | **37 clips**, negative control **0 detections** |
| 5 · validation | **8/8** standard. `--all` → 4 corrupt clips *correctly* fail at create/confirm |
| 6 · browser | **20/20** Chromium; 4/4 each on Edge, Firefox, WebKit |

⚠️ **In `--all`, four "failures" are passes.** `corrupt-zero-bytes`, `corrupt-truncated-header`,
`corrupt-not-a-video` and `corrupt-audio-only` are *supposed* to be refused; the harness reports a
journey that did not complete, and for those four that is the correct outcome. Read the reason.

---

## 7 · API verification

```sh
B=https://localhost; A="authorization: Bearer $TOKEN"
curl -sk "$B/api/media/analyses" -H "$A"                      # list
curl -sk "$B/api/media/analyses/$ID" -H "$A"                  # { analysis, sessions }
curl -sk "$B/api/media/analyses/$ID/timeline" -H "$A"         # entries, tracks, density, incidents
curl -sk "$B/api/media/analyses/$ID/report" -H "$A"           # export
curl -sk "$B/api/workflow/incidents?analysisSessionId=$SID" -H "$A"
curl -sk "$B/api/media/perception/assignment" -H "$A"         # ⛔ plannedCameras MUST be > 0
```

⛔ **Two isolation checks that must return zero:**

```sh
curl -sk "$B/api/workflow/incidents?limit=200" -H "$A" \
  | python3 -c 'import sys,json;print(len([i for i in json.load(sys.stdin)["data"]["items"] if i.get("analysisSessionId")]))'
curl -sk "$B/api/events/events?limit=200" -H "$A" \
  | python3 -c 'import sys,json;print(len([e for e in json.load(sys.stdin)["data"]["events"] if e.get("analysisSessionId")]))'
```

Non-zero means offline findings have reached a live operator's work list.

## 8 · Runtime verification

```sh
docker exec vip-prod-media-1 sh -c \
  'curl -s "http://inference:8085/tracking?cameraId=cam_retail_entrance" \
   -H "x-internal-key: $INTERNAL_API_KEY" -H "x-tenant-id: tnt_demo_retail"'
```

| Field | Healthy | ⛔ Investigate |
| --- | --- | --- |
| `framesTracked` | rising | flat while analyses run |
| `outOfOrderFrames` | **0** | ⛔ **rising — this was [V-2]**, which produced 1 244 rejected against 906 tracked |
| `camerasTracked` | 1 per live camera + 1 per running analysis | — |

## 9 · Database verification

```sh
docker exec vip-prod-mongodb-1 mongosh -u root -p "$MONGO_PASSWORD" --quiet --eval '
  const db = db.getSiblingDB("vip");
  print("analyses      ", db.analyses.countDocuments());
  print("sessions      ", db.analysis_sessions.countDocuments());
  print("events        ", db.events.countDocuments());
  print("offline events", db.events.countDocuments({analysisSessionId:{$exists:true}}));
  print("incidents     ", db.incidents.countDocuments());
  db.events.getIndexes().forEach(i => print("idx", i.name));
'
```

⚠️ **Indexes must be backward compatible.** `analysisSessionId` is additive and sparse — an index on
it must not exclude the live events that lack the field entirely.

## 10 · Troubleshooting

| Symptom | Diagnosis | Fix |
| --- | --- | --- |
| ⛔ `succeeded` with 0 events and ×200+ speed | No AI assignment — session findings say `assignment-missing` | `plannedCameras`; re-enable. **[V-1]** made this permanent on a full runtime |
| `outOfOrderFrames` rising | Tracker rejecting frames | **[V-2]** — confirm the inference image is post-2026-08-07 |
| Rerun produces no incidents | Incident dedup collision | **[V-4]** — confirm the rules image is post-2026-08-07 |
| Confirm fails, "Connection refused" | Probe given a *browser* URL | `presignInternalGet`, not `presignGet` |
| A credential in an error body | **[V-5]** | `redactUrls` in `analysis-service.ts` |
| Sessions stuck `queued` | `maxConcurrent: 1` ([L-41]) | Wait, or raise it and accept the CPU cost |
| Browser suite: strict-mode violation | Two elements share a name | **[V-6]** was exactly this — a real UI defect, not a test bug |
| Everything slow | Docker under-provisioned | ≥ 8 GB, ≥ 4 CPUs |

## 11 · Recovery

```sh
./infra/docker/prod.sh restart <service>          # one service
./infra/docker/prod.sh down && ./infra/docker/prod.sh up -d
./infra/docker/prod.sh build <service> && ./infra/docker/prod.sh up -d <service>
```

⛔ **After any runtime restart, check the assignments recovered:**

```sh
curl -sk "$B/api/camera/assignments" -H "$A" \
  | python3 -c 'import sys,json;
d=json.load(sys.stdin)["data"];
print({s: sum(1 for a in d if a["state"]==s) for s in {a["state"] for a in d}})'
```

⚠️ Cameras in `error` with `placementFailure: capacity-exceeded` were **[V-1]**. Fixed 2026-08-07;
if you see it again on a build older than that, free one slot to unblock it.

**Full reset (destroys data):**
```sh
./infra/docker/prod.sh down -v && ./infra/docker/prod.sh up -d
./infra/docker/prod.sh --profile seed run --rm seed
```

## 12 · Regression execution

| When | Run |
| --- | --- |
| Every commit | `pnpm turbo lint typecheck test` |
| Touching `ai/inference` | + the Python suite (§5.2) |
| Touching media/events/rules/workflow | + `verify-deployment` + `validate.mjs` |
| Touching `apps/console` | + `certify` (Chromium at minimum) |
| Before a customer demo | [CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md) |
| Before a milestone close | Everything, all four browsers, `--all` |

> ⛔ **The repo gate cannot catch the defects that matter most.** All six found in P-8.5 passed it.
> Stages 3–6 are not optional extras; they are the only layers that test the joins.

---

## Related

- [TEST_PLAN.md](TEST_PLAN.md) · [TEST_DATASET.md](TEST_DATASET.md) · [UAT_GUIDE.md](UAT_GUIDE.md)
- [PERFORMANCE_BASELINE.md](PERFORMANCE_BASELINE.md) · [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md)
