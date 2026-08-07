# ADR-0040 — One EventEnvelope. Many payload schemas.

- **Status:** Accepted
- **Date:** 2026-08-06
- **Milestone:** P-8 Phase 5 (Live Event Bridge)
- **Scope:** **platform-wide and permanent** — binds every current and future producer
- **Amended by:** [ADR-0047](ADR-0047-an-analysis-run-is-part-of-an-events-identity.md) — adds the
  optional `analysisSessionId`, because an offline analysis stamps **footage** time and a rerun
  therefore reproduces every other identity field exactly. ⚠️ Additive and absent on every live
  event, so live dedup keys are byte-identical to the ones this ADR froze.
- **Related:** [ADR-0016](ADR-0016-nats-jetstream-event-backbone.md) (event backbone),
  [ADR-0038](ADR-0038-track-identity-across-gaps.md) (track identity),
  [ADR-0039](ADR-0039-absent-metrics-are-unavailable-never-zero.md) (absent metrics)

## Context

Phase 5 was commissioned as _"freeze the TrackingEvent schema before implementation"_. Taken
literally that creates a second event type beside `EventEnvelope` — and the architecture review found
that `EventEnvelope` already carries everything a tracking event needs:

| Need                             | Already in the envelope                                  |
| -------------------------------- | -------------------------------------------------------- |
| what happened                    | `type`, `category`, `priority` from the frozen catalogue |
| where                            | `tenantId`, `branchId`, `siteId`, `cameraId`, `zoneId`   |
| when it happened vs when we knew | `occurredAt`, `ingestedAt`                               |
| who produced it                  | `producer{capability, capabilityVersion, modelVersion}`  |
| **which tracked subject**        | `subjects[{trackId, class, bbox, attributes}]`           |
| chaining                         | `correlationId`, `causationId`                           |
| the type-specific body           | `payload` + `schemaVersion`                              |
| evidence                         | `evidenceRefs`                                           |

⚠️ **The envelope already separates two versions**, and that separation is the whole answer:
`envelopeVersion` versions the _structure every consumer binds to_, while `schemaVersion` versions
the _payload of one event type_. It was built for exactly this and had never been used for it.

A second envelope would have produced two transports, two subject taxonomies, two dedup strategies
and two things a consumer must learn — for a capability the first envelope already had.

## Decision

**There is one transport envelope on this platform: `EventEnvelope`. Subsystems define payload
schemas, never envelopes.**

### 1. No subsystem may introduce a second transport envelope

Not tracking, not camera assignment, not analytics, not a future AI module, not a connector. A new
producer contributes:

- **catalogue entries** — event types, with category, default priority and PII class;
- **payload schemas** — the body for those types, versioned by `schemaVersion`;
- **nothing else.**

### 2. Payload schemas are frozen independently of the envelope

⚠️ **Independent version lines, because they change at different rates and for different reasons.**
A dwell payload gaining an optional field must not force every consumer of every event type to
re-examine its envelope binding. Conversely an envelope change is a platform event and should be
felt as one.

- payload: additive within a major (new optional fields); a breaking change is a major bump;
- envelope: additive bumps the minor; **any breaking change requires its own ADR.**

### 3. `payload` stays opaque to the transport

The envelope schema types `payload` as an open record and validates it per-type through the
catalogue. That is deliberate: the transport must not need recompiling because a vertical added a
field. ⚠️ The cost is that an invalid payload is caught at the consumer rather than at the wire, so
**producers validate before publishing and consumers fail closed** — the events service already
dead-letters a body that is not a valid `DetectionResult`, and that posture is the rule, not an
implementation detail of one service.

### 4. Meaning never enters the envelope

`type` says what was observed. It never says what it _means_. `spatial.zone.entered` is a boundary
crossing; whether that is an intrusion depends on the zone, the hour and the tenant's rules — all of
which belong to the Rule Engine. ⚠️ A `retail.theft.suspected` event type would put a vertical's
semantics in a contract every vertical shares, and is forbidden by this ADR as much as a second
envelope is.

## Verified, not asserted (2026-08-06)

This ADR claims a payload version can move without a transport change. That is a claim about a
running consumer, so it was measured against the deployment
(`docs/review/p8/event-bridge-replay.mjs` §4):

| Published onto `t.{tenant}.event.perception.person.detected`                | Result                       |
| --------------------------------------------------------------------------- | ---------------------------- |
| `envelopeVersion 1.0.0` + `schemaVersion 1.0.0`                             | consumed, evaluated, matched |
| `envelopeVersion 1.0.0` + `schemaVersion 2.0.0` + unknown scalar            | consumed, evaluated, matched |
| `envelopeVersion 1.0.0` + `schemaVersion 3.0.0` + unknown **nested object** | consumed, evaluated, matched |

3/3 matched, 0 rule failures, no transport change and no consumer change. A future payload version is
free to move.

⚠️ **The same run recorded the other half honestly.** An envelope declaring `envelopeVersion 2.0.0`
was also **accepted** — `envelopeVersion` is carried, reported, and checked by nobody. That is right
for an additive minor and a real gap for a breaking major: a third-party producer publishing a
breaking envelope would have it consumed as though understood rather than dead-lettered. Recorded as
[L-49](../project/KNOWN_LIMITATIONS.md#l-49--a-future-envelope-version-is-accepted-rather-than-refused)
and deliberately **not fixed here** — a rejection path that nothing exercises is how a fail-closed
gate quietly becomes wrong. It lands with the first breaking envelope change.

## Consequences

**Good.** One transport to learn, one subject taxonomy, one dedup strategy, one audit story. A new
producer is catalogue entries plus payload schemas — no transport work, no consumer changes. The
existing chain (normalize → dedup → persist → publish → evaluate → candidate) is reused rather than
re-earned, and every consumer already built keeps working.

**Costly.** A payload that does not fit the envelope's shape must be reshaped rather than escaping
into a new type. ⚠️ That pressure is the point: it is the same pressure that produced the discipline,
and relieving it once would relieve it permanently.

⚠️ **This constrains a genuine future need.** If a producer one day needs a field the envelope has no
place for — a spatial reference frame, a sensor fusion source — the answer is an **additive envelope
field with an ADR**, not a parallel type. Anything that looks like "our events are different" is the
failure mode this decision exists to prevent, and it will look reasonable at the time.

⚠️ **It does not make the envelope infinitely extensible.** `payload` is open, but an envelope field
added for one producer is carried by every event on the platform forever. The bar for a new envelope
field is higher than for a payload field, and this ADR is where that asymmetry is recorded.

## Alternatives considered

**A `TrackingEvent` type beside `EventEnvelope`.** Rejected — the literal reading of the brief. It
duplicates the transport for a capability the envelope already has, and every consumer would need to
handle both. The same reasoning that stopped Phase 5 building a second rule engine applies one layer
down.

**Extend the envelope with tracking-specific fields.** Rejected. `motion`, `dwellSeconds` and
`headingDegrees` are meaningful for a tracked subject and meaningless for `tenant.created`. Fields
that are absent for most events belong in `payload`, which is what `payload` is.

**Put identity in `subject.attributes` rather than naming it.** Rejected, and this was close.
`attributes` is a free-form bag and would have avoided touching a frozen contract. But `identityId`
is the field ADR-0038's entire argument rests on — a rule that groups by the wrong one under-fires
silently — and burying the platform's answer to "is this the same person?" in a stringly-typed bag
would make the most consequential field the least discoverable. It is named, optional and additive
instead. See [ADR-0041](ADR-0041-identity-travels-with-the-subject.md).
