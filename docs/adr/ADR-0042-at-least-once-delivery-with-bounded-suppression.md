# ADR-0042 — Delivery is at-least-once, suppression is bounded, and recording outranks both

- **Status:** Accepted
- **Date:** 2026-08-06
- **Milestone:** P-8 Phase 5 (Live Event Bridge)
- **Scope:** **platform-wide** — binds every producer publishing onto the backbone
- **Related:** [ADR-0005](ADR-0005-event-driven-backbone.md) (event-driven backbone),
  [ADR-0016](ADR-0016-nats-jetstream-event-backbone.md) (JetStream),
  [ADR-0039](ADR-0039-absent-metrics-are-unavailable-never-zero.md) (absent metrics),
  [ADR-0040](ADR-0040-one-event-envelope-many-payload-schemas.md) (one envelope),
  [L-46](../project/KNOWN_LIMITATIONS.md#l-46--event-delivery-is-at-least-once-and-duplicate-suppression-is-a-window),
  [L-47](../project/KNOWN_LIMITATIONS.md#l-47--events-are-dropped-under-pressure-deliberately-and-recording-is-not)

## Context

P-8 Phase 5 put live traffic on the event backbone for the first time. Until then the pipeline was
exercised only by integration tests and a demo seeder, and its delivery semantics had never been
stated — they were whatever the implementation happened to do.

Three questions had to be answered before a customer integration could be built against it, and each
has an answer that is easy to get wrong in the optimistic direction:

1. If the same detection reaches the platform twice, does it become one event or two?
2. What happens to events when the broker is unreachable?
3. What is the platform allowed to sacrifice under pressure?

⚠️ **A distributed system does not inherit a delivery guarantee from a config flag.** "Exactly once"
is a claim that has to be demonstrated, and demonstrating it here found that the platform does not
have it — it has something narrower and more useful to state precisely.

## Decision

### 1. Delivery is **at-least-once**. The platform does not claim exactly-once.

Two independent mechanisms suppress duplicates, and **both are windows**:

| Mechanism                    | Key                                                 | Width          |
| ---------------------------- | --------------------------------------------------- | -------------- |
| JetStream `duplicate_window` | `Nats-Msg-Id` — `tenant:camera:seq` at the producer | **2 minutes**  |
| Events service `dedupKey`    | `tenant + type + camera + zone + track + bucket`    | **10 seconds** |

Measured on the deployment (`docs/review/p8/event-bridge-replay.mjs` §1):

- five publishes sharing a `msgId` reached the stream **once**;
- five publishes of the same body with **fresh** `msgId`s all reached the stream, and still produced
  **one** persisted event — the second mechanism collapsed them;
- the same result published one bucket later produced a **second** event.

**Six deliveries of one result → one event inside the windows, two across them.**

⚠️ **Every consumer must be idempotent**, keyed on `EventEnvelope.id`. This is a requirement on
consumers, not an aspiration, and it is stated in the limitation register so it reaches an integrator
rather than only an engineer.

### 2. The same windows are what make replay safe, and they bound that too.

`POST /events/replay` re-publishes persisted envelopes under their own id as the `msgId`. Inside the
JetStream window a replay is therefore **absorbed**: measured, replaying the same range twice
produced **0 re-evaluations and 0 additional incidents**, and left the store byte-identical. Outside
the window, the same replay **does** re-evaluate.

Both halves are stated. A replay tool that is safe only within a window it does not mention is a
footgun with a good demo.

### 3. Recording outranks publishing, unconditionally.

The publisher is reached from the process writing MP4 segments. It therefore:

- **enqueues and returns** — never awaits, never throws, never applies back-pressure upward;
- bounds its queue **per camera**, so one stalled camera cannot consume another's slots;
- **drops the oldest and counts it** when the queue is full or the broker is gone;
- retries a **bounded** number of times, because an unbounded retry against a down broker converts an
  outage into a memory leak on the one process that must not run out of memory.

Measured across a 20-second broker outage: 16 dropped by policy, 4 lost after exhausting retries, and
**segments continued to be written throughout** (2 → 6).

⚠️ **Events lost during an outage are gone.** Nothing replays them, because they were never
persisted. That is a deliberate trade and it is recorded as a limitation rather than described as
resilience.

### 4. The four reasons a frame does not become an event stay four numbers.

`rejected` (failed the contract at the producer), `suppressed` (no detections), `droppedQueueFull`
(policy under pressure) and `droppedOutOfOrder` (a newer frame already went out) are separate
counters, separately rendered. Only `failed` — every attempt exhausted — is a fault.

⚠️ Collapsing them into one "not published" figure would make a healthy busy site look identical to a
broken one. This is [ADR-0039](ADR-0039-absent-metrics-are-unavailable-never-zero.md) applied to
counts rather than to averages: the shape of the number must not destroy the distinction the operator
needs.

## Consequences

**Good.** The semantics are written down, measured, and re-measured nightly. An integrator can build
against them. A future consumer knows that idempotency is its job and that a replay is safe to run.
The bridge cannot cost a customer their evidence, which is the only thing on this platform that
cannot be regenerated.

**Costly.** ⚠️ **A customer who wants zero event loss cannot have it today.** The honest answer is a
disk-backed spill queue, which is a real feature with its own retention, replay ordering and failure
modes — not a setting. It is deferred until someone says the loss matters more than the simplicity,
and [L-47](../project/KNOWN_LIMITATIONS.md#l-47--events-are-dropped-under-pressure-deliberately-and-recording-is-not)
exists so that conversation happens before a pilot rather than after an outage.

⚠️ **The windows are deployment configuration, so the guarantee is too.** `EVENTS_DEDUP_WINDOW_MS`
and JetStream's `duplicate_window` can be widened, and widening them widens suppression at the cost
of memory and stream state. Any deployment that changes them changes what this ADR promises, which is
why the verification reads both from the running system rather than asserting a constant.

## Alternatives considered

**Claim exactly-once and rely on the dedup key.** Rejected, and it was tempting because in normal
operation the platform behaves that way. The claim is false at the boundary, and the failure it
produces — a duplicated incident, a double-counted analytic — appears only under the conditions
(reconnection, replay, backlog) where a customer is already investigating something else.

**Transactional delivery across the broker boundary.** Rejected as unavailable: it would require a
two-phase commit between the publisher's queue and JetStream, which the backbone does not offer and
which would put a distributed transaction on the process writing evidence.

**Block the frame path when the broker is unreachable, so no event is lost.** Rejected outright, and
this is the decision the ADR exists to make permanent. It converts a broker outage into a recording
outage. Events are a derived, regenerable-in-principle signal; a segment that was never written is
gone for ever, and it is the artifact a customer would take to a court or an insurer.

**Persist events at the producer and forward later.** This is the spill queue above — not rejected,
deferred. Recorded so that the next person to have the idea finds the reasoning rather than the
silence.
