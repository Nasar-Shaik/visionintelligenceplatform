# @vip/service-rules

The rule engine (Phase 1, **P1-7**) — the automation brain that decides "this matters." Grounds:
[RULE_ENGINE](../../docs/architecture/phase1/RULE_ENGINE.md),
[10-RULE-ENGINE](../../docs/architecture/10-RULE-ENGINE.md),
[23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md) (Rule Context).
Distinct from the Policy Engine ([ADR-0013](../../docs/adr/ADR-0013-policy-engine.md)): rules = **IF
event THEN action** (business triggers); policy = who/what/where/when governance.

## What it does

```
event.persisted (t.*.event.>)  ──▶  rules: evaluate vs enabled rules  ──▶  t.*.incident.candidate
                                          │  (sandboxed predicate DSL)          t.*.rule.matched
                                          └──▶ windowed state (≥N within W)
```

- **Consumes only the `EventEnvelope`** (never `DetectionResult` — perception and automation stay
  decoupled). Loops are impossible by construction: it consumes `event.*` and publishes to the
  distinct `incident.*` / `rule.*` roots.
- **Evaluation is a pure, sandboxed predicate tree** (`all`/`any`/`not` + field/op/value leaves) — data,
  not code: no regex, no `eval`, no I/O, prototype-pollution-safe field access. Deterministic, so
  replay reconstructs the same decisions.
- **Evaluation is separate from incident creation** (distinct domain modules) — a match does not imply
  an incident.
- **Optional windowed threshold** ("≥ N matching events within W seconds", grouped by camera/zone),
  backed by bounded tenant-scoped state.
- Emits **`incident.candidate`** (promoted by the alert engine, P1-8) + **`rule.matched`** (audit).
- **Rules are versioned + audited** (every change snapshots to `rule_versions`) and carry an explicit
  **lifecycle** (`draft`/`validated`/`enabled`/`disabled`/`archived`) + **priority** — only `enabled`
  rules are evaluated, in priority order.
- **Evaluation metrics** (events consumed / rules evaluated / matched / candidates / latency) on `/metrics`.

## HTTP API (control plane, via gateway)

| Method | Endpoint                          | Purpose                                           | Auth          |
| ------ | --------------------------------- | ------------------------------------------------- | ------------- |
| POST   | `/rules`                          | Create a rule (versioned)                         | `rule:create` |
| GET    | `/rules` · `/rules/:id`           | List / get (tenant-scoped)                        | `rule:read`   |
| GET    | `/rules/:id/versions`             | Audit trail (newest first)                        | `rule:read`   |
| POST   | `/rules/:id/dry-run`              | Test against a sample event — **no side effects** | `rule:read`   |
| PATCH  | `/rules/:id`                      | Update (version bump + audit)                     | `rule:update` |
| DELETE | `/rules/:id`                      | Remove (final `deleted` audit snapshot)           | `rule:delete` |
| GET    | `/health` `/ready` `/metrics` `/` | infra (`/ready` = Mongo)                          | —             |

## Config (`@vip/config`, `.env` only)

`MONGO_URI` (rule store) · `NATS_URL` (backbone) · `JWT_SECRET` · `RULES_MAX_PER_EVENT` (default 1000) ·
`RULES_CANDIDATE_DEDUP_WINDOW_MS` (default 60000) · `PORT` (default 8086).

## Tested

35 tests — the sandboxed condition interpreter (operators, dotted paths, prototype safety, composites),
rule evaluation + ordering, CRUD + versioning/audit + dry-run, the engine end-to-end on the in-memory
bus/store/state (match → candidate + rule.matched, windowed threshold, lifecycle gating, tenant
isolation, fail-closed dead-lettering), the permission-gated + tenant-scoped HTTP routes, and a
**real-MongoDB integration** (versioning, enabled-rules query, guarded reads; skip-if-unreachable).

> **Windowed state is in-process (Phase 1)** — a Redis-backed store is the horizontal-scale swap behind
> the same port; state is re-derivable from event replay ([TD-7](../../tracking/TECH-DEBT.md)).
