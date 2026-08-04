# UI review — commercial quality

Every page, every state, five viewports, against a realistic estate. Screenshots in
[`screens/`](screens/), named `<viewport>-<page>.png`.

Reviewed as a paying enterprise customer would: not "does it work" but "would I believe this was
built by a company I am about to trust with evidence".

---

## 1 · Coverage

| Viewport        | Width     | Represents                                   |
| --------------- | --------- | -------------------------------------------- |
| desktop         | 1920×1080 | SOC video wall / primary workstation         |
| laptop          | 1440×900  | Manager's laptop — the default review width  |
| tablet          | 1024×768  | **iPad landscape — the control-room tablet** |
| tablet-portrait | 768×1024  | Handheld rounds                              |
| phone           | 390×844   | On-call glance                               |

11 pages: dashboard, live, cameras, locations, events, incidents, workspace, alerts, rules, health,
settings. **55 combinations, zero horizontal overflow.**

---

## 2 · Findings, by criterion

### Spacing and density ✅

Consistent 4 px rhythm; card padding uniform; table rows comfortable at realistic row counts. The
incident queue at six rows and the events list at 126 both read cleanly — density was reviewed
against real volume, not a single row.

### Typography ✅

One scale, applied consistently. Page `h1`, card titles `h2` (fixed this milestone — they were
`h3`, skipping a level). Numerals are tabular where they are compared in a column, which keeps
timestamps and counts aligned.

### Iconography ✅

Lucide throughout, one weight, one size scale. No mixed icon sets — the single most common tell of
an assembled-from-parts UI.

### Elevation ✅

Restrained and consistent: a border and a one-step surface change (`surface-1` → `surface-2` →
`surface-3`) rather than drop shadows. Correct for a dark product — shadow-based elevation reads as
muddy on dark backgrounds, and this avoids it.

### Motion ✅

Transitions are short and confined to hover, focus and disclosure. Nothing animates on data arrival,
which is right for an operations screen: movement should mean something changed, not that a list
re-rendered.

### Hover and focus ✅

Every interactive element has a hover state. **Every tab stop shows a visible focus ring** — verified
by tabbing, not by reading CSS. A single `focus-ring` utility means focus cannot be styled
inconsistently.

### Dialogs and drawers ✅

Radix primitives: focus trapped, `Escape` closes, focus returns to the trigger, background inert.
The incident detail drawer and the shortcut sheet both behave correctly.

### Loading skeletons ✅

Shaped like the content they replace — table skeletons for tables, panel skeletons for panels — so
layout does not jump when data arrives. Panels show their own skeleton independently, so a slow
panel does not blank the workspace.

### Empty states ✅

Icon, title, and a sentence explaining what would put content here. **Five distinct non-content
states**, each saying something different:

| State       | Says                                                                  |
| ----------- | --------------------------------------------------------------------- |
| Empty       | "Nothing in the queue — no incident matches the current filters"      |
| Loading     | Skeleton in the content's shape                                       |
| Unavailable | "not configured for this deployment" — the service is off, not broken |
| Not built   | "Contract-frozen; no worker runs" — honest about scope                |
| Failed      | The error, contained to the panel                                     |

That last distinction is the commercially valuable one. Most products show one empty box for all
five, and every one of them reads as broken.

### Dark mode ✅

Single token source (`theme.css`), no hard-coded colours found in components. Dark-only by design;
a light palette has never been produced (TD-43).

### Accessibility ✅

After fixes: 0 unnamed controls, 0 targets below 24 px, 0 skipped heading levels, focus visible
throughout, ARIA on the transport controls, `aria-pressed` on filter chips, `aria-current` on the
selected incident.

### Tablet ✅ (after fixes)

The 1024×768 clipping is fixed and panel capacity raised from 8 to 10. The workspace still hides
panels at that width and **says how many** — honest, and the right trade for a screen that cannot
show seventeen panels.

---

## 3 · Before and after

|                              | Before                                   | After                                |
| ---------------------------- | ---------------------------------------- | ------------------------------------ |
| Incident queue CAMERA column | `cam_retail_electronics2`                | Electronics — High Value Cabinet     |
| Dashboard incident cards     | `cam_retail_carpark`                     | Car Park — North                     |
| Tablet workspace titles      | `Suspected concealment — Elec` (clipped) | `Suspected concealment …` (ellipsis) |
| Tablet panels shown          | 8 of 17, 280 px empty                    | 10 of 17                             |
| Sub-24 px tap targets        | 28 across 3 pages                        | 0                                    |
| Heading levels               | h1 → h3 on dashboard                     | h1 → h2                              |
| Branding                     | rebuild required, no favicon             | runtime file, contrast-checked       |

---

## 4 · What realistic data changed

Worth recording, because it is the method as much as the result.

Against the old single-tenant seed — one camera named `cam_dev_1`, one incident — every one of these
screens looked finished. The defects were not subtle once the data was realistic; they were
**invisible** until then:

- One camera called `cam_dev_1` reads like a name. Nine cameras called
  `cam_retail_electronics2` read like a database dump.
- One incident cannot clip in a panel. Six with real titles do.
- One panel cannot reveal that the tablet capacity is set too low.
- One tenant called "Dev Tenant" never makes anyone ask whether branding is configurable.

**A UI review describes the data it was run against**, in the same way a test suite describes the
environment it ran in.

---

## 5 · Framework compliance

**Tailwind only**, as instructed. No Bootstrap, no Material UI, no component library added this
milestone. Composition is Radix primitives + CVA variants + Tailwind utilities, exactly as before —
a design system built on tokens rather than an imported theme.
