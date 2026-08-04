# Rule editing

**Milestone P-6.1 · recorded 2026-08-04 against the production deployment**

▶ [`rule-editing.webm`](rule-editing.webm) — 1280×720

## What this demonstrates

The rule list, then an existing rule opened in the editor with **every field carrying its stored
value** — the lifecycle, the severity, the conditions and the actions.

That sounds unremarkable and it is the whole milestone: until P-6.1 an existing rule **could not be
saved**. Submit failed validation on `lifecycle` and `severity`, so the PATCH never fired, and a
customer could author a rule but never correct one.

## The engineering claim behind it

⚠️ **A Radix `Select` cannot adopt a value that changes after it mounts** in this composition — its
items live in a portal that is unmounted while the menu is closed, so a value arriving later has no
item to resolve against. The clue was in _which_ fields failed: the two that worked happened to have
stored values equal to the form defaults.

Two fixes were measured wrong before one measured right, including the API built for exactly this
case. The form is now split and keyed by rule id, so it mounts once with its values — and
`ruleEditor.regression.test.tsx` walks the full **5 lifecycles × 5 severities** matrix, because a
fixture sitting on a default value would have been green throughout the entire defect.

## Screenshots

See [`docs/review/p6/`](../../review/p6/README.md#p-61--a-rule-can-be-edited) and
[`rule-edit.mjs`](../../review/p6/rule-edit.mjs).

## ⚠️ Known limitations — say these before a customer finds them

- **The rules that matter most do not fire yet** (L-2). The perception runtime detects person,
  vehicle, fire and smoke. Loitering, intrusion, falls, fights and PPE violations are event types a
  rule can match, and **nothing produces them from video**. Planned for P-8.
- **Rule versions are immutable and rollback is by version**, not by edit history diffing.
- **No rule templates or bulk enable/disable.**
