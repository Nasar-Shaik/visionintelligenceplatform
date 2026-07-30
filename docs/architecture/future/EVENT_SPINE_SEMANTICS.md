# Event Spine Semantics — Versioning, Deduplication & Ordering

_Status: ⏳ Architect Review Pending · Author: Claude · Date: 2026-07-30 · **Documentation-only**_

> Commissioned at **G-3.5 closeout** (Architect recommendations 1–3). Documents the **existing**
> semantics of the event spine and the **evolution strategy** for future distributed deployments —
> **no code change, no frozen-doc change (01–28)**. Grounds every statement in the shipped
> implementation so future enablers have an explicit contract to preserve.
>
> Frozen anchors: [09-EVENT-PLATFORM](../09-EVENT-PLATFORM.md), [ADR-0005](../../adr/ADR-0005-event-driven-backbone.md)
> (event-driven backbone), [ADR-0016](../../adr/ADR-0016-nats-jetstream-event-backbone.md) (NATS JetStream),
> Constitution §7 (versioning). Implementation: [`@vip/contracts/events`](../../../packages/contracts/src/events/),
> [`@vip/messaging`](../../../packages/messaging/src/), [`services/events`](../../../services/events/).

---

## 1. Event Versioning (recommendation #1)

### 1.1 What exists today

Every `EventEnvelope` already carries **two independent version axes**
([envelope.ts](../../../packages/contracts/src/events/envelope.ts)):

| Field                                       | Versions                                                                                             | Semantics                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `envelopeVersion` (SemVer, default `1.0.0`) | the **envelope structure** — the outer contract every consumer (rules/analytics/connectors) binds to | additive change → **minor**; breaking change → **major** (+ ADR) |
| `schemaVersion` (SemVer, required)          | the **type-specific `payload`** shape for a given `type`                                             | additive-only within a major                                     |
| `category` (enum, set from the catalog)     | coarse routing class                                                                                 | **extend the enum additively, never repurpose**                  |

The normalizer stamps `envelopeVersion = 1.0.0` and `schemaVersion = 1.0.0` today
([event-normalizer.ts](../../../services/events/src/domain/event-normalizer.ts)).

### 1.2 Strategy (the rules to preserve)

1. **Additive-only within a major.** New optional fields, new event `type`s, new `category` values,
   and new `payload` keys are **minor** bumps. A consumer written for `1.x` must ignore unknown fields
   (Zod `.strip()` semantics already do this) and unknown types (the catalog fallback maps unknown
   labels to `perception.object.detected`).
2. **Breaking changes require a major bump + ADR.** Removing/renaming a field, changing a field's type,
   or repurposing a `category`/`type` is a **major** `envelopeVersion` bump, recorded as an ADR, and —
   critically — **the old major is retained** (see replay, §1.3).
3. **The catalog is append-only.** [catalog.ts](../../../packages/contracts/src/events/catalog.ts) entries
   are never renamed; a superseded type is marked deprecated but kept, so historical events still resolve.
4. **Producers declare, consumers tolerate.** Producers set the versions they emit; consumers branch on
   `envelopeVersion`/`schemaVersion` only when they must, and default to forward-compatible handling.

### 1.3 Backward compatibility & replay of historical events

Replay ([events replay route + `EventStore.range`](../../../services/events/src/adapters/in-memory-event-store.ts))
re-publishes **stored** envelopes exactly as persisted — including their **original** `envelopeVersion`
/`schemaVersion`. Therefore:

- **Consumers must remain able to parse every envelope major they have ever persisted.** The Rule
  Engine re-evaluates a replayed `1.0.0` event years later; if `2.0.0` ever ships, the engine must still
  accept `1.x` (a version-dispatch/upcaster seam, not a hard cutover).
- **Recommended pattern (future): an upcaster at ingest/replay.** A pure `upcast(envelope) → envelope`
  step normalizes older majors to the current in-memory model before evaluation, so downstream logic
  handles one shape. Kept out of scope now (single major); documented as the extension point.
- **Determinism requirement (proven in G-3.5):** replaying the same stored events yields identical rule
  evaluations. Versioning must never break this — an upcaster must be **pure and total**.

### 1.4 Backward-compatibility expectations (contract)

| Change                       | Allowed within major? | Consumer obligation                                    |
| ---------------------------- | --------------------- | ------------------------------------------------------ |
| Add optional envelope field  | ✅ (minor)            | ignore if unknown                                      |
| Add new event `type`         | ✅ (minor)            | catalog fallback; rules match only declared types      |
| Add `category` value         | ✅ (minor)            | route by known categories; treat unknown as unrouted   |
| Add `payload` key            | ✅ (minor)            | ignore if unknown                                      |
| Remove/rename/retype a field | ❌ (major + ADR)      | branch on `envelopeVersion`; retain old-major handling |

**Tracked as [TD-10](../../../tracking/TECH-DEBT.md).**

---

## 2. Deduplication Strategy (recommendation #2)

Deduplication is **layered and identity-based** — it is **not** a single mechanism, and it is
**not** correlationId-based (correlationId threads _causality_, not identity). Three cooperating layers:

### 2.1 Broker layer — `msgId` (exact redelivery)

JetStream drops a duplicate publish carrying a `msgId` already seen within the stream's dedup window
([event-bus.ts](../../../packages/messaging/src/event-bus.ts) `PublishOptions.msgId`):

| Hop                | `msgId`                            | Collapses                                      |
| ------------------ | ---------------------------------- | ---------------------------------------------- |
| persisted event    | `envelope.id` (Uuid)               | at-least-once **redelivery** of the same event |
| incident candidate | `candidate.dedupKey`               | a burst of identical candidates                |
| incident lifecycle | `{tenant}:{id}:{status}:{version}` | redelivered transition                         |
| notification       | `{tenant}:{id}:{status}`           | redelivered delivery signal                    |

### 2.2 Content layer — the events-store dedup key (near-duplicate collapse)

The events store collapses **content-and-time-window duplicates** at persist
([event-normalizer.ts `dedupKey`](../../../services/events/src/domain/event-normalizer.ts)):

```
dedupKey = tenantId | type | cameraId | zoneId | (subject.trackId ?? subject.class) | floor(occurredAt / windowMs)
```

`windowMs` = `EVENTS_DEDUP_WINDOW_MS` (default **10 000 ms**). `persist(scope, envelope, key)` is
idempotent on this key — a repeat within the bucket is persisted **once** and **not re-published**. So
identity = **type + spatial scope + subject/track + time bucket**, _not_ a content hash.

### 2.3 Incident layer — the candidate dedup key (one incident per burst)

```
candidateDedupKey = tenantId | ruleId | groupKey(camera|zone|none) | floor(occurredAt / 60 000)
```

`IncidentService.promote` is idempotent on `(tenantId, dedupKey)`
([incident-service.ts](../../../services/workflow/src/application/incident-service.ts)), so a burst of
matches raises **one** incident. Notify adds a final guard: idempotent per `(tenant, incidentId, channelId)`.

### 2.4 What dedup is keyed on — explicit answer

| Candidate key                  | Used? | Where                                                                |
| ------------------------------ | ----- | -------------------------------------------------------------------- |
| **`eventId`**                  | ✅    | broker `msgId` for exact redelivery (§2.1)                           |
| **content + time window**      | ✅    | events-store `dedupKey` — the primary near-duplicate collapse (§2.2) |
| **rule + group + time window** | ✅    | incident-candidate dedup (§2.3)                                      |
| **`correlationId`**            | ❌    | threads causality, **never** identity                                |
| **content hash**               | ❌    | not used; the composite key is the identity                          |

### 2.5 Distributed-deployment considerations (for future enablers)

- **Time-bucket boundary effects.** Two truly-identical events straddling a bucket edge are **not**
  collapsed. Acceptable now (10 s window); if tightened, document the trade-off.
- **Wall-clock skew.** `dedupKey` uses `occurredAt` (producer time), so dedup is skew-tolerant _as long
  as producers stamp a consistent clock_. Multi-node producers must use a synchronized/monotonic source.
- **Dedup window vs. stream retention.** The broker `msgId` window must be ≥ the redelivery horizon;
  the content window is independent and shorter. Keep them documented together when scaling.

**Tracked as [TD-11](../../../tracking/TECH-DEBT.md).**

---

## 3. Event Ordering (recommendation #3)

### 3.1 What the backbone guarantees

- **Per-subject FIFO.** JetStream stores messages in publish order and a durable pull consumer on a
  filter subject delivers them in stream order ([nats-event-bus.ts](../../../packages/messaging/src/nats-event-bus.ts):
  `AckPolicy.Explicit`, `DeliverPolicy.All`). Subjects are **tenant-partitioned** (`t.{tenant}.event.{type}`),
  so ordering is effectively **per `(tenant, type)`**.
- **At-least-once, not exactly-once.** Explicit ack + `max_deliver` → a message may be **redelivered**;
  ordering across a redelivery is **not** preserved. Hence every consumer is **idempotent** (§2).
- **No global total order.** There is no cross-subject or cross-partition total order, by design (it is
  what lets the platform scale horizontally).

### 3.2 Per-service ordering requirements

| Service                        | Needs strict order? | Why / behaviour                                                                                                                                                                             |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **events** (ingest)            | **No**              | idempotent persist + content dedup; reordering/redelivery is safe                                                                                                                           |
| **rules** (stateless match)    | **No**              | each event evaluated independently against enabled rules                                                                                                                                    |
| **rules** (windowed threshold) | **Weakly**          | the sliding-window count is **time-based** (`occurredAt` + window), not delivery-order-based; tolerant of minor reordering; near-simultaneous events are counted by occurrence, not arrival |
| **workflow** (promote)         | **No**              | idempotent on `dedupKey` — first candidate wins, the rest collapse regardless of arrival order                                                                                              |
| **notify** (fan-out)           | **No**              | idempotent per `(incident, channel)`                                                                                                                                                        |

### 3.3 Near-simultaneous events — expected behaviour

- Two events for the **same** subject/track within the dedup window → **collapsed to one** (§2.2).
- Two events for **distinct** subjects/tracks (or cameras/zones) → **independent**; both flow, both may
  raise incidents. There is no assumption that one "precedes" the other.
- **Causal** order is preserved by reference, not by delivery order: `correlationId` +
  `causationId` (Event → Candidate → Incident → Notification) reconstruct the chain even if wall-clock
  timestamps tie (proven in G-3.5 traceability).

### 3.4 Distributed-deployment considerations

- If a **future** stateful stage requires strict per-track order (e.g. an Object Tracker or Behaviour
  Analyzer, see [AI_PROCESSING_PIPELINE](AI_PROCESSING_PIPELINE.md)), pin it to a **per-`(tenant,camera,track)`
  partition/consumer** so order holds within the unit that needs it — never a global order.
- Windowed rule state should move to a shared store (Redis) for cross-replica correctness
  (already tracked, [TD-7](../../../tracking/TECH-DEBT.md)); ordering semantics above are unchanged by that.

**Tracked as [TD-12](../../../tracking/TECH-DEBT.md).**

---

## 4. Summary — the contract future enablers must preserve

1. **Versioning:** two axes (`envelopeVersion` structure, `schemaVersion` payload); additive-only within
   a major; breaking = major + ADR + retained old-major handling; catalog append-only; replay re-emits
   original versions (upcaster is the future seam).
2. **Deduplication:** identity = broker `msgId` (=eventId) ⊕ content+time-window store key ⊕ rule+group+window
   incident key; **not** correlationId, **not** content hash.
3. **Ordering:** per-subject FIFO + at-least-once + idempotent consumers; no global total order; stateful
   stages partition by the unit that needs order; causality via correlation/causation ids.

Nothing here is built or changed — it documents the invariants G-3.5 proved, so **G-4 Evidence APIs**
and later AI stages evolve without breaking replay, dedup, or isolation.
