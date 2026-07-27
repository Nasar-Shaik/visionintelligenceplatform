# HOW TO CONTINUE

> For any AI assistant or engineer resuming work. The canonical protocol is [`tracking/AGENT-ONBOARDING.md`](../../tracking/AGENT-ONBOARDING.md); this page is the quick operational version for day-to-day development.

## 1. Acquire context (5 minutes, every time)
1. [`docs/ai/PROJECT_BRAIN.md`](PROJECT_BRAIN.md) — the whole system in one page.
2. [`docs/project/CURRENT_SPRINT.md`](../project/CURRENT_SPRINT.md) — what sprint we're in and its slice.
3. [`tracking/PROGRESS.md`](../../tracking/PROGRESS.md) — where we are.
4. [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) → **Now** — the next actionable slice.
5. [`docs/ai/DEVELOPMENT_RULES.md`](DEVELOPMENT_RULES.md) — the rules you must not break.
6. The latest file in [`docs/daily/`](../daily/) — what the last session did and the "Next Task".

## 2. Do exactly one slice
- Pull the top **Now** item. Confirm no other agent owns it (PROGRESS). Mark it `in_progress` with `[name · date]`.
- Follow [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md): review architecture → contracts-first → implement → test → document.
- **Never** implement future slices. **Never** redesign the frozen architecture (change = ADR first).

## 3. Before you stop (Definition of Done)
- Code: type-safe, lint-clean, formatted, tested (unit + integration + scenario as applicable).
- Update: [`tracking/PROGRESS.md`](../../tracking/PROGRESS.md), [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md), [`docs/project/*`](../project/), and append a **daily log** ([`docs/daily/YYYY-MM/YYYY-MM-DD.md`](../daily/)).
- New package/service/plugin/module → add its `README.md` (self-documenting rule).
- Architectural decision made → write an **ADR** and update the affected `docs/architecture/NN-*.md`.
- Commit per [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Do **not** start the next sprint without approval.

## 4. If blocked / ambiguous
Record it in [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) → Needs-Decision (with options + recommendation) and in [`docs/project/KNOWN_ISSUES.md`](../project/KNOWN_ISSUES.md); draft an ADR if it's architectural; then pick the next unblocked slice. Never invent a customer workflow to unblock.

## Golden invariant
The repository must be **self-sufficient**: anyone can clone it, read these docs, and continue — with no access to prior chats. If something needed is missing, adding it **is** the task.
