# ADR-0027 — Rule operations: derive diagnostics, gate live edits, keep history append-only

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-4 approval + 15 recommendations)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`RuleCompilation`, `RuleDependency`, `RuleDependencyGraph`, `RuleDependents`, `RuleLimits`, `RuleComplexity`, `RuleRuntimeStats`, `RuleCacheStats`, `RuleStatsReport`, `RuleAuditEntry`, `RuleRollbackInput`, `RuleSimulationInput`, `RuleSimulationResult`, `RulePackage`, `RuleImportResult`, `StageTrace`, `RuleExplanation.tree`); `services/rules` (`domain/fingerprint.ts`, `domain/dependencies.ts`, `domain/budget.ts`, `domain/audit.ts`, `application/rule-stats.ts`, `RuleDiagnostics` port, `RuleStore.restore`); `apps/console` (version history → audit timeline with restore; explanation renders the server's tree). Relates to [ADR-0026], [FOUNDATION_PRINCIPLES §2, §3], [RULE_ENGINE_BASELINE](../architecture/RULE_ENGINE_BASELINE.md).

## Context

P-4 was approved with fifteen recommendations covering compilation metadata, dependency graphs, runtime
metrics, evaluation budgets, warm-up, structured explainability, rollback, cache observability, a
simulation API, import/export, tenant-isolation tests, an audit trail, scale benchmarks, immutable
packages, and P-5 readiness.

Almost all of it is **operational**: things a support engineer, an operator or a deployment needs, none
of which may touch how a rule decides. That framing produced most of the decisions below. Building it
also surfaced three defects in code that was already approved — see [Defects found](#defects-found).

## Decision

### 1. Diagnostics are derived, never stored

Every fingerprint, dependency graph, complexity measurement and audit entry is **computed from the rule
and its versions on demand**. Nothing is persisted alongside the thing it describes.

A stored hash can disagree with its rule — after a migration, a partial write, a restore from backup —
and a fingerprint that can lie is worse than none, because it is trusted. Recomputation costs
microseconds and _is_ the verification. This is [Foundation Principle 2] applied to metadata: persist
measurements (the versions), derive conclusions (the narrative).

The same reasoning ruled out a parallel audit collection. The platform has written an immutable
`RuleVersionRecord` with a full snapshot since P1-7; the Architect's lifecycle actions are all already
implied by it. A second trail written by a different code path is two records of one truth that
eventually disagree, with no principled way to decide which lied — and deriving instead means the
timeline works **retroactively**, on rules authored long before anyone thought about audit actions.

`rolled-back` is derived too: a version whose content hash equals an earlier version's is a return to
that version. That is what a rollback _is_, so it is detected however it happened — through the
endpoint, through an operator re-pasting an old body, or through a script. An intent flag would have
recorded only the first.

### 2. What a content hash excludes is the design

`compiledHash` covers prefilter, condition, window, actions, severity and scope. It excludes name,
description, timestamps, version — and **lifecycle**.

Lifecycle is the non-obvious one and the important one. It is operational state, not content: a rule
paused overnight and resumed in the morning is the same rule. Folding the two together makes both
questions unanswerable — "was this edited?" would be true after a pause, and a genuine rollback would be
unrecognisable because disable-then-enable restores an earlier hash while changing nothing at all.

### 3. Live behaviour is gated, not the transition into it

P-4 validated a rule when it moved into `enabled`. That was the wrong hinge, and it left the larger hole
open — see [Defects found](#defects-found). The gate now fires whenever a request leaves a rule
**enabled with changed content**, whether it arrived there by activation, an edit, or a rollback.

Symmetrically, it does not fire when the request leaves the rule not-enabled. An operator fixing a
broken live rule by editing and disabling it in one call must not be blocked by a gate protecting live
events — after that call there are none.

### 4. Rollback restores content, not state, and never rewrites history

Rolling back to v3 produces v9 whose content equals v3's. Both the mistake and the correction stay in
the record, which is the only version of events an investigation can use.

`restore` is a separate store operation rather than an `update`, because **a patch cannot express
absence**: `UpdateRuleInput` omitting `condition` leaves the existing one in place, so a patch-based
rollback produces a rule that is the union of two versions and identical to neither — the worst outcome
for a feature whose whole promise is "put it back the way it was".

Lifecycle is deliberately not restored: putting old content back must not silently re-enable a rule
someone disabled, nor disable one someone is relying on.

**Rollback is instant when the rule is not live** — the target version carries its own scope expansion,
so nothing is recomputed and no other context is consulted. A **live** rule goes through the gate in
decision 3, which is a deliberate divergence from the Architect's "rollback must never require
recompilation": restoring content last verified an unknown time ago, against an estate that has changed
since, is exactly the situation the gate exists for, and "it used to work" is not a check.

### 5. Statistics are per-process, cost nothing per event, and outlive compilation

Counters are handed to the compiler as **objects**, so the engine increments a field on the compiled
rule it already holds — no map, no key building, no allocation in the loop that this whole design exists
to keep empty. The registry owns them so they survive a recompilation; if they lived on the compiled set
every number would reset every TTL and mean nothing.

Timing is taken only past the scope check: a rule the scope rejected did no work worth measuring, and
reading the clock for it would put two `performance.now()` calls per rule per event into the hot path.

They are **per node**. This node reports what this node did; cluster totals are what the Prometheus
counters are for. Summing these across a load balancer would produce a number that is wrong in a way
nobody could detect. A node that is not evaluating returns **501** rather than zeroes — an unstarted
engine and an idle one produce identical zeroes, and only one of them is worth paging about.

### 6. Budgets are enforced at validation, never during evaluation

A live rule that exceeds a newly-lowered limit keeps working. Refusing to evaluate it would convert a
configuration problem into a silent outage — strictly worse than the problem the limit was protecting
against.

The ceilings that matter are the ones with **no natural bound**. `RuleScope` already caps its arrays in
the schema; what was unbounded was the condition tree, which is recursive and arrives as JSON from a
client.

### 7. The simulation contract is frozen; half of it is implemented

Supplied-events simulation is **implemented**, because it is a dry-run over a list and there is no honest
reason to stub something already achievable. Replay over stored history returns **501**: the event
archive belongs to another context, and reaching into it from here deserves its own design rather than
arriving as a side effect of a rule feature. Freezing both shapes now means neither becomes a breaking
change.

### 8. Imported rules always land as drafts

A package is a file; a file arrives from somewhere. Activating rules that arrived from somewhere is how
an estate starts alerting on a configuration nobody in the room chose. Each imported rule comes back
with its validation report, so the references that did not survive the journey — a node id means one
place in the source tenant and nothing at all in the target — are visible before anyone enables it.

### 9. The explanation tree is a projection, not a second evaluation

Stages are assembled **once** and both the one-line summary and the tree are read off that list. Building
them separately is how a summary blaming the scope ends up beside a tree whose scope node is green — two
descriptions of one evaluation, with no way for a reader to tell which is lying.

The console now renders the server's tree rather than re-deriving which stage decided from the `stages`
booleans, removing a second copy of the ordering rule.

On a match **no** node is marked decisive, because every stage was.

## Defects found

Building this surfaced three defects in already-approved code. Each is fixed and covered by a test that
fails without the fix.

1. **Editing an enabled rule bypassed the activation gate entirely.** P-4 checked
   `patch.lifecycle === 'enabled' && current.lifecycle !== 'enabled'` — the transition only. An operator
   could re-scope a **live** rule to a deleted zone and the change was accepted. Worse, re-scoping drops
   the expansion by design, so the rule went `unresolved` and **matched nothing**: a live rule silently
   stopped firing, with nothing in the product saying so. Fixed by decision 3.

2. **Mongo `$set` never removed a field the domain had deleted.** `applyUpdate` deletes `resolvedScope`
   when a rule is re-scoped, precisely so the engine stops matching the zones the author just removed —
   but `$set` with an object that lacks a key leaves the stored key untouched. The old expansion stayed
   in the database and the rule kept firing on the old zones. Fixed with a paired `$unset`; the mapping
   is unit-tested, the round trip is covered by the integration suite.

3. **A deeply nested request body crashed the handler.** `RuleCondition` is a recursive Zod schema, so a
   deeply nested body overflowed the stack **inside the parser** — before validation, before the budget
   check, before anything could report it. Any authenticated author could do it. Fixed with an iterative
   depth guard that runs on the raw body before parsing; verified by disabling the guard and watching the
   test fail.

The first two share a shape worth naming: both are cases where the _correct_ domain behaviour was
defeated by the layer underneath it. The domain dropped the expansion; the store put it back. The domain
required validation; the caller found the one path that skipped it.

## Consequences

- **`RuleReferenceKind` gained `condition`.** The one deliberate enum extension, recorded rather than
  smuggled: budget issues are about the rule's own predicate tree, which is not a reference and had no
  honest home among the existing values. P-4 declared that set ahead of use specifically to avoid this,
  and the exercise missed one. Adding an enum value is not purely additive for a strict parser; the
  console and services ship from the same contracts package, so the exposure is an external API consumer
  pinned to an older schema.
- **A newly compiled rule is never the first thing evicted** from the stats registry. `lastEvaluatedAt`
  is `0` until a rule is evaluated, so eviction ranks on `max(lastEvaluatedAt, createdAt)` — otherwise a
  full registry would drop each new rule the instant it was added and it would never measure anything.
- **Warm-up never throws.** A failed optimisation must not fail the save that triggered it; the set is
  already invalidated, so the worst case is the behaviour before warm-up existed.
- **A rule that throws is a recorded failure, not a dropped event.** The engine counts it, logs it and
  keeps evaluating the rest — one defective rule must not silence a tenant's automation.
- **The dependency graph names authored references only.** A rule scoped to a site also covers the zones
  underneath it, but that is coverage, not a reference. The reverse lookup consults the resolved
  expansion as well and reports those matches as indirect, because "does anything cover this zone" and
  "does anything name it" are different questions and answering both with one set makes the smaller one
  wrong.

## Alternatives considered

- **Store compilation metadata on the rule.** Cheaper to read, and it can disagree with the rule it
  describes. Rejected in decision 1.
- **Write a dedicated audit collection.** What the recommendation literally asked for. Rejected in
  decision 1 — two records of one truth, and no retroactive history.
- **Extend `RuleVersionRecord.changeKind` with the new actions.** Would have made `rolled-back` explicit
  rather than derived, at the cost of a second non-additive enum change and a trail that only records
  rollbacks performed through one endpoint.
- **A `record(tenantId, ruleId, …)` metrics API.** The obvious shape, and it puts two hash lookups per
  rule per event into the hot path. Rejected for the counter-reference design in decision 5.
- **Reset counters on a version bump.** Defensible, and wrong in practice: an operator watching a rule
  they just edited wants to see it keep working, not a row that restarts at zero every time they touch
  it.
- **Enforce budgets during evaluation as well.** Rejected in decision 6 — it turns configuration
  problems into outages.
- **Return zeroed statistics when no engine is attached.** Rejected: indistinguishable from a rule that
  has never fired.
- **Absolute-time regression gates.** Rejected for ratio-based ones: a millisecond ceiling fails on a
  loaded CI runner and passes on a fast laptop while a quadratic regression sails through at small N.

## Implemented · Future Extension · Out of Scope

**Implemented:** compilation fingerprints · dependency graph and reverse lookup · evaluation budgets with
a pre-parse crash guard · per-rule runtime counters and cache observability · warm-up on write ·
structured stage tree · rollback · derived audit timeline (console: timeline + restore) · supplied-event
simulation · export/import · tenant-isolation regression suite · scale benchmark and ratio gate.

**Future Extension** (documented, none built): schedule and behaviour/composite dependency kinds (the
`RuleReferenceKind` values exist) · notification outputs as new `RuleAction` variants · replay simulation
over stored history · cluster-wide statistics aggregation · configurable per-deployment `RuleLimits`
(the contract takes them; only the default set is wired).

**Out of Scope:** a rule marketplace · cross-tenant packages · automatic rule migration between tenants ·
signing packages.
