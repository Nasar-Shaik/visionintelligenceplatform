# P-2 / P-2.1 — Camera Lifecycle, Identity & Operational Health

- **Status:** P-2 **ACCEPTED** (Architect 2026-08-02). P-2.1 implemented — awaiting review.
- **Date:** 2026-08-02
- **Authorization:** Architect, P-1 review ("Proceed with implementation while incorporating the
  recommendations above where appropriate") and the P-2 mid-flight review ("The current
  implementation direction is correct… continue keeping Camera Service responsible for device
  lifecycle while AI Runtime remains responsible only for stream validation and perception").
- **Governs:** [ADR-0024](../adr/ADR-0024-camera-lifecycle-evidence-gate.md),
  [CONSTRAINTS §25–26](../project/CONSTRAINTS.md).

## What this slice is about

P-1 gave the platform an inventory. An inventory records what somebody _configured_. P-2 answers a
different question — **does any of it actually work?** — and takes a position on what the platform is
entitled to claim when it answers.

The position: the states that describe a physical device may only be entered from a measurement of
that physical device. That is [CONSTRAINTS §18](../project/CONSTRAINTS.md) — the AI-5e rule that a
simulation never certifies hardware — applied to devices instead of capabilities.

## The lifecycle

```
discovered ─→ validated ─→ configured ─→ connected ─→ monitoring
                                │            │  ↑          │
                                ↓            ↓  │          ↓
                             degraded ←──────┴──┴──────→ offline
                                │                           │
                                └──────→ retired ←──────────┘
                                             │
                                    (reinstate) ↓
                                         configured
```

| State        | Evidence       | Means                                                         |
| ------------ | -------------- | ------------------------------------------------------------- |
| `discovered` | declared       | Known to exist. Nothing verified.                             |
| `validated`  | validated      | Configuration passes the deterministic checks.                |
| `configured` | declared       | Has a zone, a name, a capture profile. Nothing measured.      |
| `connected`  | **measured**   | A probe of the device read frames from it.                    |
| `monitoring` | **measured**   | An analysis session is consuming it.                          |
| `degraded`   | **measured**   | Reachable but not working — stalled, slow, credentials wrong. |
| `offline`    | **measured**   | Could not be reached.                                         |
| `retired`    | administrative | Decommissioned. Record and history kept.                      |

**Legal transitions are an explicit map** (`services/camera/src/domain/lifecycle.ts`). Two absences
are deliberate: nothing returns to `discovered` (a camera cannot become un-known), and `retired` goes
only to `configured` — a decommissioned camera must be **reinstated**, and reinstatement does not
restore whatever measured state it held before, because six months in a cupboard invalidates any
prior claim that it was connected.

## Architect recommendations → where they landed

| # (round)  | Recommendation                    | Where                                                                      |
| ---------- | --------------------------------- | -------------------------------------------------------------------------- |
| P-1 rec 1  | Camera lifecycle                  | `CameraLifecycle` + `domain/lifecycle.ts` transition map                   |
| P-1 rec 2  | Camera health ≠ AI session health | `CameraOperationalHealth` with `source` + `evidenceClass`                  |
| P-1 rec 3  | Capability cache                  | `CapabilityCache` + `domain/capability-cache.ts` decision function         |
| P-1 rec 4  | Validate before onboarding        | `create()` refuses an invalid configuration; live proof is `probe`         |
| P-1 rec 7  | Stable camera identity            | `CameraDeviceIdentity`; ONVIF endpoint UUID now captured and matched first |
| P-1 rec 8  | Future ONVIF features             | Additive `CameraTimelineEventKind` + capability cache versioning           |
| P-2 rec 1  | Three identities                  | Documented as a table on `CameraDeviceIdentity`; address kept out of it    |
| P-2 rec 2  | Capability cache versioning       | `cacheVersion` · `firmware` · `discoveredAt` · `lastRefreshedAt` · reason  |
| P-2 rec 3  | Full stream validation report     | `StreamProbeResult.checks` (9 ordered checks) + jitter + warnings          |
| P-2 rec 4  | Operational timeline              | `CameraTimeline` — 8 event kinds, bounded at 50                            |
| P-2 rec 5  | Documented lifecycle rules        | `LEGAL_TRANSITIONS` + this table + ADR-0024                                |
| P-2 rec 6  | Health history                    | `CameraHealthSummary` + `domain/health-history.ts`                         |
| P-2 rec 7  | Informative "Test Connection"     | `ProbeResultPanel` — ✓/✗/– per check, first failure leads                  |
| P-2 rec 10 | Evidence consistency              | `EvidenceClass` lifted to `contracts/common/evidence.ts`                   |

**Deferred, deliberately:** P-1 rec 5 (camera groups), rec 6 (installer diagnostics report) and rec 9
(broader installer UX) are one coherent slice about installer productivity and belong together — see
"What P-2 does not do" below. P-1 rec 8 / P-2 rec 8 (PTZ presets, snapshots, SD-card status, firmware
upgrades, event subscriptions) are explicitly _not implemented_; what P-2 owed them is room, and they
are additive: each is a new `CameraTimelineEventKind` value and a capability-cache version bump, with
no shape change anywhere else.

## The measurement

`POST /streams/validate` (AI runtime) opens the source, reads frames, and returns an **ordered check
report**. The order is the contract, because each check depends on the one before it:

```
reachability → authentication → stream-open → frames-received
             → codec → resolution → fps → latency → jitter
```

A failure leaves everything after it `not-executed`, never `fail`. That single distinction is the
difference between an installer reading "connection failed" and re-running cable, and reading

```
✓ Device reachable        38 ms
✗ Authentication          — 401 from the device
– RTSP opened
– Stream started
```

and fixing a password in a minute.

**Every report carries its `evidenceClass`.** A probe of a simulated source returns `simulated`; the
camera service shows the full report and **advances nothing**. Three negative controls guard this:

- `ai/inference/tests/test_stream_probe.py::test_a_flawless_simulated_probe_is_not_hardware_evidence`
- `services/camera/test/lifecycle.test.ts` — "a flawless simulated probe does not connect a camera"
- `services/camera/test/http.test.ts` — the same, end to end through the HTTP surface

## Device identity — the DHCP case

P-1 matched discovered devices to cameras by stream URL alone. That is correct until the first lease
expires: the same physical camera then answers from a new address, fails to match, and is offered to
the installer as a new device — who onboards it, and the estate now holds one camera twice, one of
which will never connect again.

P-2 captures the device's ONVIF endpoint UUID (`urn:uuid:…`), which the WS-Discovery parser was
already reading and discarding, stores it at onboarding, and matches on it **first**. A device
recognised by identity at a different address is reported as `addressChanged`, and the console offers
to update the address rather than create a duplicate.

Identity is `onvifUuid` > `serialNumber` > `macAddress` > `hardwareId`, and `null` when the device
offered none — a device that will not identify itself falls back to URL matching rather than being
assigned a fabricated identity.

## What P-2 does not do

- **Camera groups, the installer diagnostics report, and broader onboarding UX** (P-1 recs 5, 6, 9) —
  deferred to P-3 as one slice about installer productivity.
- **Site awareness surfaced in the product.** The hierarchy the Architect described already exists in
  contracts from P1-1: `OrgNodeType` is `org → region → country → branch → site → building → floor →
zone`, with a materialized `path` for subtree queries, and `Camera.zoneId` points at any node in it.
  What is missing is product surface, not model: the console still hardcodes `zoneId = 'on_default'`.
  That is P-3 work and is named in the code where the assumption lives.
- **Continuous health.** `monitoring` is reachable but nothing writes it yet; it needs the session
  supervisor to report, which is the ADR-0024 revisit trigger.
- **Packet loss** in the probe report — named by the Architect as future, and deliberately absent
  rather than approximated.

## P-2.1 — diagnostic depth

P-2 could tell an operator a camera was broken. P-2.1 tells them **what changed, when, and which
step failed** — the difference between a status light and a diagnosis.

### The probe became a staged pipeline

```
dns → tcp → authentication → rtsp-negotiation → stream-open → first-frame
    → frames-received → codec → resolution → fps → stream-profile → latency → jitter
```

Each stage is **timed individually** (rec 1). A total of 346 ms cannot say which step is slow;
`DNS 12 ms · TCP 4 ms · auth 38 ms · negotiation 110 ms · first frame 182 ms` can.

Each failure produces **exactly one typed code** (rec 8), and they are mutually exclusive:
`dns-failure` · `tcp-failure` · `authentication-failure` · `rtsp-negotiation-failure` ·
`codec-unsupported` · `timeout` · `no-first-frame` · `stream-interrupted` · `configuration-invalid`.
A test asserts that exactly one stage ever fails, so exclusivity is a property of the code and not
of the enum.

**Splitting DNS from TCP is the highest-value change in the slice.** They send an installer to
completely different places — a DNS server versus a switch port — and P-2 conflated both into
"reachability".

Stages are selected per transport (rec 9), so an HTTP source reports `rtsp-negotiation: skipped` and
a file source skips every network stage. `skipped` is a third status, distinct from `fail` and from
`not-executed`: the transport has no such step, rather than the probe having given up on it. Adding
SRT or WebRTC is a new entry in `_STAGES_FOR_SCHEME` — not a change to the camera lifecycle.

### What the console is now forbidden from doing

P-2 derived the failure headline in the console by scanning for the first failing check. That was
**inference in the visualization tier** (rec 10), and it would have drifted from the runtime the
first time a stage was renamed. The runtime now names the failure; the console maps the code to
words and a remedy. It renders; it does not decide.

### Everything else that landed

| Rec | Recommendation           | Where                                                                              |
| --- | ------------------------ | ---------------------------------------------------------------------------------- |
| 1   | Per-stage probe duration | `ProbeCheck.durationMs` + `totalMs`                                                |
| 2   | Capability diff severity | `CapabilityChangeSeverity` (`minor`/`major`/`security`) + `capability-diff.ts`     |
| 3   | Identity confidence      | `IdentityConfidence`; `high` = UUID/serial, `medium` = MAC, `low` = address        |
| 4   | Probe evidence           | `probeVersion` · `runtimeVersion` · `configVersion` · `operator` · `correlationId` |
| 5   | Trend windows            | `HealthTrendWindow` (`hour`/`day`/`week`/`month`), named not arbitrary             |
| 6   | Cache freshness          | `fresh`/`aging`/`expired`/`unknown`, computed on read, never stored stale          |
| 7   | Timeline reason codes    | `TimelineReasonCode` — required, so a generic message cannot be written            |
| 8   | Failure taxonomy         | `StreamProbeFailureCode`, mutually exclusive, test-guarded                         |
| 9   | Protocol neutrality      | Per-scheme stage selection + `skipped`                                             |
| 10  | Ownership boundary       | Console renders the runtime's code; no inference in the UI                         |

Two details worth calling out because they are easy to get wrong:

- **Identity is appended to, never overwritten** (rec 1 of the P-2 round). "When did this camera
  become a different device?" is unanswerable the moment a serial number is overwritten in place.
- **Profiles are diffed by name, not position.** Devices reorder them between firmware versions, and
  a positional diff would report every profile as changed on every upgrade — noise that would train
  operators to ignore the feature.

### One correction to the transition map

The rec 7 diagram shows `Configured → Monitoring`. P-2's map required passing through `connected`
first. The diagram is right: a running analysis session **is** hardware evidence, and it can arrive
without anyone having pressed "test connection". Requiring a manual probe first would be the state
machine disbelieving its own runtime. `configured → monitoring` is now legal.

## P-2.2 — Operational Evidence (the final hardening slice before P-3)

Approved mid-flight with ten refinements. **A probe stops being the latest reading and becomes a
piece of evidence.**

| Rec | Recommendation               | Where it landed                                                           |
| --- | ---------------------------- | ------------------------------------------------------------------------- |
| 1   | Validation Provider Registry | `register_provider(...)` in `stream_probe.py`; `ValidationProvider`       |
| 2   | Immutable probe archive      | `camera_probes` collection; `domain/probe-archive.ts`; no update path     |
| 3   | Drift classification         | `classifyDrift` — direction · cause · expected/unexpected                 |
| 4   | Confidence from history      | `domain/confidence.ts`; two floors; never from a single probe             |
| 5   | Compatibility registry       | `CompatibilityRecord` keyed by (dimension, value); rows never overwritten |
| 6   | Probe replay                 | `replayProbe()` — pure, `GET`, no camera in scope                         |
| 7   | Fleet metrics                | `GET /cameras/metrics`; the same computation as the per-camera view       |
| 8   | Evidence timeline            | `GET /cameras/:id/evidence` — four write models, one read model           |
| 9   | Architecture freeze          | Subsystem declared complete; P-3 is product, not infrastructure           |
| 10  | Ownership boundaries         | Provider owns validation · service owns history · console renders         |

### The recommendation that needed a decision

The Architect recommended a single `OperationalTimeline` in place of four histories and left the call
to us. **Unify the reading; keep the writing separate.** The four records have different bounds
(50 · 30 · 200 · 60), different keys (time · attribute · sequence · dimension-value) and different
retention rules. One physical log forces one rule onto all four: either probe evidence gets discarded
to keep the timeline small, or a camera reconnecting every thirty seconds buries a firmware change
under ten thousand identical rows. Merging on read costs one sort and duplicates no fact.

### Two defects the tests found, not the review

- **A timestamp is not a total order.** Two probes in the same millisecond left the `previousProbeId`
  chain — the thing "when did this start failing?" walks — down to whatever the storage engine
  returned. Fixed with a per-camera `sequence`.
- **Confidence scored a single probe.** A probe produces both a report _and_ the transition it
  causes, so counting "observations" let one probe look like two independent facts. Fixed by counting
  only _measured_ state changes and requiring two hardware probes.

### A behaviour change worth naming

A **simulated** or **USB** source no longer runs the DNS and TCP stages: under the provider registry
it has no network endpoint, so they are `skipped`. Previously the probe resolved and dialled whatever
host the URI happened to carry — a report of work it had not done, and the root cause of P-2.1's
113-second test suite.

## P-2.3 — Chain of Custody (closing the Camera Foundation)

Two overlapping acceptance messages arrived for P-2.2; both are folded in here. The foundation could
already prove what it measured. It could not yet **explain itself**.

| Rec | Recommendation               | Where it landed                                                         |
| --- | ---------------------------- | ----------------------------------------------------------------------- |
| 1   | Evidence provenance envelope | Identical on every type; `evidenceId` derived, never generated          |
| 2   | Bidirectional causation      | `rootCauseEvidenceId` + `causedEvidenceIds`                             |
| 3   | Capability drift changesets  | `CapabilityChangeSet` — one upgrade, four consequences                  |
| 4   | Derive, never persist        | Confidence · trends · decisions · metrics all computed on read          |
| 5   | Fleet readiness              | Sort/limit pushed into the query; `sampled` disclosed                   |
| 6   | Single investigation API     | Consumers read the envelope; future sources declared ahead of producers |
| 7   | Freeze the Camera Foundation | CONSTRAINTS §30–32                                                      |
| 8   | Operational decision records | `explainDecisions()` — reconstructions, consulted by nothing            |

### Why decisions are reconstructed rather than recorded

Rec 8 asks for explainability; rec 4 forbids persisting conclusions. Both are satisfied by deriving:
every input is already in the archive, no code path consults a decision, and an explanation improves
retroactively instead of being frozen in the words of whatever version wrote it. That is also what
keeps the feature inside the freeze — it adds no runtime behaviour at all.

### A pre-existing violation, named rather than quietly kept

Rule 4 says never persist a summary. `Camera.health` is one — a coarse rollup stored since P1-4 for
list views. It is recomputed from the latest measurement on every write and is never independently
settable, but it _is_ stored. Deriving it touches a read path shared with other services, so it is a
P-3 change and is recorded here rather than left for someone to find.

### A defect the tests found

P-2.2's de-duplication dropped **any** timeline entry carrying an archived `probeId` — which silently
deleted the state changes those probes caused, the exact causal link the timeline exists to show.
Only the `probe-succeeded`/`probe-failed` echo should be dropped.

## Gates

P-2: contracts **+10 → 137 schemas**; Contracts 264 · Python 816 · camera 112 · console 67.

P-2.1: **+3 → 140 generated schemas. Contracts 277 · Python 845 · camera 129 · console 73.** Typecheck 28 · lint 20 · build 19 ·
import-graph 0 violations · format clean. No new service, no new runtime layer, the five frozen
perception contracts untouched.

P-2.2: **+9 → 149 generated schemas. Contracts 277 · Python 850 · camera 156 · console 76.** No new
service, no new runtime layer, the five frozen perception contracts untouched. The operational
evidence subsystem is complete; P-3 begins product functionality.

P-2.3: **+5 → 154 generated schemas. Contracts 277 · Python 850 · camera 171 · console 79.** No new
service, no new runtime layer, the five frozen perception contracts untouched. **The Camera
Foundation is architecturally complete and frozen** (CONSTRAINTS §30–32); P-3 begins the operational
hierarchy.

---

## 🔒 Camera Foundation v1.0 — FROZEN (2026-08-02)

The P-2 series is closed. The foundation is a **stable platform dependency**, not an area for
continued feature development.

- [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md) — the freeze record: what is
  frozen, what may change without ceremony, what needs an ADR, and the intended (unimplemented)
  direction toward a universal evidence envelope, a platform-wide timeline and an asset model.
- [FOUNDATION_PRINCIPLES](../project/FOUNDATION_PRINCIPLES.md) — mandatory reading before modifying
  any foundation.
- [PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md) — permanent component ownership.
- [CONSTRAINTS §25–34](../project/CONSTRAINTS.md) · [ED-0051](../project/ENGINEERING_DECISION_LOG.md).

**P-3 consumes this foundation. P-3 does not redesign it.**
