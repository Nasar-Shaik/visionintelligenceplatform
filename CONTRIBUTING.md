# Contributing & Git Workflow

> How work flows through this repository. It exists because — although one human owns this project — **many engineers and AI agents will commit to it over time**. Consistent branches, commits, and merge discipline are what let the git history stay a reliable record that any agent can read cold. This complements [`tracking/AGENT-ONBOARDING.md`](tracking/AGENT-ONBOARDING.md) (which governs *what* to work on); this document governs *how it lands in git*.

Everything here is subordinate to the [Engineering Constitution](docs/00-ENGINEERING-CONSTITUTION.md).

---

## 1. Branch model

`main` is **always releasable** — it must always build and pass CI. Never commit directly to `main`; land changes through a short-lived branch.

| Branch | Purpose | Example |
|---|---|---|
| `main` | Always-green trunk; the source of releases | — |
| `feature/<scope>-<short-desc>` | New capability/feature/doc work | `feature/contracts-bootstrap` |
| `fix/<scope>-<short-desc>` | Bug fix | `fix/events-dedup-key` |
| `chore/<short-desc>` | Tooling/infra/deps, no product change | `chore/ci-import-graph` |
| `docs/<short-desc>` | Docs/tracking/ADR only | `docs/adr-0006-streaming` |
| `refactor/<scope>-<short-desc>` | Behavior-preserving restructure | `refactor/pipeline-scheduler` |

- Keep branches **short-lived** (hours–days). Rebase on `main` before merging; prefer a linear history.
- `<scope>` is a repo area: `services`, `ai`, `edge`, `packages`, `plugins`, `infra`, `tests`, `tools`, `docs`, `tracking`, or a specific service/capability (`events`, `rules`, `identity`, …).
- `feature/v1` (current) is fine as an integration branch for the initial build-out; cut narrower branches off it as the codebase grows.

## 2. Commit conventions ([Conventional Commits](https://www.conventionalcommits.org/))

```
<type>(<scope>): <imperative summary ≤72 chars>

<body: what & why, not how; wrap ~72 cols>

<footer: refs, breaking changes, ADRs>
```

**Types:** `feat` · `fix` · `docs` · `chore` · `refactor` · `test` · `perf` · `build` · `ci`.

**Examples:**
```
feat(events): add dedup + correlation on ingest

Collapses repeat detections into one event via (type,track,zone,bucket)
keys before the rule engine sees them. Prevents alert storms.

Refs: TASK-BOARD P4-x · docs/architecture/09-EVENT-PLATFORM.md
```
```
docs(adr): ADR-0006 choose Redpanda for the event backbone
```

**Rules**
- Imperative mood ("add", not "added"). One logical change per commit.
- Reference the driving task and any ADR/section in the footer, so history links back to intent.
- **Breaking a published contract** → add `BREAKING CHANGE:` in the footer **and** an ADR (see §5).
- If an AI agent authored the change, keep the tool's attribution trailer (e.g. `Co-Authored-By:`) — it's the only record of which agent touched what.

## 3. Merge flow (solo-tuned)

Branch protection is intentionally **off** (single owner). Discipline replaces enforcement:

- **Small/mechanical changes:** commit on a branch, ensure CI is green, fast-forward/squash-merge into `main`.
- **Anything non-trivial** (new capability, contract change, cross-cutting refactor): open a **PR into `main`** even solo — the PR template is your pre-merge checklist and leaves a reviewable record for the next agent. Self-review, confirm CI green, then squash-merge.
- **Squash-merge** feature branches (one coherent commit on `main`); delete the branch after.
- Never merge red CI into `main`. If `main` ever goes red, fixing it is priority zero.

> When you later add collaborators, turn on branch protection (require PR + green CI) — nothing else about this workflow changes.

## 4. Definition of Done (gate for every merge)

A change is mergeable only when it satisfies **[AGENT-ONBOARDING §5](tracking/AGENT-ONBOARDING.md#5-definition-of-done-every-task)**. In short:
- [ ] Contract added/updated & versioned (if applicable); implementation matches it.
- [ ] **No core dependency on any plugin**; no industry/customer logic in the core (Law 1).
- [ ] Tenant isolation preserved; isolation test for any new data path.
- [ ] Unit/integration tests pass; new behavior covered.
- [ ] Observability on new paths (metrics/traces/logs).
- [ ] No secrets, no PII in logs, no hardcoded tenant/customer/model constants.
- [ ] **Docs & tracking updated** — `PROGRESS.md`, `TASK-BOARD.md`, and an ADR if a decision was made.

## 5. Architecture changes: ADR before code

Any change to a **contract, boundary/dependency rule, technology, or principle** requires an ADR **first** ([docs/adr](docs/adr/)): write the ADR (`Proposed`), update the affected `docs/architecture/NN-*.md`, then implement. Code must never embody a decision no ADR records. Docs must never describe a system that doesn't exist.

## 6. Keeping tracking honest

Because agents start cold, the git history alone is not enough — update the living state every session:
- Move the item's status in [`tracking/TASK-BOARD.md`](tracking/TASK-BOARD.md) and [`tracking/PROGRESS.md`](tracking/PROGRESS.md).
- Add follow-up tasks you discovered; record landmines in `PROGRESS.md`.
- Tick milestone gates in [`tracking/MILESTONES.md`](tracking/MILESTONES.md) with evidence when passed.
- Sign tracking edits `[<agent/name> · YYYY-MM-DD]`.

## 7. What CI enforces (as pipelines land in Phase 0)

- Build + unit/contract/integration tests.
- **Import-graph checks**: no `core → plugin` dependency; no capability↔capability internal imports (Constitution §6).
- SAST / dependency / secret scanning; no secrets committed.
- **Model CI** (benchmark + FP/FN gates) for AI changes before registry promotion.
- Isolation tests (cross-tenant access must fail-closed).

Green CI is a precondition for merge — see §3.

## 8. Never commit

Secrets/keys/`.env` (use the vault — [15 §4](docs/architecture/15-SECURITY-ARCHITECTURE.md)), model weights/datasets (they belong in the registry/object storage), build artifacts, `.DS_Store`. The root [`.gitignore`](.gitignore) covers these — don't override it to force-add any of them.

## Cross-references
[tracking/AGENT-ONBOARDING.md](tracking/AGENT-ONBOARDING.md) · [docs/00-ENGINEERING-CONSTITUTION.md](docs/00-ENGINEERING-CONSTITUTION.md) · [docs/adr/](docs/adr/) · [.github/pull_request_template.md](.github/pull_request_template.md)
