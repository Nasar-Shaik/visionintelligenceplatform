# The rule artifact lifecycle

**Governance documentation** (P-4.2, Architect rec 10). Describes what already exists; introduces
nothing.

A rule passes through more states than its `lifecycle` field names, because some of them are not states
at all — they are things that happen _to_ a rule. This document separates the two, because conflating
them is how a state machine grows a state that is really an event and then cannot be reasoned about.

---

## The two axes

**Lifecycle** is persisted on the rule and governs whether it is evaluated. Five values, exhaustive:

```
draft ──► validated ──► enabled ⇄ disabled ──► archived
  ▲                                               │
  └───────────────────────────────────────────────┘
                    (restored)
```

**Operations** are things that happen to a rule at some lifecycle state. They are not stored as states,
because they are not states:

```
   validate      compile        resolve scope       warm
   (any time)    (per node,     (at validation,     (after any
                 on demand)      snapshotted)        write)

   export ──► import ──► (lands as draft)      rollback ──► (new version, same lifecycle)
```

---

## Lifecycle, precisely

| State       | Evaluated? | What it means                                                                | How it is left                          |
| ----------- | ---------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| `draft`     | no         | Being written. May be incomplete or invalid.                                 | edited, enabled, archived               |
| `validated` | no         | An authoring stage. ⚠️ **Not a guarantee** — see below.                      | enabled, edited back to draft, archived |
| `enabled`   | **yes**    | Live. Compiled into the tenant's rule set and evaluated against every event. | disabled, archived                      |
| `disabled`  | no         | Paused, intact. The common way to stop a rule without losing it.             | enabled, edited, archived               |
| `archived`  | no         | Retired, retained for audit.                                                 | restored to any non-archived state      |

⚠️ **`validated` is an authoring stage, not a certificate.** The check that matters happens at the
transition into `enabled` and on every edit _while_ enabled — nothing trusts a stored `validated`
state, because the edit that invalidates a rule can arrive in the same request that enables it
([ADR-0026](../adr/ADR-0026-rule-scope-validation-and-explainability.md), corrected in
[ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md)).

### What is gated

| Transition                                     | Gated?                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| anything → `enabled`                           | ✅ validated, and the scope resolved in the same version      |
| `enabled` → `enabled` **with content changed** | ✅ same gate — this is the P-4.1 correction                   |
| `enabled` → `disabled` / `archived`            | ❌ never — a broken rule must always be stoppable             |
| edit **and** disable in one request            | ❌ not gated — afterwards there are no live events to protect |
| rollback of a rule that is not live            | ❌ not gated — instant, no other context consulted            |
| rollback of a **live** rule                    | ✅ same gate as any live edit                                 |

---

## Operations

### Validate

On demand (`GET /rules/:id/validation`) and automatically at every gated transition. Reports `valid`
**and** `verified` separately: a check that could not run is not a check that passed
([CONSTRAINTS §44](../project/CONSTRAINTS.md)).

### Compile

Per node, on demand, into the tenant's compiled rule set. **Not a lifecycle state and never persisted**
— a compiled set is a cache with a TTL, and the same rule version compiles identically on every node,
which is what `RuleCompilation`'s fingerprints let you verify.

### Resolve scope

The authored node ids expand to leaf zone ids **at validation**, and the expansion is snapshotted onto
the immutable version. Never recomputed on read; recomputing would rewrite what a historical incident's
rule covered.

### Warm

After any write, the tenant's rule set is invalidated **and recompiled immediately**, so the first live
event does not pay the compilation. Never throws — a failed optimisation must not fail the save.

### Export → import

An export carries authored content plus each rule's dependencies and the versions it was built against.
An import checks compatibility at major precision, refuses the **whole package** on a mismatch, skips
name conflicts by default, and lands everything as **`draft`** regardless of the state it was exported
in.

### Rollback

Restores an earlier version's **content** as a **new** version. History is appended to, never
rewritten: rolling back to v3 produces v9. Lifecycle is deliberately not restored.

---

## Where history lives

**One record.** Every change writes an immutable `RuleVersionRecord` with a full snapshot, and
everything else is derived from it:

| Question                        | Answered by                            | Derived from          |
| ------------------------------- | -------------------------------------- | --------------------- |
| What did this look like at v3?  | `GET /rules/:id/versions`              | the record itself     |
| What happened to this rule?     | `GET /rules/:id/audit`                 | the versions          |
| What changed between v3 and v4? | `GET /rules/:id/diff?from=3&to=4`      | the two snapshots     |
| Was this a rollback?            | the audit entry's `rolled-back` action | content-hash equality |
| Is this the rule we signed off? | `GET /rules/:id/compilation`           | recomputed hashes     |

There is no second audit trail, no stored diff and no stored fingerprint. Two records of one truth
eventually disagree, and a derived trail works retroactively on rules written before anyone thought to
record it ([CONSTRAINTS §46](../project/CONSTRAINTS.md)).

---

## Related

- [ADR-0026](../adr/ADR-0026-rule-scope-validation-and-explainability.md) — scope, validation, explainability
- [ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md) — derived diagnostics, the live-edit gate, rollback
- [ADR-0028](../adr/ADR-0028-rule-support-surface-and-the-p5-contract.md) — the support artifact and the P-5 contract
- [RULE_ENGINE_BASELINE](RULE_ENGINE_BASELINE.md) · [10-RULE-ENGINE](10-RULE-ENGINE.md)
