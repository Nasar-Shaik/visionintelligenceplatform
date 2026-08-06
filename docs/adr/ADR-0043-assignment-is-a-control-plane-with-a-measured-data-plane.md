# ADR-0043 — Camera Processing Assignment is a control plane with a measured data plane

**Status:** Accepted · **Date:** 2026-08-06 · **Phase:** P-8 Phase 6
**Supersedes:** nothing · **Amends:** nothing. Additive to ADR-0039, ADR-0040, ADR-0041, ADR-0042.

## Context

Every camera on the platform records. Only some should consume AI compute — that is the product's
central commercial proposition for the small and medium retail market it is sold into: _record
everything, analyse the till and the high-value display_.

Before this milestone the platform had no way to express that. Perception was a single deployment
variable (`INFERENCE_URL`): set it and **every** camera was analysed, unset it and none were. There
was one implicit runtime, no capacity, no failover, no record of who decided what, and no way for an
operator to answer "why is this camera not being analysed?"

The subsystem also had to satisfy several constraints that pull against each other:

- **Recording must never be affected by an AI decision.** This is the platform's oldest invariant.
- **No new services** — a standing architectural guardrail.
- **The AI runtime is frozen** (v1.0, closed 2026-08-01). Nothing may be added to it.
- **Media is the only service permitted to talk to the runtime** — a deployment property P-8 Phase 1
  asserted and the verification still checks.

## Decision

### 1 · Two halves, and they cannot reach each other's failure modes

A **control plane** in `services/camera` decides _whether_ a camera consumes AI, _which profile_ it
runs and _which runtime_ hosts it. An **enforcement point** in `services/media` obeys the plan.

The enforcement point sits at the **perception seam** — `FrameSink.push()` — which is downstream of
the decoder and downstream of the segment writer. Recording happens in `StreamSupervisor.#record`,
reached from the decoder's `onSegment` callback, and nothing on that path reads anything the
assignment layer produces.

> ⚠️ "Disabling AI never interrupts recording" is therefore a **consequence of the two paths not
> touching**, not a behaviour that has to be preserved by care. The assignment record carries no
> recording field, the plan carries no recording field, and there is no call from the control plane
> into the stream supervisor.

### 2 · The control plane lives inside the camera service

Not a twelfth service. The guardrail says no new services, and it also happens to be the right home:
media already holds an internal client to the camera service (it resolves camera credentials through
it), so the plan travels a seam that is already deployed, authenticated and tested.

The module is self-contained — `domain/assignment.ts`, `domain/placement.ts`,
`domain/processing-profile.ts`, `domain/runtime-registry.ts`, `domain/assignment-limits.ts`,
`application/assignment-service.ts`, `application/capability-matrix.ts`. Nothing in
`camera-service.ts` knows it exists.

**One exception to tenant scoping:** the runtime registry carries no `tenantId`. A runtime is a
container with a GPU that several tenants' cameras share, exactly as one media process records
several tenants' streams. Scoping it per tenant would mean one registration per tenant per container
and a capacity number counted N times. Reads are permissioned; the _cameras_ on a runtime are always
filtered to the caller's tenant.

### 3 · A formal state machine, exported as data

Nine states — `unassigned · assigned · starting · running · paused · stopping · stopped · error ·
recovering` — and twelve actions, with the transition table exported from `@vip/contracts` as
`ASSIGNMENT_TRANSITIONS`. A test asserts **every cell**, all 108 of them, including the illegal ones.

> ⚠️ Exported as **data** rather than buried in a `switch`, so this ADR, the tests and the runtime
> read one table. A state machine documented in prose and implemented in a switch is two state
> machines.

Three entries carry their own reasons:

- **`remove` is legal from every state.** Bulk removal across fifty cameras where three are already
  unassigned must not fail on those three.
- **`assign` is a self-transition on `running`.** That is what makes hot assignment possible: changing
  a running camera's profile changes what it analyses without stopping it.
- **`error --observe-running--> running` is legal.** A runtime that comes back on its own is a thing
  that happens, and refusing to believe an observation would leave a healthy camera stuck.

### 4 · Only two states require evidence, and the shortlist is the honest one

`running` and `stopped` are the two claims that would be **lies** if the control plane set them
itself: it only ever knows that it published a plan. No action outside the `observe-*` family reaches
them, and a test asserts that property of the table rather than trusting this paragraph.

> ⚠️ The first draft of this list held five states. A test that walked every cell cut it to two:
> `starting` is reached by `start`, `resume` and `restart`, which are operator actions. The wider
> claim read better and was false — exactly the kind of statement that survives review because nobody
> re-derives it. `starting` means _we have asked_; `stopping` means _we have asked to stop_; `error`
> is usually a placement failure the control plane observed directly.

### 5 · Health is measured by media and reported inward

An operator declares that a runtime exists at a URL with a capacity. **Nothing about its health is
taken on that authority.** Health, latency and advertised capabilities arrive from `services/media`.

This is not layering pedantry. Media is the process that actually posts frames, so a runtime media
can reach is a runtime that can do work, and a runtime only the control plane can reach is a runtime
that cannot. **Polling from the control plane would have measured a path no frame ever takes** — and
would have reported a healthy runtime during exactly the outage that matters. It also keeps the
frozen runtime frozen: nothing was added to it, and it is still the only service media talks to.

A registered runtime nobody has observed is `unknown`, never `offline`. An expired observation
returns to `unknown` rather than decaying to `offline`, because "media stopped reporting" and "the
runtime is down" are different failures with different fixes.

### 6 · The plan is polled, and absence from it means release

Media polls a versioned plan every five seconds. A missed event leaves an enforcement point silently
wrong until somebody restarts it; polling a versioned document converges whatever happened, and it
makes "assignments survive a restart" true by construction rather than by replay.

**A camera absent from the plan is a camera to release.** There is no `stop` entry, so a lost plan
entry and a deliberate stop behave identically — the failure mode of this system is therefore _"AI
stopped"_, never _"AI kept running on a camera nobody authorised"_.

When the control plane is unreachable, the enforcement point degrades to **the last known plan**:
still analysing exactly the cameras an operator last authorised. Not "everything", not "nothing".

### 7 · `sessionEpoch` closes the P-8 Phase 5 defect

A camera switched off and back on begins its frame sequence again at 1. A publisher still holding
`lastSeq` from the previous session treats every new frame as stale and drops it, for ever, silently:
Phase 5 measured a re-enabled camera publishing 0 events and dropping 32.

Every assignment carries a monotonic `sessionEpoch`. It is bumped by `start`/`restart` **and whenever
the runtime actually changes** — derived from the runtime id rather than from the action, because the
tracks live inside the runtime process and moving container loses them whether or not anybody asked
for a restart. The enforcement point releases its per-camera state whenever the epoch it sees differs
from the one it applied.

`pause` and `resume` deliberately do **not** bump it. That is the entire distinction between pause
and stop; without it, pause would be an expensive synonym.

### 8 · Placement is capability-aware and behind an interface

`PlacementStrategy` takes the world (runtimes, load, required capability) and returns a runtime or a
refusal. `LeastLoadedPlacement` is the one implementation; a future scheduler replaces it without
touching `CameraAssignment`, the plan, the routes or the enforcement point. **No auto-balancing is
implemented**, by explicit architectural decision.

Placement matches **capability**, not just capacity: the deployed runtime advertises exactly one
capability, so four of the six seeded profiles cannot run anywhere and say so on every read. A camera
bound to one is refused rather than accepted and left silently producing nothing.

The capacity endpoint's "suggested placement" calls the **same function**. Two implementations of one
decision diverge the first time either changes, and nobody notices because both keep returning
something plausible.

### 9 · Bulk operations are validate-all-then-apply, and `partial` says so

The deployment runs a **standalone** MongoDB with no multi-document transactions. The guarantee is
the one that is achievable and useful: **every item is validated and its new document computed before
any document is written**, so the overwhelmingly common failure — a missing camera, an unknown
profile, a full runtime, an illegal transition — is atomic with nothing written.

A fault during the write phase can still leave some items applied. That is reported (`partial: true`,
per-item outcomes, HTTP 207), never hidden. Claiming an atomicity we cannot deliver would be worse
than naming the gap. Recorded as a known limitation with the exact remedy.

## Consequences

**Good.** Selectivity is now expressible, auditable and reversible. Recording independence is
structural. A camera's AI state is explainable from an immutable trail. Runtime failure moves cameras
without operator action, and a stranded camera recovers on its own. The frozen runtime was not
touched.

**Costs, accepted.**

- **A five-second convergence window.** An operator's change takes up to two poll cycles to be
  confirmed on screen. Faster polling costs the control plane; slower makes "did it stop?"
  unanswerable for longer than an operator will wait.
- **Runtime occupancy is a cross-tenant number.** A tenant can see that a shared runtime is 14/16
  full. Counts only — never another tenant's camera or tenant id — and the alternative is an operator
  who cannot understand why placement was refused.
- **The control plane's view of what is running is always one report old.** That is the price of
  refusing to invent it, and `observed.stale` makes the expiry visible rather than silent.

## Alternatives rejected

- **A twelfth service.** Refused by the standing guardrail, and it would have owned something that is
  a property of cameras while adding a container, a gateway prefix and a readiness probe.
- **Health polled by the control plane.** Would have measured a path no frame takes, and would have
  made the runtime an upstream of a second service.
- **A boolean on the camera record.** Cannot express a runtime, a capacity, a failover, or a reason;
  and a decision with no audit trail cannot answer "why did this stop on Tuesday".
- **`aiEnabled` stored beside the state.** A second source of truth for one fact. It is derived.
- **Push (events) instead of poll.** Faster, and still needs reconciliation — a missed message leaves
  the enforcement point wrong with nothing to correct it.
- **Auto-balancing cameras between runtimes.** Explicitly deferred by the Architect. The seam exists;
  the behaviour does not, and a permission for it deliberately does not exist either.
- **Storing Building/Floor/Zone on the camera** for bulk targeting. Already modelled with ancestry by
  the Location Hierarchy; a copy would give the platform two answers to "where is this camera".

## Verification

- `docs/review/p8/assignment.mjs` — the chain end to end **and its negative half**: three cameras
  record, one is assigned, the other two analyse zero frames.
- `docs/review/p8/assignment-runtime.mjs` — health, capacity refusal, failover, persistence across a
  restart of both halves.
- `docs/review/p8/assignment-ui.mjs` — the six pages, every figure traced to its payload.
- `docs/review/p8/assignment-mutations.mjs` — eight breaks, each required to go red at the check that
  names it.
- `docs/review/p8/assignment-benchmark.mjs` — 1 → 16 cameras.
- `services/camera/test/assignment.test.ts`, `services/media/test/assignment-gate.test.ts`.
