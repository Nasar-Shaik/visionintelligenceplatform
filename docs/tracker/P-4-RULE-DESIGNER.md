# P-4 — Rule Designer

**Status:** ✅ **ACCEPTED** (Architect, 2026-08-03) — 15 recommendations folded into
[P-4.1](P-4.1-RULE-OPERATIONS.md), which also corrects two defects in what was approved here.
**Authorized:** 2026-08-03 (Architect, P-4 authorization)
**Layer:** Product Capability — built on six frozen foundations, redesigning none of them.

---

## What this is for

A customer with forty sites wants loitering to matter at the London docks and nowhere else. Until
P-4, every rule applied to the entire tenant.

This is also the first slice to **consume the Location Hierarchy** frozen in P-3 — the test of whether
that freeze holds. It did: **no hierarchy contract, route or index changed.**

---

## Implemented

### Contracts (`@vip/contracts`, additive)

| Addition                                       | Purpose                                                    |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `RuleScope`                                    | Authored intent: node ids (any level) + camera ids.        |
| `ResolvedRuleScope`                            | The expansion to leaf ids, snapshotted on the version.     |
| `Rule.scope` · `Rule.resolvedScope`            | Additive, defaulted — a pre-P-4 rule stays tenant-wide.    |
| `RuleValidationReport` · `RuleValidationIssue` | `valid` **and** `verified`, with per-issue codes.          |
| `RuleReferenceKind`                            | Closed set, declared ahead of the checks that will use it. |
| `ConditionTrace` · `RuleExplanation`           | Per-node outcomes and the stage that decided.              |
| `RuleDryRunResult.explanation`                 | The full trace, alongside the original booleans.           |

### Rules service

- **`domain/scope.ts`** — `compileScope` · `matchesScope` · `explainScope` · `scopeOf`. Pure, O(1),
  and structurally unable to query.
- **`domain/explain.ts`** — `explainCondition` (reusing `evaluatePredicate`) · `firstFailure` ·
  `explain`.
- **`domain/validation.ts`** — `selfChecks` · `referenceChecks` · `validateRule` ·
  `permitsActivation`.
- **`application/compiled-rules.ts`** — `compileRules` + `RuleSetCache` (TTL, coalesced misses,
  bounded, oldest-first eviction).
- **Ports** — `HierarchyProvider`, `CameraDirectory`, both defaulting to **unavailable**.
- **Gate** — enabling validates and resolves in one version bump.
- **Route** — `GET /rules/:id/validation`.

### Console

`RuleScopeField` (reusing the P-3 `LocationPicker`) · `RuleValidationPanel` · `RuleExplanationView`,
wired into the rule editor. `renderWithProviders` gained a `path` option so route-param pages can be
tested at all.

---

## The five decisions

Recorded in full in [ADR-0026](../adr/ADR-0026-rule-scope-validation-and-explainability.md).

1. **Scope is authored as nodes, evaluated as a set**, expanded at validation and stored on the
   version.
2. **The hierarchy is reached through a port, at validation time only** — a bounded, recorded
   exception to boundary rule 4.
3. **A check that could not run is not a check that passed.**
4. **Explanations reuse the interpreter** and report the **first** failing stage.
5. **Rules are compiled per tenant**, so evaluating an event touches no store.

---

## Tests

| Area                       | Where                    | What it protects                                      |
| -------------------------- | ------------------------ | ----------------------------------------------------- |
| Scope matching             | `scope.test.ts`          | Zones, cameras, tenant-wide, no-location, unresolved  |
| Explanation                | `scope.test.ts`          | Agrees with the interpreter on every node             |
| Stage attribution          | `scope.test.ts`          | First failure decides, not the last                   |
| Validation                 | `scope.test.ts`          | Missing/archived location, missing camera, unverified |
| Activation gate            | `rule-service.test.ts`   | Cannot enable unverified; can always disable          |
| Scope snapshot             | `rule-service.test.ts`   | Expansion lands on the immutable version              |
| Re-scoping                 | `rule-service.test.ts`   | Old expansion dropped, not carried forward            |
| Zero per-event queries     | `compiled-rules.test.ts` | 1,000 events → **one** store call                     |
| Burst coalescing           | `compiled-rules.test.ts` | 100 concurrent misses → one query                     |
| Console scope + validation | `rules.test.tsx`         | Resolved labels; valid ≠ verified                     |

**Rules 76 · console 106.**

---

## Future Extension

Documented, none built: schedule references and time-of-day scoping · behavior/composite reference
checks · notification outputs (webhook · REST · SMS · email · WhatsApp · MQTT · Kafka · Event Hub ·
SNS) as new `RuleAction` variants · simulation and offline replay · per-rule metrics.

## Out of Scope

A visual condition builder · rule templates · cross-tenant rules · rule chaining · ML-suggested
thresholds.

## Known Limitation

**A scope expansion goes stale** when zones are added beneath a scoped node after validation. Visible
(`resolvedAt`) and one click to fix; the eventual answer is a hierarchy-change subscriber on the event
backbone, blocked on [TD-6](../../tracking/TECH-DEBT.md).

## Technical Debt

**[TD-21](../../tracking/TECH-DEBT.md) — the rule editor cannot be saved in edit mode.** Lifecycle and
severity `Select`s fail form validation, so the PATCH never fires. **Pre-existing**: reproduced against
the pre-P-4 editor. Possibly a jsdom/Radix artifact — determining that is the first step. Found while
building P-4, not caused by it.

## A defect the e2e suite caught

Cache invalidation was **built but never wired**: a rule an operator had just created stayed invisible
to the engine until the compiled set expired — "saved", then nothing happens for seconds, which reads
as a broken product. Unit tests passed; the replay-determinism e2e test failed, because it seeds a
rule and emits an event per scenario rather than seeding everything up front.

Fixed by an `onRulesChanged` **callback** rather than a dependency: the authoring service must not know
an evaluation cache exists, and the composition root is the one place that knows both.

## Paid down

**[TD-7](../../tracking/TECH-DEBT.md) (second half)** — the engine no longer issues a `listEnabled`
query per event.

## Corrected in P-4.1

Two defects in this slice were found while building [P-4.1](P-4.1-RULE-OPERATIONS.md) and are fixed
there: the activation gate checked only the _transition_ into `enabled`, so editing a live rule was
unchecked and re-scoping one silently took it to matching nothing; and the Mongo write used `$set`
alone, so the `resolvedScope` this slice deliberately deletes on a re-scope survived in the database.

## Related

- [ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md) · [P-4.1](P-4.1-RULE-OPERATIONS.md)
- [ADR-0026](../adr/ADR-0026-rule-scope-validation-and-explainability.md) · [CONSTRAINTS §43–45](../project/CONSTRAINTS.md)
- [HIERARCHY_FOUNDATION_V1](../architecture/HIERARCHY_FOUNDATION_V1.md) — consumed, unchanged.
- [FOUNDATIONS](../project/FOUNDATIONS.md) · [PRODUCT_PRINCIPLES](../project/PRODUCT_PRINCIPLES.md)
