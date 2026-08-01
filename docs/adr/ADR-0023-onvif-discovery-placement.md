# ADR-0023 — ONVIF discovery lives in the AI runtime; the camera service owns onboarding

- **Status:** Accepted
- **Date:** 2026-08-01 · **Accepted:** 2026-08-01 (Architect decision, P-1 planning — "Camera service calls the AI runtime")
- **Deciders:** Principal Architect + development
- **Touches:** `ai/inference/onvif.py` + `POST /discovery/onvif`; `services/camera` (`DiscoveryProvider` port, `POST /cameras/discover`); `@vip/contracts` (`DiscoveredCamera`, `DiscoverCamerasResult`); `CAMERA_DISCOVERY_URL`. Relates to [ADR-0004] (edge-first placement), [CONSTRAINTS §24].

## Context

AI-5e built a complete, tested ONVIF stack — WS-Discovery multicast probe plus SOAP capability
negotiation — in `ai/inference/onvif.py`, because the **certification harness** needed to enumerate a
device's profiles before it could certify one.

P-1 (Camera & Device Management) needs the same capability for a completely different reason:
**onboarding**. An installer scans the network and adds what answers.

That creates a placement problem the platform must not leave ambiguous. Discovering what cameras exist
on a network is a **device-management** concern, and a standing guardrail says the AI runtime stays
**perception-only**. But `services/camera` is TypeScript and cannot import a Python module, so the
capability is either called, duplicated, or moved.

## Decision

**The camera service owns the onboarding workflow and calls discovery as a read-only capability.**

1. The AI runtime exposes `POST /discovery/onvif` — internal-key gated, creating no session, decoding
   no frame, reading no tenant data. It returns **configuration**, and configuration is data.
2. `services/camera` defines a **`DiscoveryProvider` port**. The service, its tests and every consumer
   see the port, never an HTTP client.
3. `HttpDiscoveryProvider` implements it against the runtime; `UnavailableDiscoveryProvider` is the
   default when `CAMERA_DISCOVERY_URL` is unset.
4. **Reconciliation belongs to the camera service**, not the runtime: matching discovered devices
   against a tenant's existing cameras is tenant-scoped domain logic, and the runtime must not touch it.
5. This is recorded as a **deliberate, bounded exception** to "the runtime is perception-only" — not
   as the runtime quietly growing a second job.

## Alternatives considered

- **Reimplement WS-Discovery + SOAP in TypeScript inside `services/camera`.** The cleanest boundary,
  and rejected: it gives the platform **two ONVIF stacks that will drift**, and the drift surfaces as a
  camera that onboards with one set of capabilities and streams with another. The Python one is the
  tested one (22 unit tests against realistic device fixtures, including a device that refuses
  `GetCapabilities`, one that returns a credentialed stream URI, and one that answers with garbage).
- **Extract ONVIF into a shared component the camera service owns**, and have the certification
  harness consume declared capabilities instead of discovering them. The purest separation, and
  rejected for now on timing: it is the largest change of the three and would rewrite AI-5e code the
  day after the runtime was formally closed. It stays the right long-term move if a second non-runtime
  consumer appears.
- **Put onboarding in the AI runtime too**, since discovery is already there. Rejected outright:
  onboarding is tenant-scoped, persists records, vaults credentials and publishes domain events — every
  one of which the runtime deliberately does not do.

## Consequences

**Good**

- One ONVIF implementation, already tested. No protocol code is duplicated.
- The camera service is testable with no network and no runtime: tests inject a stub `DiscoveryProvider`.
- A deployment without the runtime reachable still onboards cameras from stream URLs, and says so
  explicitly rather than reporting an empty network.

**Costs, accepted knowingly**

- Camera onboarding gains a **runtime dependency** for one optional feature. Bounded by the port and by
  `UnavailableDiscoveryProvider`: unconfigured is a supported deployment, not a broken one.
- The AI runtime holds one endpoint that is not perception. It creates no session, touches no tenant
  data and is documented at the call site as an exception, so it cannot be mistaken for precedent.

**The invariant this must preserve:** discovery **never** changes a camera's certification status and
never persists anything. A successful `GetDeviceInformation` is not a passing certification run, and
the compatibility registry keeps every device at `pending-validation` regardless of what discovery
learns (see [CONSTRAINTS §18](../project/CONSTRAINTS.md)).

## Revisit when

A second non-runtime consumer needs ONVIF (an edge agent doing local discovery, or a cloud tenant
service). At that point extraction into a shared component becomes worth its cost, and this ADR is
superseded rather than amended.
