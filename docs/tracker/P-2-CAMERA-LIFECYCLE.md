# P-2 — Camera Lifecycle, Identity & Operational Health

- **Status:** Implemented — awaiting Architect review
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

## Gates

Contracts **+10 → 137 schemas**. **Contracts 264 · Python 816 · camera service 112 · console 67.**
Typecheck · lint · build · import-graph 0 violations · format clean. No new service, no new runtime
layer, the five frozen perception contracts untouched.
