# ADR-0024 — A camera's operational state requires measured evidence

- **Status:** Accepted
- **Date:** 2026-08-02 · **Accepted:** 2026-08-02 (Architect direction, P-2: "Introduce an explicit lifecycle for managed cameras"; "Prevent invalid transitions"; "Evidence should remain the single source of truth across the platform")
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`CameraLifecycle`, `CameraTimeline`, `CameraOperationalHealth`, `StreamProbeResult`, `EvidenceClass` moved to `common/evidence.ts`); `services/camera` (`domain/lifecycle.ts`, `StreamProbe` port); `ai/inference/stream_probe.py` + `POST /streams/validate`. Extends [ADR-0023] (ONVIF placement); applies [CONSTRAINTS §18] to devices as [§25].

## Context

P-1 gave the platform a camera inventory. An inventory records what an operator _configured_; it says
nothing about whether any of it works. The console showed `health: unknown` for every camera ever
onboarded, because nothing in the system had ever opened a stream.

The Architect's P-1 review asked for an explicit lifecycle
(`discovered → validated → configured → connected → monitoring → degraded → offline → retired`),
camera health separated from AI session health, and a capability cache. Building those raises one
question that governs all of them: **on what basis may the platform say a camera is `connected`?**

The tempting answer is "when the configuration looks right", because that is answerable without a
network. It is also how a demo environment ends up reporting a fully connected estate that does not
physically exist — the exact failure AI-5e was built to make impossible for certification.

## Decision

**The lifecycle states that are claims about a physical device may only be entered from a
measurement of that physical device.**

1. `connected`, `monitoring`, `degraded` and `offline` are **measured states**. Entering one requires
   `evidence: 'measured'` _and_ an `EvidenceClass` of `hardware`. `discovered`, `validated` and
   `configured` are declared; `retired` is administrative.
2. The measurement comes from `POST /streams/validate` on the AI runtime, which opens the source,
   reads frames, and returns an **ordered check report** carrying the evidence class of the source it
   probed. A probe of a simulated or recorded source returns its full report and **moves nothing**.
3. **`EvidenceClass` is now a platform primitive** (`contracts/common/evidence.ts`), not a
   certification-local one. Certification, capability maturity, benchmarks and now device lifecycle
   all read the same enum, so one measurement means one thing everywhere.
4. **Legal transitions are an explicit map.** `retired → connected` does not exist; a decommissioned
   camera must be reinstated, and reinstatement returns it to `configured` — not to whatever measured
   state it held before, because six months in a cupboard invalidates any prior claim.
5. Stream validation joins ONVIF discovery as a **bounded exception** to "the runtime is
   perception-only": it creates no session, runs no capability, persists nothing, and returns a
   measurement. The camera service owns the lifecycle that measurement feeds.

## Alternatives considered

- **Derive `connected` from the existing `health.status`.** Cheapest, and rejected: before P-2 that
  field was only ever set by _configuration validation_, so deriving a measured state from it would
  manufacture evidence out of a declaration — and would silently backfill the entire existing
  inventory as connected.
- **Let any successful probe advance the lifecycle, regardless of source.** Simpler, and rejected for
  the reason the rule exists: the demo and CI environments run simulated sources by construction, so
  the first consequence would be a fully connected fictional estate, and the second would be nobody
  believing the field again.
- **Put the probe in the camera service** (a TypeScript RTSP client). Rejected on the same grounds as
  ADR-0023: it would be a second decode path that drifts from the one the runtime actually uses, so a
  camera could pass its test and then fail in analysis.
- **Model the lifecycle as a free-form status string.** Rejected: without an explicit transition map,
  `retired` degrades into a label that the next scheduled health check silently overwrites, and
  cameras somebody deliberately took out of service quietly re-enter the estate.
- **Keep one `health` field for both camera and session health.** Rejected per the Architect's
  direction: a camera can be perfectly healthy while a session on it has crashed, and a session can
  be running happily against a stream that has served the same frozen frame for an hour.

## Consequences

**Good**

- A `connected` camera in this platform means something specific and verifiable: something opened its
  stream and read frames off it. That is checkable in one place (`domain/lifecycle.ts`) rather than
  trusted across every caller.
- The installer experience improves for free: because the probe returns an ordered check list rather
  than a boolean, "connection failed" becomes "reachable, credentials rejected, stream not attempted".
- `retire` gives operators a way to decommission a camera without destroying the timeline an incident
  investigation may need months later.

**Costs, accepted knowingly**

- **A deployment without the runtime reachable can never advance a camera past `configured`.** This is
  the rule working, not a defect, but it means an air-gapped or runtime-less deployment shows an
  estate of configured-but-unproven cameras. `UnavailableStreamProbe` reports that as a deployment
  gap rather than as a fault with every camera.
- Per-camera credentials now transit one internal hop to the runtime, because RTSP authentication
  lives in the URI and there is no other way to pass it. Bounded: internal-key gated, assembled in
  exactly one function (`_apply_credentials`), never logged, never persisted, never echoed back, and
  test-guarded against appearing in any response.
- The runtime holds a second non-perception endpoint. Same bound as ADR-0023 — no session, no tenant
  data — and the same revisit trigger.

**The invariant this must preserve:** a probe that did not touch hardware changes no lifecycle state
and no `health.status`. Negative controls guard it at three levels: `stream_probe` (evidence class of
a flawless simulated probe), `domain/lifecycle.ts` (`stateForProbe` returns `null`), and the camera
service HTTP tests (a simulated probe leaves the camera `configured`).

## Amendment (P-2.1, 2026-08-02)

Accepted with P-2, and refined in the same review. Three changes to what is written above:

1. **`configured → monitoring` is legal.** The original map required passing through `connected`. The
   Architect's diagram is right: a running analysis session _is_ hardware evidence and can arrive
   without an operator-initiated probe, so requiring one first would be the state machine
   disbelieving its own runtime. The evidence gate is unchanged — `monitoring` still demands
   `hardware`.
2. **The probe names its own failure.** `StreamProbeFailureCode` is mutually exclusive and assigned
   by the runtime. The console renders it. Deriving the failure in the UI — which the first
   implementation did — put business logic in the visualization tier and would have drifted from the
   runtime the first time a stage was renamed.
3. **Stages are per-transport.** `skipped` joins `fail`/`warn`/`not-executed` so that "this transport
   has no such step" is distinguishable from "the probe never got there". Adding SRT or WebRTC is a
   new stage-set entry, not a lifecycle change.

## Revisit when

Ingestion starts reporting continuously (`source: 'ingestion'`). At that point `monitoring` should be
driven by the session supervisor rather than by an operator-initiated probe, and the transition map
gains an automated writer — which is worth an amendment, not a new decision.

## Amendment (P-2.2, 2026-08-02) — the operational evidence layer

Accepted with P-2.1 and extended in the same review. P-2.2 completes the operational evidence
subsystem and closes it; P-3 is product functionality, not further infrastructure.

1. **Probe reports are immutable evidence in their own store.** They were an overwritten field
   (`Camera.operational`); they are now append-only records in `camera_probes`, keyed by probe id and
   ordered by a per-camera `sequence`. The service has no update path against that collection.
   Retention is bounded per camera and the count of aged-out reports travels with every read, so a
   trimmed archive can never read as a complete one.
   - **`sequence`, not the timestamp, is the order.** Two probes land in the same millisecond
     routinely (a retry, a scheduled sweep), and sorting on time alone left the `previousProbeId`
     chain — the thing "when did this start failing?" walks — down to whatever the storage engine
     returned. Caught by a test, not by review.
2. **The transport table became a validation provider registry.** RTSP, HTTP, WebRTC, SRT, a recorded
   DVR export, an NVR playback file, a USB camera and an edge stream are all validated by the one
   staged pipeline; `register_provider(...)` declares what stages each has, and the engine never
   learns their names. A source type with its own probe would grow its own private definition of
   "connected", which is what the lifecycle's evidence gate exists to prevent.
   - Consequence worth naming: a **simulated** or **USB** source no longer runs the DNS and TCP
     stages at all. It never touched a network, and reporting those as measured was the probe
     describing work it had not done.
3. **Drift is classified, not merely listed.** A change carries a `direction`, an attributable
   `cause` and an `expected`/`unexpected` verdict. Codec, resolution, FPS, stream profiles and
   anything security-classed stay **unexpected even under a firmware upgrade** — nobody upgrades a
   camera intending to lose a stream profile, and "explained by the upgrade" is exactly how the one
   event worth investigating stops being investigated.
4. **Operational confidence is a device reliability score and never an AI confidence.** Computed from
   availability, failure frequency, probe success, capability stability, identity stability and
   recent recovery — never from a single probe, enforced by two floors rather than by a comment.
   `insufficient-evidence` is a band with **no score at all**.
5. **Compatibility is a register keyed by (dimension, value)**, covering firmware, runtime version,
   ONVIF version, codec, provider and edge profile. Older rows are never overwritten or removed, and
   `unsupported` is earned only by a **device-side** failure under hardware evidence — a DNS failure,
   a dead switch port or a wrong password says nothing about a vendor's firmware.
6. **Four write models, one read model.** The Architect's closing recommendation was a single
   `OperationalTimeline`. The decision taken is to **unify the reading and keep the writing
   separate**: the four records have different bounds (50 / 30 / 200 / 60), different keys (time,
   attribute, sequence, dimension-value) and different retention rules, and one physical log would
   force a single rule onto all four — either discarding probe evidence to keep the timeline small,
   or letting a camera that reconnects every thirty seconds bury a firmware change under ten thousand
   identical rows. `GET /cameras/:id/evidence` merges them on read, at the cost of one sort and with
   no second copy of any fact that could drift from the first.

**The invariant this adds:** stored evidence is never modified. A correction is a new record;
retention drops whole reports and says how many; and replay is a pure function over a stored record
with no camera, network or probe port in scope — it _cannot_ become a live measurement.

## Amendment (P-2.3, 2026-08-02) — chain of custody, and the Camera Foundation freeze

The closing slice. Two acceptance messages arrived for P-2.2 with overlapping recommendations; both
are folded in here.

1. **Every evidence item carries the same chain-of-custody envelope** — `evidenceId` ·
   `evidenceType` · `evidenceClass` · `source` · `tenantId` · `producer` · `producerVersion` ·
   `runtimeVersion` · `at` · `correlationId` · `sessionId`. Identical on every type by construction.
   `evidenceId` is **derived deterministically from the record it came from**, never generated at
   read time: the timeline is merged from four stores on every request, and a generated id would make
   every navigation link dangle on the next refresh.
2. **Causation navigates in both directions.** Backwards (`rootCauseEvidenceId`) answers _why did
   this happen_; forwards (`causedEvidenceIds`) answers _what did it break_, which is the question
   that decides whether an incident is over and is unanswerable from a backward chain alone.
   `previousEvidenceId`/`nextEvidenceId` link the previous item **of the same type** — "the probe
   before this one" is a question; "the row above" is a scroll position.
3. **Related capability changes are one logical event.** A firmware upgrade that moves the codec, the
   resolution, a profile and the frame rate is _one upgrade with four consequences_; four unrelated
   rows at the same instant read as four problems and lose the thing that explains them.
4. **Nothing derived is persisted.** Confidence, trends, decisions and metrics are computed from the
   archive on every read. A stored conclusion is a second copy that can drift from the evidence
   behind it — the precise failure this layer exists to prevent — and deriving means an explanation
   improves retroactively rather than leaving old rows phrased in the words of the version that wrote
   them. _(One pre-existing exception is named rather than quietly kept: `Camera.health` is a coarse
   rollup persisted since P1-4 for list views. It is recomputed from the latest measurement on every
   write and is never independently settable, but it is a stored summary. Deriving it is a P-3 change
   to a shared read path, not a P-2.3 one.)_
5. **Operational decisions are explainable and reconstructed, not recorded.** `explainDecisions()`
   answers _why was this camera degraded · why was this probe marked failed · why did confidence drop
   · why is this firmware unsupported_, each pointing at evidence ids that resolve in the timeline.
   **No code path consults a decision.** It introduces no runtime behaviour, which is what allows it
   inside the freeze.
6. **The unified timeline is the only investigation API.** Its consumers read the envelope rather
   than switching on type, and the source enum carries `diagnostics`, `recovery`, `certification` and
   `session` **ahead of their producers** — adding an enum value later is the one change to a
   published contract that is not purely additive for a strict parser.
7. **Fleet reads are bounded, indexed and honest about it.** Sorting and limiting moved into the
   query (`TenantRepository.findMany` gained `sort`/`limit`/`skip`); the fleet aggregate counts
   cameras rather than loading them and caps what it reads, and `FleetProbeMetrics.sampled` says
   plainly when the caps bit. A sampled aggregate presented as a census is worse than no aggregate.

**The Camera Foundation is frozen** (CONSTRAINTS §30): discovery · identity · lifecycle · capability
cache · probe pipeline · evidence archive · operational timeline · compatibility tracking. Future
work extends it through **additive contracts only**; a breaking change requires an ADR.

**A defect the tests found:** the P-2.2 de-duplication dropped _any_ timeline entry carrying an
archived `probeId`, which silently deleted the state changes those probes caused — the exact causal
link the timeline exists to show. Only the `probe-succeeded`/`probe-failed` echo should be dropped.
