# Product Polish Backlog

> **Craft, not debt.** The things that make the product feel finished — wording, spacing, motion,
> consistency, discoverability, the last mile of accessibility. Consumed continuously during
> implementation, a few items per milestone, never as a milestone of its own.

## What belongs here, and what does not

This register exists because "polish" was being written into
[TECH_DEBT](../../tracking/TECH-DEBT.md), where it competed with correctness and always lost. The
split is by **who notices**:

|                                                                       |                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Here** — a customer notices                                         | Wording, spacing, typography, motion, consistency, discoverability, accessibility beyond the compliance floor |
| **[TECH_DEBT](../../tracking/TECH-DEBT.md)** — an engineer notices    | Shortcuts, missing indexes, in-memory state, untested paths, deferred wiring                                  |
| **[KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md)** — a customer is blocked | A capability that is absent. ⚠️ If an item here blocks work rather than annoying, it belongs there instead    |

Three rules:

- ⚠️ **Nothing lands here from an opinion.** Every item names where it was observed — a viewport, a
  page in the deployment, a screen-reader pass. "This would look better" is not an entry.
- ⚠️ **An item that changes behaviour is not polish.** Auto-collapsing the sidebar on a phone was
  proposed as polish and is a design change (P-6); it is tracked as work, not here.
- **Closed items stay, with what fixed them.** The list of what was already noticed is how a reader
  tells a maintained surface from a neglected one.

---

## Open

Ranked by what a customer notices first, which is not the order they are cheapest to fix.

| ID    | Area            | What                                                                                                                                                                                                                                                                                    | Observed                                                    | Size |
| ----- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| PB-1  | consistency     | **Severity and status use two different encodings side by side.** Severity is a coloured dot + word; status is a filled pill. Adjacent columns, both single-value enums. Pick one and apply it everywhere                                                                               | Incidents and Events tables, 1440 px, deployment 2026-08-04 | S    |
| PB-2  | layout          | **Vertical dead space on half the pages.** Dashboard, Cameras, Incidents and Settings stop between half and two-thirds down a 900 px viewport. Reads as unfinished rather than uncluttered. Cheapest fix: let the primary table grow                                                    | 4 pages at 1440×900, deployment 2026-08-04                  | S    |
| PB-3  | wording         | **Empty states describe the absence, not the next step.** "No events match" is true and useless. Linear's equivalent tells you what to do. Every `EmptyState` with an available action should offer it                                                                                  | `EmptyState` call sites across 8 pages                      | M    |
| PB-4  | discoverability | **Density and filter state are not remembered.** The Events table's comfortable/compact toggle resets on every navigation. An operator sets it once per shift and loses it on every page change                                                                                         | `/events`, deployment 2026-08-04                            | S    |
| PB-5  | motion          | **Nothing animates on data change.** Rows appear and disappear instantly; a new incident arriving in the queue is indistinguishable from a re-render. A 150 ms enter transition is the whole fix                                                                                        | `/incidents` under live SSE, deployment 2026-08-04          | S    |
| PB-6  | typography      | **Long location breadcrumbs truncate mid-word with no tooltip.** `Northgate Retail Group › … › Electronics Aisle` clips at 1024 px and the full path is unrecoverable                                                                                                                   | `/cameras` at 1024 px                                       | S    |
| PB-7  | accessibility   | **Toasts are the only report of a session count.** `sonner` announces politely, but an operator who misses it cannot retrieve "2 sessions ended" anywhere. Consider a persistent line on the row                                                                                        | `/users` disable flow, P-6.2                                | M    |
| PB-8  | wording         | **Error copy leaks the transport.** "Request failed (502)" reaches the operator from `http.ts` when an upstream is down. It should say which capability is unavailable and whether to retry                                                                                             | `lib/api/http.ts:143`, seen during P-6.2 testing            | S    |
| PB-9  | consistency     | **Two spellings of the same act.** Locations are _archived_, users are _disabled_, rules are _disabled_, cameras are _decommissioned_. Four words for "no longer in use" across four screens                                                                                            | Estate, Users, Rules, Cameras                               | M    |
| PB-10 | accessibility   | **Dialogs do not announce what changed after they close.** Focus returns to the trigger correctly, but the result is only in a toast — a screen-reader user gets the announcement without the context                                                                                   | Users, Locations, Rules dialogs                             | M    |
| PB-11 | discoverability | **Keyboard shortcuts are undocumented.** `⌘K` works in the workspace and nothing tells anyone. No `?` overlay, no hint in the top bar                                                                                                                                                   | Investigation Workspace                                     | S    |
| PB-12 | layout          | **Tables have no result count.** "Showing 6 of 6" is absent everywhere. Invisible at 6 rows; the product at 600. ⚠️ Tracked as [TD-47](../../tracking/TECH-DEBT.md) because it is interaction, not styling — listed here so it is not "polished around"                                 | All list pages                                              | —    |
| PB-13 | wording         | **Internal slice numbers shown to customers.** `/live`, `/health` and `/settings` read "coming in P2-1.6 / P2-1.13" — our sprint vocabulary on a customer's screen. ⚠️ Resolved by the pages being **built** in P-6, not by rewording. Listed so nobody reworks the placeholder instead | `/settings`, deployment 2026-08-04                          | —    |

---

## Closed

| ID    | What                                                                                                                                                                                                                                                                                                                                                                                                                                               | Fixed by                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| PB-14 | **`Ai`.** The workspace health panel rendered the dependency `ai` through a CSS `capitalize`, producing "Ai" beside "Jobs" and "Search". Replaced with an explicit `DEPENDENCY_LABEL` map                                                                                                                                                                                                                                                          | Roadmap review, 2026-08-04 |
| PB-15 | **Selects were announced by their value, not their purpose.** A Radix `SelectTrigger` takes its accessible name from its content, so the rule editor's Lifecycle field read as "Enabled, combobox". ⚠️ **The control was named — which is why an automated audit reported zero unnamed controls — but named the wrong thing.** Each Select now carries an id its label points at, and `ruleEditor.regression.test.tsx` asserts all four by purpose | P-6.2                      |

---

## Related

- [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md) — what a customer cannot do
- [TECH_DEBT](../../tracking/TECH-DEBT.md) — what an engineer must repay
- [UI_BENCHMARK](../review/roadmap-2026-08/UI_BENCHMARK.md) — where most of these were first measured, against Linear, Notion, Vercel, Supabase, Datadog and Grafana Cloud
- [DESIGN_SYSTEM](../architecture/phase2/DESIGN_SYSTEM.md) — the tokens and primitives every fix must use. ⚠️ Tailwind only
