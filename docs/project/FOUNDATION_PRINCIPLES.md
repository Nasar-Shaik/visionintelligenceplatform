# Foundation Principles

**Mandatory reading before modifying any frozen foundation.**

Status: permanent · Established G-1 → P-2.3 · Recorded 2026-08-02 at the Camera Foundation v1.0
freeze.

---

These ten principles are what the platform learned building its foundations. They are not style
preferences. Each one exists because the alternative failed, or would have failed silently in a way
nobody would have caught until a customer did.

Where a principle is enforceable in code, it is enforced in code, and the enforcement is named. A
principle whose only enforcement is "reviewers will remember" is a principle with a half-life.

---

## 1. Persist measurements

Store what was **observed**: probe reports, identity changes, capability reads, frames decoded,
firmware strings, timings. These are facts about the world at a moment, and they do not become wrong
when the platform's opinions change.

_Enforced:_ `CONSTRAINTS §27` · the probe archive has no update path.

## 2. Derive conclusions

Never store confidence, trends, health scores, decision records or summaries. Compute them from the
evidence on every read.

A stored conclusion is a second copy of something that can drift from what it was drawn from, and it
freezes an explanation in the words of whatever version wrote it. Deriving means the number and the
evidence behind it can never disagree — and that an explanation **improves retroactively** when the
explanation improves.

_Enforced:_ `CONSTRAINTS §30` · `domain/confidence.ts`, `domain/decisions.ts`,
`domain/probe-metrics.ts` are pure functions with no writer; an HTTP test asserts no derived field is
ever persisted on a camera.

## 3. Evidence before decisions

A claim is only as strong as the evidence class behind it. `simulated → recorded-footage → hardware`
is one vocabulary platform-wide, and the strong claims are structurally unreachable below `hardware`:
a device is never `connected` from a simulation, a firmware is never `supported` from one, a
capability is never `certified` from one.

**The negative controls exist so this cannot be quietly removed.** If a change makes
`test_a_flawless_simulated_run_is_still_not_certified` fail, the change is wrong, not the test.

_Enforced:_ `CONSTRAINTS §18`, `§25` · `isHardwareEvidence()` gates every measured lifecycle state ·
negative controls in `stream_probe`, `certification`, `lifecycle.test.ts` and the camera HTTP tests.

## 4. Deterministic runtime

Clocks, sleeps, executors, resolvers, connectors and source builders are injected. Unit tests open no
socket, resolve no name, touch no camera and never sleep.

This is not test hygiene; it is the only way a measurement is reproducible. The suite that once took
**113 seconds** did so because new stages were dialling a real hostname — every assertion still
passed, and the clock was the only signal that the tests had stopped being tests.

_Enforced:_ `CONSTRAINTS §14` · injected seams throughout `ai/inference` and `services/*` · suite
runtime is itself a signal.

## 5. Contract-first development

The contract is written before the implementation, in `@vip/contracts`, and generates the
language-neutral JSON Schema every consumer reads. TypeScript types are inferred from it, never
hand-maintained beside it.

A shape that exists in two places will eventually mean two things.

_Enforced:_ `pnpm --filter @vip/contracts codegen` · schema count is a gate on every slice ·
`check:imports`.

## 6. Architecture freeze

A frozen foundation is a **stable dependency**, not an area for continued development. Frozen today:
Platform Core · AI Runtime · Operational Runtime · Camera Foundation · Evidence Foundation.

Freezing is what lets everything above it be built confidently. A foundation that keeps moving is one
nobody can stand on.

_Enforced:_ `CONSTRAINTS §24`, `§31` · ADR required for any breaking change · review.

## 7. Additive evolution only

Foundations grow by **addition**: a new field, a new optional value, a new enum member, a new
provider registration, a new evidence type. Never by changing what an existing field means.

Note the asymmetry that catches people out: **adding an enum value is not purely additive for a
strict parser.** That is why `diagnostics`, `recovery`, `certification` and `session` were declared as
evidence sources before anything emitted them.

_Enforced:_ `CONSTRAINTS §2`, `§31` · the five frozen perception contracts · review.

## 8. Explainability

Every automated decision must be answerable: _why was this camera degraded · why was this probe marked
failed · why did confidence drop · why is this firmware unsupported_. Each answer names the rule that
ran and points at the evidence it ran on.

A decision with no supporting evidence is an opinion, and the platform does not issue those.

**Explanations are reconstructed, never recorded** — see principle 2. Nothing consults a decision
record, which is what allows explainability to exist inside a frozen architecture: it adds no runtime
behaviour whatsoever.

_Enforced:_ `domain/decisions.ts` · `GET /cameras/:id/decisions` · evidence ids resolve in the unified
timeline.

## 9. Replayability

Stored evidence can be reconstructed without re-measuring. Replay rebuilds the stage order, timings,
outputs, failure point and evidence class of a probe **with no camera, network or probe port in
scope** — it cannot become a live measurement, which is a stronger guarantee than a comment asking it
not to.

Support work happens days after a failure, often on a camera since power-cycled into working.
Re-probing then answers "it works now", which closes the ticket without explaining anything.

**Replay is investigation. Validation is measurement. They must never merge.**

_Enforced:_ `CONSTRAINTS §28` · `replayProbe()` is pure · the route is a `GET` · an HTTP test counts
probe invocations across a replay.

## 10. Auditability

Every operational claim is traceable to immutable measured evidence, through **one** surface. Every
evidence item carries the same chain of custody — `evidenceId` · `evidenceType` · `evidenceClass` ·
`source` · `tenantId` · `producer` · `producerVersion` · `runtimeVersion` · `at` · `correlationId` ·
`sessionId` — whatever produced it.

Ids are **derived from the record**, never generated, so a link to a piece of evidence still resolves
tomorrow.

_Enforced:_ `CONSTRAINTS §32` · `domain/evidence-timeline.ts` · consumers read the envelope rather
than switching on the producer, guarded by a test that renders an evidence type the console has never
heard of.

---

## The order of work

Established G-1 through P-2.3 and unchanged:

> **Contract first · Runtime second · Product third · Customer solutions last.**

Each layer is completed and frozen before the next is built on it. The foundations are now complete;
the work from P-3 onward is customer-facing product built **on** them, not into them.

## Before you change a foundation

1. Is this genuinely additive? If not, it needs an ADR.
2. Does it persist a conclusion? (Principle 2 — derive it instead.)
3. Does it let something be claimed without the evidence class to support it? (Principle 3.)
4. Does it introduce a non-deterministic seam into a test path? (Principle 4.)
5. Does it create a second way to say something the platform already says? (Principle 5, 10.)
6. Could the need be met by consuming the foundation rather than changing it? Usually yes — and
   "usually yes" is why the freeze holds.

## Related

- [CONSTRAINTS](CONSTRAINTS.md) — the enforceable rules, with their enforcement points.
- [PLATFORM_BOUNDARIES](../architecture/PLATFORM_BOUNDARIES.md) — who owns what, permanently.
- [CAMERA_FOUNDATION_V1](../architecture/CAMERA_FOUNDATION_V1.md) — the first frozen foundation.
- [ENGINEERING_DECISION_LOG](ENGINEERING_DECISION_LOG.md) — why each decision was taken.
