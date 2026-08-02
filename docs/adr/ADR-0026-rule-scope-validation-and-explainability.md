# ADR-0026 — Rules scope to the Location Hierarchy: resolve at validation, evaluate on a set

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-4 authorization)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`RuleScope`, `ResolvedRuleScope`, `RuleValidationReport`, `RuleValidationIssue`, `RuleReferenceKind`, `ConditionTrace`, `RuleExplanation`); `services/rules` (`domain/scope.ts`, `domain/explain.ts`, `domain/validation.ts`, `application/compiled-rules.ts`, `HierarchyProvider`/`CameraDirectory` ports); `apps/console` (`RuleScopeField`, `RuleValidationPanel`, `RuleExplanationView`). Relates to [ADR-0025], [CONSTRAINTS §33, §43–45], [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md), [TD-7].

## Context

P-4 opens the Product Capability layer with the Rule Designer. The rule engine already existed from
P1-7 — a sandboxed predicate tree, lifecycle states, immutable versions, dry-run — and was already
correct. Three things were missing, and all three are the reason P-4 follows P-3:

1. **A rule had no location.** Every rule applied to the entire tenant. A customer with forty sites
   could not say "loitering matters at the London docks and nowhere else", which is the first thing
   any of them asks for.
2. **Nothing validated a rule before it went live.** `lifecycle: 'validated'` was a state an author
   could select; no check stood behind it.
3. **Explainability was three booleans.** "Condition did not match" starts an investigation; it does
   not end one.

The engine also queried MongoDB for the tenant's enabled rules **on every event** ([TD-7]) — which
the Architect's P-4 rec 12 forbids outright, and which scope evaluation would have made worse.

## Decision

### 1. A scope is authored as node ids and evaluated as a set of leaf ids

`RuleScope` holds **node ids** (any level) and camera ids. `ResolvedRuleScope` holds the **expansion**:
every zone id those nodes cover. The expansion is computed at validation and **stored on the rule
version**.

Two reasons, and they point the same way:

- **Evaluation must not query.** The engine sees every event and evaluates every enabled rule against
  it. A hierarchy lookup there is a query per rule per event. A `Set.has` is not.
- **A version must mean one thing forever.** The expansion is part of the immutable version, so an
  incident raised six months ago can be shown the exact zones its rule covered _then_. Recomputing
  would silently rewrite the past — the failure [E-1](../tracker/E-1-EVIDENCE-LOCATION-SNAPSHOT.md)
  records for evidence.

**The cost is staleness**, and it is accepted deliberately: zones added under a scoped node after
resolution are not covered until the rule is re-validated. That is visible (`resolvedAt`, and the
console says so) rather than silent, and revalidation is one click. The alternative — recomputing on
read — trades a visible, correctable staleness for an invisible rewriting of history.

### 2. The hierarchy is reached through a port, at validation time only

`HierarchyProvider` and `CameraDirectory` are ports, defaulting to **unavailable**. They are called
when a rule is validated or enabled — **never per event**. The engine's hot path holds a pre-expanded
set and could not reach a hierarchy if it wanted to.

This is a **bounded, deliberate exception** to
[PLATFORM_BOUNDARIES rule 4](../architecture/PLATFORM_BOUNDARIES.md), recorded here the way ADR-0023
recorded discovery rather than left to be discovered. Rule 4 exists to prevent a synchronous
cross-context call in a **runtime path** — that is how a distributed monolith starts. A validation-time
call that fails closed and whose result is snapshotted onto an immutable version is a different shape
with different consequences.

### 3. A check that could not run is not a check that passed

`RuleValidationReport` carries **`valid`** and **`verified`** separately. When a context is
unreachable, `verified: false`, and the rule **cannot be enabled**.

Letting a rule go live because a check was skipped is the configuration version of certifying hardware
from a simulation — precisely what
[Foundation Principle 3](../project/FOUNDATION_PRINCIPLES.md) exists to prevent. The requirement is
**proportional**: a tenant-wide rule references no location, so it validates fully without the
hierarchy being reachable.

### 4. Explanations reuse the interpreter and report the first failing stage

`explainCondition` walks the same tree with the same `evaluatePredicate` the engine uses. A second
implementation would drift, and an explanation that describes a decision the engine did not make is
worse than none, because it is believed.

The **first** failing stage decides the summary. A rule scoped to the wrong site _and_ with a failing
condition reports the scope — fixing the condition would not have helped. Composites are not
short-circuited when explaining (they are when evaluating): the leaf that would have failed next is
usually what the author needs.

Explanations are **derived, never stored** — Foundation Principle 2, so they improve retroactively.

### 5. Rules are compiled per tenant, with a TTL

`RuleSetCache` holds each tenant's enabled rules, sorted, bounded, with scopes expanded into sets.
Evaluating an event touches no store.

Correctness is bounded by a **TTL, not by invalidation alone**: a cache invalidated only on local
writes is wrong whenever the write happened on another replica. Concurrent misses are coalesced, so a
cold tenant hit by a burst issues one query rather than hundreds — the per-event query reappearing
exactly when load is highest. This pays down the second half of [TD-7].

## Consequences

- **A scoped rule that has never been validated matches nothing**, not everything. Both failure
  directions are bad; this one is visible. A rule that goes quiet gets noticed and its explanation
  names the cause, whereas a rule firing across an estate looks like the product working.
- **An event with no location fails a narrowed scope.** Treating "unknown" as "inside" is how a rule
  for one site starts alerting for all of them.
- **Re-scoping drops the expansion**, so a stale expansion can never outlive the scope it belonged to.
  The rule becomes unresolved until re-validated, which is also what blocks re-enabling it.
- **Enabling and resolving are one operation.** Separating them would allow a rule to go live with no
  expansion.
- **A broken rule can still be disabled or archived.** The gate guards the transition _into_ enabled
  only; requiring validity to turn something off is the opposite requirement and easy to break by
  symmetry.
- Rules remain **declarative configuration**. Nothing generated, nothing evaluated as code, no
  industry noun anywhere in the model (Architect rec 3, 8).

## Alternatives considered

- **Resolve the subtree per event in the engine.** Simplest to write and the reason rec 12 exists: a
  query per rule per event.
- **Carry the zone's ancestry on the `EventEnvelope`**, so a rule could match `path.includes(nodeId)`
  with no expansion at all. Genuinely attractive — no staleness, no port. Rejected because the
  producers (camera, media, inference) do not know the hierarchy either, so the ancestry would have to
  be resolved cross-context at **event-write** time: the same call, moved to a hotter path.
- **Denormalise the scope expansion onto each camera.** A second copy of another context's fact, wrong
  from the instant a site is renamed.
- **Let the console resolve the subtree and submit zone ids.** It already has the tree (P-3), so this
  is nearly free — and it makes a client the author of persisted business data, which
  [CONSTRAINTS §37](../project/CONSTRAINTS.md) forbids for exactly this reason.
- **Validate only at activation, not on demand.** Rejected: an author needs to see what is wrong
  before deciding to go live, or "why can't I enable this?" becomes a guessing game.

## Implemented · Future Extension · Out of Scope

**Implemented:** location and camera scoping · reference validation with `valid`/`verified` ·
validate-before-activate · full condition traces and stage attribution · compiled per-tenant rule sets
· console scope field, validation panel and explanation view.

**Future Extension** (documented, none built): schedule references and time-of-day scoping ·
behavior/composite reference checks (the `RuleReferenceKind` values are declared ahead of them) ·
notification outputs — webhook, REST callback, SMS, email, WhatsApp, MQTT, Kafka, Event Hub, SNS —
which arrive as new `RuleAction` variants · simulation and offline replay over historical events ·
per-rule metrics.

**Out of Scope:** a visual condition builder (conditions are authored as validated JSON) · rule
templates · cross-tenant rules · rule chaining · ML-suggested thresholds.

**Known Limitation:** a scope expansion goes stale when the hierarchy changes beneath a scoped node.
Visible, one click to fix, and the eventual answer is a hierarchy-change subscriber on the event
backbone — blocked on [TD-6].

**Technical Debt:** [TD-21] — the rule editor cannot be saved in edit mode; its lifecycle and severity
`Select`s fail form validation. Pre-existing and reproduced against the pre-P-4 editor.
