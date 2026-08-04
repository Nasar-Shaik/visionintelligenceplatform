# Administrator Guide

For the person who owns the deployment: users, cameras, the estate, rules, and branding. Assumes
someone has already installed it ([DEPLOYMENT.md](DEPLOYMENT.md)).

---

## 1 · Users and roles

Four roles, deny-by-default. A permission that is not granted is refused, and the console hides
what the signed-in user cannot do rather than showing a control that will fail.

| Role         | Can                                                                       |
| ------------ | ------------------------------------------------------------------------- |
| **owner**    | Everything, including tenant settings                                     |
| **admin**    | Users, cameras, locations, rules; everything an operator can do           |
| **operator** | Work the queue: acknowledge, investigate, comment, resolve, view evidence |
| **viewer**   | Read-only. Sees incidents and evidence; changes nothing                   |

Verified: a `viewer` attempting to create a rule receives **403**, at the API, not just in the UI.

### First-run accounts

The bootstrap seed creates one account per role. **Change every password at first login and disable
the ones you do not need.** Under `NODE_ENV=production` the seed refuses to run without a strong
`SEED_PASSWORD`, but strong is not the same as _yours_.

---

## 2 · The estate

**Locations** is the hierarchy: organisation → region → site → building → floor → zone. Cameras hang
off it.

Build it before adding cameras. Two reasons, both practical:

- **Rules scope to the hierarchy.** "Alert on intrusion in the _perimeter_" survives adding a tenth
  perimeter camera. "Alert on these nine camera ids" does not.
- **A node's type is immutable.** A floor does not become a region because someone edited a form —
  that would reinterpret every record that ever referenced it. Getting it wrong means creating the
  right node and moving the children, an operation whose cost is deliberately visible.

**Nodes are never deleted, only archived.** Incidents and evidence reference locations permanently;
deleting one would orphan history.

---

## 3 · Cameras

**Cameras → Add**, or **Discover** for ONVIF devices on the network.

Credentials are encrypted at rest with a key derived from `CREDENTIAL_ENCRYPTION_KEY`.

> ⚠️ **`CREDENTIAL_ENCRYPTION_KEY` cannot be rotated.** Changing it does not re-encrypt anything — it
> makes every stored camera credential permanently unreadable. Back it up
> ([BACKUP.md](BACKUP.md) §1) and treat it as the one irreplaceable value in the deployment.

### Reading camera health

Health is **measured, not assumed**. The probe runs staged and names the stage that failed:

```
dns → tcp → authentication → rtsp-negotiation → stream-open → first-frame → codec → resolution → fps
```

That distinction is the point. A failure at `dns` sends someone to a DNS server; a failure at `tcp`
sends them to a switch port; a failure at `authentication` means the password is wrong. "Camera
offline" would send them to all three.

`skipped` means the transport has no such stage. `not-executed` means the probe never got that far.
They are different, and the console shows which.

> ⚠️ **No camera in this platform has ever been validated against real hardware.** See
> [CCTV_READINESS.md](../review/p59/CCTV_READINESS.md) before a production installation.

---

## 4 · Rules

A rule turns events into incidents: which event types, a condition, a severity, and a scope.

**Rules are versioned and immutable.** Editing a rule creates a **new version**; the old one is
retained forever because every incident it raised references it. That is what lets the workspace
answer "why did this fire?" months later — including for rules that have since changed.

Consequences:

- If you edit a rule and incidents stop appearing, check you **enabled the version you edited**.
- The version an incident cites is the version that fired, not the current one. That is correct.

### Tuning

Most alerts are explainable. A rule producing noise is usually missing a schedule (a delivery
window, a letting, a cleaning shift) rather than being wrong. The demo dataset shows this pattern
deliberately — three of its resolutions are "added the schedule to the rule".

Candidates are de-duplicated within `RULES_CANDIDATE_DEDUP_WINDOW_MS` (default 60 s), so a burst of
events becomes one incident with a `matchedCount`. Measured: 3,000 events collapsed to 27 incidents.
That is the window working, not data loss.

---

## 5 · Branding

See [BRANDING.md](BRANDING.md). One JSON file, no rebuild.

---

## 6 · Retention and evidence

`EVIDENCE_DEFAULT_RETENTION_DAYS` (0 = indefinite) sets the default window applied when a
registration omits one.

**Never delete objects out from under the manifest.** Evidence is immutable and the custody chain
records what should exist; removing bytes with `mc rm` leaves a manifest pointing at nothing and a
custody log that can no longer be satisfied. Retire evidence through the platform.

`EVIDENCE_DOWNLOAD_TTL_SECONDS` (default 900) is how long a playback link lives. Shorter is safer: a
signed URL is a bearer token for one object until it expires. Verified to be genuinely enforced.

---

## 7 · Monitoring

| Endpoint   | Meaning                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `/health`  | The process is up. Use for restart decisions                                                            |
| `/ready`   | Dependencies reachable. **Point your uptime monitor here** — liveness cannot tell you a dependency died |
| `/metrics` | Prometheus, **internal network only**. Not exposed at the edge                                          |

Logs are structured JSON. Every request carries a `reqId` that propagates from the edge through the
gateway into the upstream service, and comes back to the user as `correlationId` on any error — so a
user-reported failure maps to exact log lines:

```sh
infra/docker/prod.sh logs --since 1h | grep <correlationId>
```

> Verify your health check can **fail**: stop NATS and confirm `/ready` returns 503 within a couple
> of seconds. A probe that always passes is not a probe.

---

## 8 · Routine operations

| Task             | Guide                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Backup / restore | [BACKUP.md](BACKUP.md) — **test the restore**, an untested backup is a hypothesis |
| Upgrade          | [UPGRADE.md](UPGRADE.md)                                                          |
| Roll back        | [ROLLBACK.md](ROLLBACK.md)                                                        |
| Diagnose         | [TROUBLESHOOTING.md](TROUBLESHOOTING.md)                                          |
| Demo data        | [DEMO_DATASET.md](../demo/DEMO_DATASET.md)                                        |

---

## 9 · What this deployment does not do

Tell your users, so they do not discover it during an incident.

- **No live streaming.** No browser plays RTSP; live view is not built.
- **No reports or exports.** The workspace says so on the panel.
- **Notifications are in-app and webhook only.** No email or SMS.
- **AI is advisory and none is configured.** Nothing analyses incidents.
- **Single host, no failover.** Restarting a service is a brief outage for that service.
- **Backups are per-collection consistent, not point-in-time.**
- **No rate limiting at the edge.** Put one in front for an internet-facing deployment.

Full list: [KNOWN_LIMITATIONS.md](../review/p59/KNOWN_LIMITATIONS.md).
