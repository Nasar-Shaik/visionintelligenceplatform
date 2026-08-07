# UAT Guide

> **For a tester who has not seen this platform before.** Follow it top to bottom; it takes about
> 45 minutes. Every expected result below was measured on 2026-08-07, not predicted.

---

## Before you start — what this product does and does not do

⛔ **Read this out loud to anyone watching.** It is the difference between a demonstration and a
misrepresentation.

| ✅ Does | ⛔ Does not |
| --- | --- |
| Analyse an uploaded recording through the same pipeline a live camera uses | **Work with any real camera — none has ever been connected** ([L-1]) |
| Detect **person · vehicle · fire · smoke** | Detect theft, loitering-as-intent, falls, fights or PPE ([L-2]) |
| Track identities, evaluate rules, raise incidents, capture stills, export a report | Show the event/track/density timeline — computed but not rendered ([V-7]) |
| Reproduce an analysis exactly, any number of times | Guarantee accuracy on **real venue footage** ([L-63]) |

---

## 1 · Environment

| | |
| --- | --- |
| **URL** | `https://localhost` |
| ⚠️ **Certificate** | Caddy's **internal CA**. Your browser will warn. That is expected locally and correct: TLS is real, the CA is simply not in your trust store. Accept and continue |
| **Requirements** | Docker Desktop (≥ 8 GB to the VM), Node ≥ 22, pnpm ≥ 10 |

```sh
git clone <repo> && cd VisionIntelligencePlatform
pnpm install
./infra/docker/prod.sh up -d          # ⚠️ never bare `docker compose` — the env-file wiring matters
./infra/docker/prod.sh --profile seed run --rm seed
node tools/validation/verify-deployment.mjs      # expect: ✓ the deployment is online (31 checks)
```

⛔ **Do not proceed if `verify-deployment.mjs` fails.** Every result below assumes it passed.

## 2 · 🔑 Test accounts

The login form has **three** fields and all three are required:

| Field | Type this |
| --- | --- |
| **Tenant** | `tnt_demo_retail` |
| **Email** | `security.manager@northgate.demo` |
| **Password** | `12345678` |

> ⛔ **The Tenant field is what trips most first-time testers.** It is not the company name and not
> your email domain — it is the tenant **id**, exactly as written. A wrong tenant returns "invalid
> credentials", which reads like a wrong password and sends you looking in the wrong place.

### The two accounts this guide uses

| Role | Email | Tenant | Password | User ID | Used in |
| --- | --- | --- | --- | --- | --- |
| **Admin** ⭐ | `security.manager@northgate.demo` | `tnt_demo_retail` | `12345678` | `usr_demo_retail_mgr` | Steps 1–8, 10–12 |
| **Viewer** | `loss.prevention@northgate.demo` | `tnt_demo_retail` | `12345678` | `usr_demo_retail_loss` | Step 9 only |

**All 17 demo accounts across all 5 tenants use the same password `12345678`.** The full table —
retail, warehouse, school, hospital and dev — is in
[CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md#-login-credentials).

**If a login fails:**

```sh
node tools/validation/reset-demo-passwords.mjs        # re-set, then verify by logging in to each
node tools/validation/reset-demo-passwords.mjs --list # just show the accounts
```

A `✓` in that output means the account was signed into through the real endpoint — not that a
database row was written.

> ⛔ **`12345678` is a deliberately trivial password on entirely synthetic data.** A real deployment
> changes `SEED_PASSWORD` in `.env.production` before first login, and the reset script refuses to
> touch any tenant that is not `tnt_dev` or `tnt_demo_*`.

## 3 · Sample videos

```sh
node tools/dataset/generate.mjs --verify      # ~10 min, needs the deployment up
```

Produces `infra/docker/fixtures/media/validation/`. The ones this guide uses:

| File | What it is | Ground truth |
| --- | --- | --- |
| `multiple-people.mp4` | Two people crossing, 30 s | 2 people |
| `empty-scene.mp4` | Nobody, 30 s | **0** — the honesty test |
| `crowd.mp4` | Eight people, 30 s | 8 people |
| `corrupt-not-a-video.mp4` | A text file renamed `.mp4` | Must be **refused** |

---

## Execution

### Step 1 · Sign in

1. `https://localhost`, accept the certificate warning.
2. Tenant `tnt_demo_retail`, the admin email and password, **Sign in**.

**Expect:** the console with a left sidebar. ⬜ Pass ⬜ Fail

### Step 2 · Find the feature

Click **Recorded Video** in the sidebar (under INVESTIGATE).

**Expect:** heading "Investigations"; a camera selector; **"MP4 only, up to 2 GB and 4 hours"**;
the upload button **disabled**.

> ⚠️ The disabled button is deliberate. The camera carries the detection zones and the rule scope, so
> an analysis bound to the wrong one produces a **confident wrong answer**. ⬜ Pass ⬜ Fail

### Step 3 · Upload

Choose camera **Main Entrance**, then **Upload a recording** → `multiple-people.mp4`.

**Expect:** a row appears named `multiple-people.mp4` within ~5 s. ⬜ Pass ⬜ Fail

### Step 4 · Run the analysis

Click the row, then **Run analysis**.

**Expect (measured):**

| | |
| --- | --- |
| State | `queued` → `starting`/`running` → `succeeded` in **~4 s** |
| Frames | **60 / 60** |
| Speed | ~×9 real time |
| Model | `yolox-nano` |
| ⚠️ A yellow banner | *"the file carried no creation time, so the upload time was used as the footage start…"* |

> ⭐ **The banner is a feature, not a warning to dismiss.** The platform is telling you that incident
> times in this analysis are offsets from the upload, not real clock times — because the MP4 carried
> no creation date. A product that silently guessed would misdate every incident in a court bundle.
> ⬜ Pass ⬜ Fail

### Step 5 · Timeline and incidents

**Expect:** a **Timeline** section listing incidents with a footage offset (`00:24`), a title, a
status, and a **Capture still** button on each.

> ⚠️ **Known gap [V-7]:** only *incidents* are listed here. The individual detections, track spans
> and density are computed by the backend and **not yet rendered**. If a tester asks "where are the
> events?" — that is a real gap, correctly observed, and it is the first thing P-8.6 closes.
> ⬜ Pass ⬜ Fail

### Step 6 · Evidence

Click **Capture still** on any incident.

**Expect:** a real photograph appears within ~1 s, captioned with its **footage** offset and time —
not the time you clicked. ⬜ Pass ⬜ Fail

### Step 7 · ⭐ The honesty test

Upload `empty-scene.mp4` to the same camera and run it.

**Expect:** `succeeded`, **60/60 frames**, and the words **"Nothing was detected in this
recording"** — with **no** incidents and **no** events.

> ⭐ **This is the single most important step in this guide.** Every other step asks whether the
> platform finds things. This one asks whether it **invents** them. A surveillance product that
> raises a false alarm on an empty shop has lost the customer's trust permanently, and no amount of
> accuracy elsewhere buys it back. ⬜ Pass ⬜ Fail

### Step 8 · Reproducibility

Open `multiple-people.mp4` again and click **Run analysis** a second time.

**Expect:** run **#2** appears alongside #1. **Identical** frames, events and incidents. Run #1 is
**not** replaced.

> ⭐ Two runs of one recording are two independent records — so a rule change next month can be
> compared against today's result rather than overwriting it. ⬜ Pass ⬜ Fail

### Step 9 · Permissions

Sign out. Sign in as the **viewer**. Go to Recorded Video.

**Expect:** the list is readable; the upload control is **absent or disabled**.

> ⚠️ A button that returns 403 is worse than an absent one — it teaches an operator the product is
> broken. ⬜ Pass ⬜ Fail

### Step 10 · Bad input

Sign back in as admin. Upload `corrupt-not-a-video.mp4`.

**Expect:** refused, with a message naming the reason (*"could not be read as a video"*). ⛔ The
message must **not** contain a URL, `X-Amz-Credential`, or `minio:9000`.

> ⛔ That last check is [V-5], a real defect found in this phase: the error used to return a live
> object-storage credential to the caller. ⬜ Pass ⬜ Fail

### Step 11 · Refresh and bookmark

On an analysis page, copy the URL, press **F5**, then paste the URL into a new tab.

**Expect:** the same page both times. ⬜ Pass ⬜ Fail

### Step 12 · Demonstration mode

Open any analysis and click **Demonstrate at real time**.

**Expect:** it runs **visibly slower** — a 30 s clip takes ~30 s rather than ~4 s.

> ⭐ Same pipeline, one parameter. It is not a playback animation; the runtime is genuinely being fed
> at footage speed. ⬜ Pass ⬜ Fail

---

## Pass / Fail summary

| # | Step | ⬜ |
| --- | --- | --- |
| 1 | Sign in | ⬜ |
| 2 | Recorded Video reachable, limits stated, button gated | ⬜ |
| 3 | Upload appears | ⬜ |
| 4 | Analysis succeeds, 60/60, ~×9, footage-time banner | ⬜ |
| 5 | Timeline lists incidents with offsets | ⬜ |
| 6 | Evidence still is a real image at a footage offset | ⬜ |
| 7 | ⭐ **Empty scene detects nothing and says so** | ⬜ |
| 8 | Rerun is independent and identical | ⬜ |
| 9 | Viewer cannot upload | ⬜ |
| 10 | Bad file refused with a reason, no credential leaked | ⬜ |
| 11 | Refresh and deep link survive | ⬜ |
| 12 | Demonstration mode is measurably paced | ⬜ |

**UAT passes when all twelve pass.** Any failure → record the step, the screenshot and the
`correlationId` from the error body, and raise it against this document.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| ⛔ **Analysis says `succeeded` but 0 events and a huge speed factor (×200+)** | The camera has no AI assignment ([L-65]). The session records `assignment-missing` in its findings | `curl -sk https://localhost/api/media/perception/assignment -H "authorization: Bearer $TOKEN"` → if `plannedCameras: 0`, re-enable the camera's assignment. **This was [V-1]** — a full runtime could deadlock here permanently; fixed 2026-08-07 |
| Browser refuses to load the page | Caddy's internal CA | Accept the warning, or `sudo security add-trusted-cert` the Caddy root |
| Upload button stays disabled | No camera chosen | Choose one — it is required, by design |
| `verify-deployment.mjs` fails on a service | That container is unhealthy | `./infra/docker/prod.sh logs <service>` |
| Analysis stuck in `queued` | Worker busy — `maxConcurrent: 1` ([L-41]) | Wait; check `/api/media/analyses/<id>` |
| Fixtures missing | Not generated | `node tools/dataset/generate.mjs --verify` |
| Everything is slow | Docker VM under-provisioned | Give Docker ≥ 8 GB and ≥ 4 CPUs |

---

## Related

- [CUSTOMER_ACCEPTANCE_CHECKLIST.md](CUSTOMER_ACCEPTANCE_CHECKLIST.md) — the pre-demo checklist
- [END_TO_END_TEST_GUIDE.md](END_TO_END_TEST_GUIDE.md) — the engineer's version of this
- [FIRST_PRODUCT_VALIDATION.md](FIRST_PRODUCT_VALIDATION.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
