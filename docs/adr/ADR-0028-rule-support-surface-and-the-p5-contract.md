# ADR-0028 — The rule support surface: compose the artifact, band the complexity, never score what was not checked

- **Status:** Accepted
- **Date:** 2026-08-03 · **Accepted:** 2026-08-03 (Architect decision, P-4.1 approval + 15 recommendations)
- **Deciders:** Principal Architect + development
- **Touches:** `@vip/contracts` (`RuleComplexityClass`/`RuleComplexityReport`, `RuleHealth*`, `RuleDiff*`, `RuleStatsBucket`/`RuleStatsHistory`, `RuleDiagnosticPackage`, `RuleIncidentContext`, `RuleDiagnosticRow`/`Query`/`SearchResult`, `DependencyStatus`, `RuleImportInput`/`ConflictPolicy`/`Outcome`, `RulePackage.engineVersion`/`schemaVersion`); `services/rules` (`domain/health.ts`, `domain/diff.ts`, `classifyRule`, history ring in `rule-stats.ts`, `transport/routes/rule-authoring.ts` + `rule-operations.ts` + `rule-plane.ts`); `apps/console` (rule health panel, version comparison). Relates to [ADR-0027], [ADR-0026], [CONSTRAINTS §41, §44, §46–51], [P-5-ARCHITECTURE-VALIDATION](../tracker/P-5-ARCHITECTURE-VALIDATION.md).

## Context

P-4.1 was approved with fifteen recommendations. Where P-4.1 built the diagnostic **pieces**, these ask
for the **artifact**: one download for support, one verdict for an operator, one diff for a reviewer,
one contract for P-5, and enough compatibility checking that a package cannot be reinterpreted by the
wrong engine.

The pieces already existed. What was missing was composition — and the specific failure that fixes is
the one where a support engineer gathers six endpoints by hand at 2 a.m., which is to say does not.

## Decision

### 1. One artifact, composed from the parts, absent where it does not know

`GET /rules/:id/diagnostics` returns the rule, its compilation fingerprints, its validation report, its
complexity, its health, its dependency graph **with status**, every version, the derived audit
timeline, and this node's runtime counters and trend.

Every part is an immutable record or a pure function of one, so the same rule at the same version
produces the same package — apart from the runtime sections and the timestamp, which describe _this
node right now_ and are labelled as such.

The runtime sections are **absent, not zeroed**, when the node does not evaluate. Zeroes and "no data"
are different facts and only one of them is worth acting on — the same rule `/rules/stats` follows by
returning 501.

**It carries no explanation trace, deliberately.** An explanation is per-event and a rule has no event.
The condition _structure_ is there; a trace is a `simulate` call away once a caller has an event.
Inventing one would make this artifact's most-read section its least trustworthy.

### 2. A health score that can be taken apart, or no score at all

`RuleHealth` is a status, a 0–100 score, and **the list of findings whose deductions sum to
`100 - score`**. The number is computed from the list, so the two cannot disagree.

The failure this avoids is specific: a rule sits at 78, everyone learns 78 is normal, and a real
problem hides behind it. A score nobody can reconstruct is a score people stop reading.

⚠️ **`unknown` beats a confident guess.** When validation could not verify its references, the status
is `unknown` and the score is not offered — the same rule as `RuleValidationReport.verified`
([CONSTRAINTS §44](../project/CONSTRAINTS.md)), one layer up. A `0/100` beside "cannot be checked"
would read as "this rule is broken", which is a different and wrong claim.

### 3. Complexity is relative to the deployment, and bands on the worst dimension

"40 condition nodes" means nothing to an operator who does not carry the ceiling in their head. The
classification is a function of `RuleComplexity` **and** the deployment's `RuleLimits`, so it moves when
the limits move — a rule is complex with respect to something.

It bands on the **worst** dimension, never an average. A rule with one leaf condition and 4,900 covered
zones is not simple, and averaging would say it was.

### 4. Dependency status is opt-in, and `unknown` is a real answer

`GET /rules/:id/dependencies?status=true` calls the owning contexts; without it the graph is structural
and says `statusChecked: false`. A caller rendering two hundred rules must not pay a cross-context call
per rule.

Anything the platform cannot answer for is **`unknown`**, never `resolved`. "Nothing is broken" and
"nobody looked" must never be the same response — this is §44 applied to a graph instead of a report.

**The dependency hash excludes status.** A zone being deleted does not change what a rule points at,
and a fingerprint that moved would say the rule had been edited.

### 5. History is a shift, not a time series

A bounded ring of 24 hourly buckets per rule, on the counter itself so it dies with the rule it
describes. Buckets close at compile and read time, **never per event**.

⚠️ It answers _"has this rule gone quiet since lunchtime?"_ — one node, one shift. Capacity planning
and anything spanning replicas comes from the Prometheus pipeline, which stores history properly.
Building a second, worse time-series database here was the available mistake; per-rule labels are
deliberately not exported to Prometheus because cardinality is the reason, and a bounded ring is the
cheaper honest answer.

### 6. A diff over snapshots, and conditions compared as a set of leaves

`RuleDiff` reads the two immutable snapshots, so any pair in the history works — including versions
written long before this existed.

Conditions are compared as a **set of leaves** rather than structurally. A structural diff of a
recursive tree produces "the third child of the second `all` changed", which is accurate and unreadable.
The rare case where only the boolean shape moved is caught separately and reported in words.

`behaviourUnchanged` comes from the content hash, so "renamed, nothing else" is one glance.

### 7. The plane split is structural, and the paths do not move

Routes are now `rule-authoring.ts` (make and change a rule) and `rule-operations.ts` (find out about
one), with a third plane — the runtime — that is a bus consumer and has no HTTP surface at all.

⚠️ **No path was renamed.** The recommendation asked for separated APIs; renaming published routes
breaks every consumer, every stored integration and every runbook in exchange for tidier prose, which
[CONSTRAINTS §41](../project/CONSTRAINTS.md) forbids for exactly that trade. A test asserts every
published path still resolves. If the planes ever need separate prefixes, that is an ADR with a
migration path — not a refactor.

The same reasoning kept `POST /rules/import` taking a bare `RulePackage` body, with the new conflict
policy arriving as a query parameter. Wrapping the body would have been tidier and would have broken
every existing caller.

### 8. An incompatible package imports nothing

Compatibility is checked at **major** precision on package format, compiler, engine and rule schema —
a minor bump is additive by the platform's own rule ([CONSTRAINTS §42](../project/CONSTRAINTS.md)), so
an older package still parses. Absent version fields mean "written before the field existed", which is
compatible by construction.

A mismatch stops **everything**. Partial imports are fine for a broken _rule_ and not for a broken
_package_: an operator left holding half an import has to decide which half to trust, and a rule
silently reinterpreted by a newer engine imports cleanly, validates cleanly, and does something other
than what it did where it came from.

**Name conflicts skip by default.** Re-importing a package twice must not silently double a tenant's
rule set — a mistake that stays invisible until every incident arrives twice.

### 9. The P-5 contract is a projection, frozen now

`GET /rules/:id/incident-context?version=` returns what Incident Management needs in one call and one
shape. Every field was already reachable; this exists so P-5 depends on one contract instead of five and
so that building it requires no change here.

**It answers for the version the incident was raised by, not today's rule** — showing an investigator a
configuration that did not exist when the incident happened is the failure the immutable versions were
built to prevent. The rule's _current_ lifecycle is reported alongside, because an investigator needs
both.

## Consequences

- **The support artifact and the search row are deliberately different shapes.** Building the full
  package per rule to render a list would be a few hundred cross-context calls; `searchDiagnostics`
  resolves dependency status **once for the whole tenant** and a test asserts ten rules cost one
  hierarchy call.
- **Diagnostic search orders worst-first.** A diagnostic list is read from the top and the top should
  be the problem.
- **The console renders the server's verdicts rather than re-deriving them** — health findings, diff
  summaries, decisive stages. Every re-derivation is a second implementation that eventually disagrees.
- **A version comparison is fetched only when opened.** A timeline of forty versions must not be forty
  requests.
- **`RuleStatsHistory` is lost on restart and says so.** `coversSeconds` shorter than the window is the
  signal.

## Alternatives considered

- **Store the diagnostic package.** It would make "immutable artifact" literal, and it would be a
  second copy of six things that can each be recomputed — able to disagree with all of them. Rejected
  for the same reason as ADR-0027 decision 1.
- **A bare health score with no findings.** Rejected in decision 2; it is the version of this feature
  that stops being read.
- **Averaging complexity across dimensions.** Rejected in decision 3 — it calls a 4,900-zone rule
  simple.
- **Checking dependency status always.** Rejected in decision 4: it turns a list view into a load test
  on another context.
- **A real per-rule time series.** Rejected in decision 5 — Prometheus already does this properly, and
  the second one would be worse and permanent.
- **A structural condition diff.** Rejected in decision 6 as accurate and unreadable.
- **Prefixing the planes (`/authoring/rules`, `/operations/rules`).** What rec 9 literally suggests, and
  a breaking change to every consumer for a naming improvement — §41.
- **Extending `IncidentStatus` here to pre-build P-5's lifecycle.** Out of scope and not this context's
  contract; recorded as G-1 in the validation pass instead, awaiting approval.

## Implemented · Future Extension · Out of Scope

**Implemented:** diagnostic package · health with named deductions · complexity classification ·
dependency status · bounded stats history · version diff · plane split · package signature and
compatibility · conflict-aware import with a structured report · diagnostic search · the frozen P-5
incident context · console health panel and version comparison.

**Future Extension** (documented, none built): behaviour and composite dependency kinds ·
cluster-wide statistics aggregation · configurable per-deployment `RuleLimits` (the contract takes
them; only the defaults are wired) · signed packages · replay simulation over stored history.

**Out of Scope:** a rule marketplace · cross-tenant packages · automatic id remapping on import ·
a diagnostics store.

**Known Limitation:** `RuleStatsHistory` covers one node and one day, is lost on restart, and
attributes everything in a gap between rolls to the first bucket of that gap. Stated in the contract,
not discovered.
