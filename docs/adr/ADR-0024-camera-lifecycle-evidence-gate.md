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

## Revisit when

Ingestion starts reporting continuously (`source: 'ingestion'`). At that point `monitoring` should be
driven by the session supervisor rather than by an operator-initiated probe, and the transition map
gains an automated writer — which is worth an amendment, not a new decision.
