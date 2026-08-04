# Pilot Readiness Matrix

Ten areas, reviewed against the running production deployment and the repository on 2026-08-04.

**Legend** — ✅ proven by running software · ⚠️ works with a stated caveat · ⛔ would block a first
customer deployment · ⬜ never exercised

| #   | Area                             | State | Evidence / gap                                                                                                                                                                                                                      |
| --- | -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Installation**                 | ✅    | Clone → `.env.production` → `prod.sh up -d --build`. 16 containers, one host-port row, HTTPS + redirect. A second engineer provisioned a clean host from [DEPLOYMENT.md](../../runbooks/DEPLOYMENT.md) alone in P-5.8               |
| 2   | **Onboarding — tenant & estate** | ⚠️    | Hierarchy, cameras, zones, bulk import and discovery all work. ⚠️ **The tenant slug must be typed by hand at every sign-in** (TD-40)                                                                                                |
| 3   | **Onboarding — people**          | ⛔    | **Identity exposes `POST /users` and `GET /users` and nothing else.** No update, no role change, no password reset, **no way to disable an account**                                                                                |
| 4   | **Operator workflow**            | ✅    | Queue → investigate → play → bookmark, **6 clicks in 21.6 s**, measured end-to-end against the production deployment. Guide: [OPERATOR_GUIDE.md](../../runbooks/OPERATOR_GUIDE.md)                                                  |
| 5   | **Administrator workflow**       | ⛔    | `/settings` and `/health` are placeholder pages. Rules, cameras and locations are manageable in the console; **users, roles and tenant settings are not**                                                                           |
| 6   | **Backup**                       | ✅    | `backup.sh` covers Mongo, MinIO and configuration. ⚠️ Per-collection consistent, not point-in-time (TD-38)                                                                                                                          |
| 7   | **Restore**                      | ✅    | **Proven twice in P-5.8.** Volumes destroyed, stack rebuilt, restore returned login, incidents, evidence, HTTP 206 real media bytes and 7 intact custody entries                                                                    |
| 8   | **Upgrades**                     | ✅    | [UPGRADE.md](../../runbooks/UPGRADE.md), executed. ⚠️ `branding.json` must be bind-mounted or an upgrade overwrites it — checklist item 7.1                                                                                         |
| 9   | **Rollback**                     | ✅    | [ROLLBACK.md](../../runbooks/ROLLBACK.md), executed                                                                                                                                                                                 |
| 10  | **Monitoring**                   | ⚠️    | `/health` and `/ready` are real and **proven able to fail** (stop NATS → 503). `/metrics` exists per service and is deliberately not exposed at the edge. ⚠️ No dashboard ships — the customer points their own monitor at `/ready` |
| 11  | **Troubleshooting**              | ✅    | [TROUBLESHOOTING.md](../../runbooks/TROUBLESHOOTING.md), written from nine defects found by deploying, not from imagination                                                                                                         |

---

## ⛔ The two blockers

### B-1 · An account cannot be disabled

`services/identity/src/transport/routes/users.ts` registers exactly two routes: `POST /users` and
`GET /users`.

There is no path — console, API or CLI — to deactivate a user, change their role, or reset their
password. For a **security** product this is the sharpest gap in the platform: an offboarded
employee keeps their access, and the customer's own security policy will require this before they
sign anything.

It also makes an existing checklist item unachievable.
[PILOT_INSTALLATION_CHECKLIST](../../runbooks/PILOT_INSTALLATION_CHECKLIST.md) item **3.3 —
"Bootstrap passwords changed; unused accounts disabled"** — cannot be completed as written. That
checklist was written before this was noticed; it is corrected by fixing the product, not the
checklist.

**Fix:** additive routes on Identity (`PATCH /users/:id`, `POST /users/:id/disable`,
`POST /users/:id/password`) plus the console screen. No frozen contract changes; `CreateUserInput`
gains an `UpdateUserInput` sibling. **P-6.**

### B-2 · A rule cannot be edited

TD-21. Submitting an existing rule fails client-side validation on `lifecycle` and `severity` — both
Radix `Select`s driven by react-hook-form `Controller`s — so the PATCH never fires. Pre-existing,
reproduced against the pre-P-4 editor.

The server side is fine and unusually complete: `PATCH /rules/:id` works, and versions, diff,
rollback, dry-run and audit routes all exist. **This is a client-side form defect standing in front
of a working versioned rule engine.**

Workaround for a pilot: author a replacement rule and retire the original. Acceptable for a demo,
not for a customer who will tune thresholds weekly.

**Fix:** P-6, first item.

---

## ⚠️ The caveats to state before signing, not after

| Caveat                                 | What to say to the customer                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No live view** (TD-28)               | "Live monitoring is not in this release. The platform investigates recorded evidence." Say it in the first meeting — it is one click from the login screen |
| **No behaviour detection** (TD-14)     | The platform detects person, vehicle, fire and smoke. It does **not** detect theft, loitering or intrusion yet                                             |
| **No hardware validated** (TD-27)      | No camera or NVR of any make has ever been connected. The pilot _is_ the validation                                                                        |
| **No evidence export** (TD-16)         | Evidence plays and downloads with custody intact. There is no signed bundle to hand to a third party                                                       |
| **No search** (Q-5/Q-6)                | The queue filters and the estate browses. There is no cross-platform search and no saved investigation                                                     |
| **Dark theme only** (TD-43)            | Deliberate for a control room. There is no light theme                                                                                                     |
| **Branding is per-deployment** (TD-42) | One brand per installation. A reseller serving several brands needs several installations                                                                  |

None of these is a surprise on the day if it is on the table before it.
[KNOWN_LIMITATIONS](../p59/KNOWN_LIMITATIONS.md) is written to be read _with_ the customer.

---

## ⬜ Never exercised

| Area                                  | Why it stayed unexercised                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Any real camera or NVR                | No hardware available. Recorded honestly rather than simulated — [CCTV_READINESS](../p59/CCTV_READINESS.md) |
| H.265 decode                          | No HEVC encoder locally; support known from `canPlayType()` probing only (TD-29)                            |
| Multi-host / HA deployment            | Single-host is the pilot topology by design                                                                 |
| A second concurrent tenant under load | Isolation is tested; concurrent multi-tenant load is not                                                    |

---

## Verdict

**Conditional GO for a first customer pilot**, conditional on **B-1 and B-2** — both P-6, both
small, neither architectural.

Everything a pilot depends on structurally — install, restore, upgrade, rollback, monitoring,
documentation — is proven by execution rather than asserted. What is missing is not infrastructure.
It is two screens and three routes.
