# Platform Boundaries

**Permanent. Future work consumes these boundaries; it does not bypass them.**

Status: frozen · Recorded 2026-08-02 at the Camera Foundation v1.0 freeze.

---

Every one of these boundaries was drawn because the alternative had already started to go wrong
somewhere, or would have. They are stated as ownership — _who is allowed to claim what_ — because
that is the form in which they get violated.

## The chain

```
Camera Service  →  AI Runtime  →  Evidence  →  Rule Engine  →  Incident Management  →  Console
```

Read left to right as _what produces what_, not as a call stack. The Camera Service calls the runtime
through a port; the runtime never calls back.

## Who owns what

| Component               | Owns                                                                                                             | Must never                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Camera Service**      | Device identity · lifecycle · capability cache · operational history · evidence archive · compatibility register | Contain perception logic. Decode a frame. Infer a failure the runtime already named.        |
| **AI Runtime**          | The decode path · discovery · the staged probe pipeline · detection · tracking · behaviour · observations        | Own device lifecycle. Create an incident. Persist tenant data. Hold business logic.         |
| **Evidence**            | Immutable records · provenance · retention · the unified investigation timeline                                  | Be modified after it is written. Store a conclusion. Be produced without an evidence class. |
| **Rule Engine**         | Interpreting observations into candidates                                                                        | Measure anything. Reach past the event boundary into a device.                              |
| **Incident Management** | Incidents · workflow · assignment · resolution                                                                   | Be created by the runtime. Be the only record of what happened.                             |
| **Console**             | Presentation                                                                                                     | Contain business logic. Infer a diagnosis. Decide a state.                                  |

## The four rules that keep it honest

### 1. The runtime produces observations; it never decides

The runtime emits `EventEnvelope` and measurements. It does not create incidents, does not own a
device's lifecycle, and does not know what a customer considers a problem.

_Why:_ perception that knows about business rules cannot be certified independently of them, and a
runtime that creates incidents is one whose behaviour changes when a rule changes.

### 2. Measurement lives where the decode path lives

Only the runtime can open a stream, so only the runtime can measure one. The Camera Service reaches it
through a **port** (`StreamProbe`, `DiscoveryProvider`) — the same arrangement for both, and an
unconfigured deployment reports the capability as unavailable rather than reporting every camera as
failed.

_Why:_ the alternative is a second decode implementation in a service that has no reason to have one,
and two implementations of "can we open this stream" that will disagree.

### 3. The naming component is the only one that names

Whoever produces a fact assigns its meaning. The runtime names a probe failure (`failureCode`); the
Camera Service records that name; the console renders words for it.

_Why:_ P-2 derived the failure headline in the console by scanning for the first failing check. That
is business logic in the visualization tier, and it would have disagreed with the runtime the first
time a stage was renamed. Removing it was a **deletion**, not a feature.

### 4. Cross-context reads go through the event backbone

Contexts stay independently deployable. A synchronous call from one bounded context into another to
check whether something exists is how a distributed monolith starts.

_Why:_ `docs/architecture/22-BOUNDED-CONTEXTS.md`; the one outstanding case (camera → tenant zone
existence) is tracked as debt rather than solved by a shortcut (ED-0024/TD-3).

## The separation of concerns, stated plainly

```
Runtime      →  produces observations
Rule Engine  →  interprets observations
Product      →  presents observations
Business     →  decides actions
```

No component does two of these. A component that both measures and decides cannot be trusted about
either, because there is no longer any way to check one against the other.

## What "consume, don't bypass" means in practice

- Needing device data → read the Camera Service's contracts. Do not query its collections.
- Needing a measurement → call the probe port. Do not open a stream.
- Needing history → read the unified evidence timeline. Do not join four stores yourself.
- Needing an explanation → read the decision endpoint. Do not re-derive the rule.
- Needing something the boundary does not expose → **say so and propose an additive contract.** Do not
  route around it.

The last one is the whole discipline. Every boundary erosion in every platform starts as a reasonable
shortcut taken by someone in a hurry who knew exactly what they were doing.

## Related

- [FOUNDATION_PRINCIPLES](../project/FOUNDATION_PRINCIPLES.md) — the ten rules, mandatory reading.
- [CAMERA_FOUNDATION_V1](CAMERA_FOUNDATION_V1.md) — the first frozen foundation.
- [22-BOUNDED-CONTEXTS](22-BOUNDED-CONTEXTS.md) · [23-SERVICE-OWNERSHIP](23-SERVICE-OWNERSHIP.md).
- [ADR-0023](../adr/ADR-0023-onvif-discovery-placement.md) ·
  [ADR-0024](../adr/ADR-0024-camera-lifecycle-evidence-gate.md) — the two decisions that drew the
  Camera Service ↔ AI Runtime line.
