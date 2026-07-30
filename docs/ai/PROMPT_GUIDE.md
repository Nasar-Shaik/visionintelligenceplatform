# PROMPT GUIDE

> How to instruct an AI assistant (or brief yourself) to work on this repo effectively and safely.

## The minimal effective prompt

> "Read `docs/ai/PROJECT_BRAIN.md`, `docs/tracker/MASTER_PROGRESS.md`, and `tracking/TASK-BOARD.md`. Continue the current sprint's next slice only. Follow `docs/ai/DEVELOPMENT_RULES.md`. Explain your plan, implement one slice production-ready with tests + docs, update the trackers and a daily log, then stop and report."

## Always tell the assistant to

- Treat the **repo as the only source of truth** (no reliance on past chats).
- Respect the **frozen v1.0 architecture** — change only via ADR.
- Work **one slice at a time**; never implement future slices; wait for approval before the next sprint.
- Keep **no industry logic in the core** (verticals → `plugins/`).
- Produce **tests + documentation + daily log** as part of "done".

## Good task framings

- "Implement TASK-BOARD item **P0-2** (contracts bootstrap) per the plan; contracts-first; add contract tests."
- "Scaffold `services/identity` using the service template in `IMPLEMENTATION_GUIDE.md`; health/ready/metrics; no business logic yet."

## Anti-patterns (reject these)

- "Add supermarket theft detection to the core." → belongs in `plugins/retail`.
- "Swap the event backbone / framework." → needs an ADR first.
- "Build phases 3–6 now." → one slice at a time.

## After the assistant finishes, expect

The Final Report (summary, files created/modified, commands, test results, remaining work, risks, tech debt, suggested next sprint) and updated trackers + daily log.
