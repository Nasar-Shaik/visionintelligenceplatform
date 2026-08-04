# UI Benchmark — against the products it will be compared to

Reviewed against the **running production deployment** on 2026-08-04, loaded with the demo dataset,
at 390 / 768 / 1024 / 1280 / 1440 / 1536 / 1920 px. Comparison set as directed: Linear, Notion,
Vercel, Supabase, Datadog, Grafana Cloud.

Complements [p59/UI_REVIEW.md](../p59/UI_REVIEW.md), which measured compliance — tap targets,
contrast, focus rings, heading order. **This one measures craft**, and it starts by admitting that
the compliance pass measured the wrong things twice.

---

## ⚠️ Two checks that passed while the product was broken

Both are recorded first because the lesson is worth more than any finding below it.

### 1 · The audit reported zero findings on a page that had crashed

P-5.9 audited eleven pages and reported **0 high · 0 medium · 0 low**. At that moment `/cameras` was
rendering the route error boundary — `TypeError: Cannot read properties of undefined (reading
'label')` — for every operator in three of the four demo tenants. A committed screenshot in that
review package shows it.

It passed because the audit measured overflow, tap targets, focus rings and contrast. **A page that
has crashed has no overflow, no unlabelled controls and no contrast failures. It scores
perfectly.**

> **The first assertion any UI check makes must be that the page rendered at all.**
> [`verify.mjs`](verify.mjs) now does exactly that, and fails on any `pageerror` or console error.

### 2 · "Zero horizontal overflow" was measured on the wrong property

The same milestone reported zero horizontal overflow across 11 pages × 5 viewports. It compared
`document.scrollWidth` with `clientWidth`.

The Investigation Workspace was, at that moment, painting its right column **24 px past its parent at
both 1280 px and 1440 px**, with 25 to 44 elements cut off — because an ancestor is
`overflow-hidden`. **A container that clips its children reports no page overflow while cutting
content off.**

[`overflow.mjs`](overflow.mjs) now measures painted boxes
(`getBoundingClientRect().right > clientWidth`) and excludes anything inside a horizontally
scrollable ancestor — because a wide table in an `overflow-x: auto` container is correct behaviour,
not a defect. Getting that exclusion wrong reports 23 failures that are all fine, which is the same
class of error in the other direction.

Both defects are fixed and re-verified. Both checks are kept.

---

## Where it already stands comparison

Not flattery — these are the things that would survive a design review at any of the six.

|                          |                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Token discipline**     | One semantic layer (`--color-*`, `status-*`, `surface-1..3`). No component invents a colour. This is what makes runtime white-labelling possible at all, and it is better than most products at this stage                                                                                 |
| **Restraint**            | No gradients, no drop shadows for decoration, no chrome. Reads like Linear, not like a 2015 admin template                                                                                                                                                                                 |
| **Typography**           | One family, a real scale, tabular numerals on every numeric column. Datadog-class discipline                                                                                                                                                                                               |
| **Navigation**           | Grouped MONITOR / INVESTIGATE / CONFIGURE / SYSTEM. A new operator can guess where things are                                                                                                                                                                                              |
| **Honest states**        | Five render states, and `not-built` is one of them. The workspace tells an operator "no AI advisor is configured — this is not 'no recommendations'". **No product in the comparison set is this honest about its own gaps**, and it is the platform's single most distinctive UI decision |
| **Density control**      | The Events table has a comfortable/compact toggle                                                                                                                                                                                                                                          |
| **Location breadcrumbs** | `Northgate Retail Group › Northgate Superstore › Shop Floor › Electronics Aisle` in the Cameras table. "Lobby" is ambiguous in any estate with two buildings                                                                                                                               |

---

## Where it does not — ranked by what a buyer notices first

### G-1 · The global search box does nothing

`Topbar.tsx:50` renders an `Input` with a placeholder, an `aria-label`, and **no `value`, no
`onChange`, no form and no handler**. It sits in the centre of the top bar on every screen.

In Linear, Notion, Vercel and Supabase, that position is the product's primary interaction. Here it
is inert. A customer will type into it in the first minute of a demo and nothing will happen.

It also contradicts the platform's own best quality: the workspace carefully declares search
`not-built` to the operator, while the top bar shows a search box that looks like it works.

**Fix (P-6, small):** either wire it to filter the queue and the estate — both are client-side and
already loaded — or render it disabled with "Search arrives in a later release". **Do not ship an
input that eats keystrokes.**

### G-2 · No command palette

`⌘K` exists inside the Investigation Workspace and nowhere else. For the comparison set this is table
stakes — it is _the_ interaction pattern of Linear and Vercel. The workspace already proves the
component exists.

**Fix (P-6, small):** promote the existing palette to the shell.

### G-3 · The shell does not respond below `md`

Measured: **the sidebar is 240 px wide at every viewport width, including 390 px** — leaving 150 px
for the entire application. The top bar needs 270 px and gets 150, so the clock, the connection
indicator and the **user menu are painted off-screen**.

> On a phone, an operator cannot reach Sign out.

A "Collapse" control already exists, so the collapsed state is built; it simply is not automatic.

**Fix (P-6):** auto-collapse below `md` plus an off-canvas drawer. This is a design change, not a
patch, which is why it is recorded here rather than improvised.

### G-4 · Dashboards show level, never direction

"ACTIVE INCIDENTS 3". Up or down from yesterday? "ALERTS (RECENT) 0" — over what window?

Every product in the comparison set answers this by default: Datadog and Grafana never show a number
without a sparkline or a delta; Vercel pairs every stat with a trend. A security manager's actual
question is _"is this getting worse?"_, and the dashboard cannot answer it.

Recharts is already a dependency and already code-split into `vendor-charts`. **Fix: P-11**, where
the read models live — noted here so the dashboard is not "polished" without it.

### G-5 · Tables stop at rendering rows

The Incidents and Cameras tables have no column sort, no bulk selection, no result count, no
pagination control and no column configuration. At 6 rows this is invisible. At 600 it is the
product.

Linear's list view is the benchmark, and the gap is not styling — it is interaction.

**Fix: P-6** for sort + count; bulk actions follow the permission model.

### G-6 · Internal slice numbers are shown to customers

`/settings` reads **"Settings — coming in P2-1.13"**. `P2-1.13` is our sprint vocabulary. A customer
sees an unfinished product referring to a schedule they have never been shown.

**Fix: P-6 — the placeholder pages disappear entirely.** Until then, the text should say what the
feature is and not when we numbered it.

### G-7 · Two encodings for two similar attributes

Severity renders as a coloured dot + word. Status renders as a filled pill. They sit in adjacent
columns of the same table and are both single-value enums.

Minor, and exactly the kind of thing the comparison set never gets wrong.

### G-8 · Vertical dead space on half the pages

Dashboard, Cameras, Settings and Incidents all stop between half and two-thirds down a 900 px
viewport with nothing below. It reads as unfinished rather than uncluttered.

Linear fills the viewport; Notion centres a column and makes the space deliberate. This does
neither.

**Fix: P-6.** Cheapest version: let the primary table or panel grow to the available height.

### G-9 · The empty workspace shows six empty panels

Opening `/workspace` without an incident renders Details, Why this fired, Evidence chain,
Assignment, Comments and Attachments as six empty boxes, each saying "No incident selected".

One clear prompt in the primary region reads as designed. Six repetitions of the same sentence read
as broken.

### G-10 · `Ai`

The workspace health panel renders the dependency `ai` through a `capitalize` class, producing
**"Ai"**. Beside "Jobs" and "Search" it looks like a typo, because it is one.

---

## Responsive — measured, after the fix

`overflow.mjs`, painted-box measurement, scrollable containers excluded:

| Width   | Result                                            |
| ------- | ------------------------------------------------- |
| 1920 px | ✓ nothing clipped                                 |
| 1536 px | ✓ nothing clipped                                 |
| 1440 px | ✓ nothing clipped — **was 25 clipped elements**   |
| 1280 px | ✓ nothing clipped — **was 44 clipped elements**   |
| 1024 px | ✓ nothing clipped                                 |
| 768 px  | ✗ 2 elements per page — the top-bar cluster (G-3) |
| 390 px  | ✗ 2 elements per page — the top-bar cluster (G-3) |

Desktop and tablet are clean. Phone is not, and the cause is one unresponsive shell rather than
eleven broken pages.

---

## Dark mode, light mode

There is no light mode. `theme.css` is structured for one — `:root[data-theme="light"]` would swap
cleanly — but no light palette exists (TD-43).

This was asked for as a verification. It is a decision:

> **Recommendation: stay dark-only through P-8.** Dark is right for a control room, no pilot has
> asked, and a second palette costs every future component twice. Revisit when a customer asks.

---

## Accessibility

P-5.9's findings stand and were re-checked: 0 unnamed controls, 0 targets under 24 px, 0 skipped
heading levels, every tab stop shows a visible focus ring.

Two things that pass and are worth naming because they are usually wrong: status is **never
colour-only** (`StatusIndicator` always carries a label, and keeps an accessible name even when the
label is visually hidden), and the five render states are announced as text rather than implied by an
empty box.

Open: TD-31 — the scrubber and volume sliders are 24 px on touch, not the 44 px a finger wants.

---

## What must not change

Tailwind only. No Bootstrap, no Material UI, no component library. The token layer is the reason
runtime white-labelling works without a rebuild, and dropping a third-party design system on top of
it would end that on the first component.
