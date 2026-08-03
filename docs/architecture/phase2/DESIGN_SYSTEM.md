# Operations Console — Design System (P2-1; **Enterprise scope from v2, P-5.2.0**)

_Status: v1 shipped (P2-1) · **v2 sections 10–21 added 2026-08-03 (P-5.2.0)** · Stack: Tailwind CSS v4 + shadcn/ui_

> **⚠️ Why this is an extension and not a new document.** The Architect asked for an Enterprise
> Design System specification covering the Investigation Workspace and all future product pages.
> Most of what that asks for **already exists here and is already enforced**: tokens live in
> `apps/console/src/app/styles/theme.css`, an ESLint rule fails a build that hardcodes a hex or a
> px, and the primitive set (table, card, dialog, drawer, badge, skeleton, alert) is built. Writing a
> second specification would create two documents describing one visual language, and the first time
> they disagreed there would be no principled way to decide which one the code was wrong against —
> the same reasoning that keeps the platform to one audit trail (CONSTRAINTS §46) and one evaluator.
>
> So **v2 extends this file in place**. Sections 1–9 are the P2-1 record, unchanged. Sections 10–21
> raise the scope from "the SOC console" to "every product page", and add what genuinely did not
> exist: a framework policy that is now **tested rather than assumed**, the **four render states**
> (including the one this platform needs and most design systems lack), the investigation panel
> chrome, timeline styling with gaps, and the theme extension contract.

> The single source of visual truth for the SOC console. Tokens are defined once as Tailwind v4
> `@theme` custom properties (CSS variables), consumed by shadcn/ui primitives and every page — **no
> page hardcodes a hex, size, or radius**. The **Tailwind MCP** is used during implementation to
> generate/validate these tokens, consolidate repeated utility chains into `@utility`/`@apply`
> component classes, and check contrast + responsive behaviour. This document is the spec the MCP
> output must conform to. Dark-first, operator-grade, contrast-driven.

## 1. Philosophy

A Security **Operations Center**, not an admin dashboard: dark graphite canvas, layered surfaces,
restrained accent colour, and **colour reserved for meaning** (status + severity). High contrast for
long monitoring sessions; dense but readable; motion minimal. Desktop/widescreen primary
(1920 → 2560 → 4K); mobile secondary.

## 2. Color palette (oklch, dark-first)

Defined as `@theme` variables. A light theme is a later token-swap (`:root[data-theme="light"]`); the
console ships **dark only** for P2-1.

### Neutral / graphite ramp (canvas → surfaces → borders → text)

| Token                   | Role                     | Value (dark)                                  |
| ----------------------- | ------------------------ | --------------------------------------------- |
| `--color-bg`            | app canvas (deepest)     | `oklch(0.17 0.01 260)` — graphite #14161a-ish |
| `--color-surface-1`     | primary card/panel       | `oklch(0.21 0.012 260)`                       |
| `--color-surface-2`     | raised (popover, header) | `oklch(0.25 0.014 260)`                       |
| `--color-surface-3`     | hover / active row       | `oklch(0.29 0.016 260)`                       |
| `--color-border`        | hairline dividers        | `oklch(0.32 0.015 260)`                       |
| `--color-border-strong` | emphasized borders       | `oklch(0.40 0.017 260)`                       |
| `--color-text`          | primary text             | `oklch(0.96 0.005 260)`                       |
| `--color-text-muted`    | secondary text           | `oklch(0.74 0.008 260)`                       |
| `--color-text-subtle`   | tertiary / placeholder   | `oklch(0.58 0.01 260)`                        |

### Brand + semantic (info/success/warning/critical) — each with `fg` / `bg` / `border`

| Token group                             | Base                           | Muted bg (chip)        | Border                 |
| --------------------------------------- | ------------------------------ | ---------------------- | ---------------------- |
| `--color-brand` (info / primary action) | `oklch(0.62 0.16 250)` (blue)  | `oklch(0.30 0.06 250)` | `oklch(0.45 0.10 250)` |
| `--color-success`                       | `oklch(0.70 0.17 150)` (green) | `oklch(0.30 0.06 150)` | `oklch(0.45 0.10 150)` |
| `--color-warning`                       | `oklch(0.78 0.16 80)` (amber)  | `oklch(0.32 0.06 80)`  | `oklch(0.50 0.10 80)`  |
| `--color-critical`                      | `oklch(0.63 0.22 25)` (red)    | `oklch(0.30 0.09 25)`  | `oklch(0.48 0.14 25)`  |

### Severity scale (incident/event) — 5 steps, colour = urgency

| Severity   | Token            | Colour                       | Usage                        |
| ---------- | ---------------- | ---------------------------- | ---------------------------- |
| `critical` | `--sev-critical` | red `oklch(0.63 0.22 25)`    | left-border, badge, row tint |
| `high`     | `--sev-high`     | orange `oklch(0.70 0.19 45)` |                              |
| `medium`   | `--sev-medium`   | amber `oklch(0.80 0.15 85)`  |                              |
| `low`      | `--sev-low`      | blue `oklch(0.66 0.12 240)`  |                              |
| `info`     | `--sev-info`     | slate `oklch(0.70 0.03 260)` |                              |

Maps 1:1 to the contract `EventPriority` enum (`critical|high|medium|low|info`) — a single
`severityToken(priority)` helper drives badges, borders, and row tints everywhere.

### Status colours (camera / runtime / delivery / connection)

| State                                    | Token            | Colour        |
| ---------------------------------------- | ---------------- | ------------- |
| online / connected / delivered / healthy | `--status-ok`    | success green |
| degraded / connecting / sent / warning   | `--status-warn`  | warning amber |
| offline / lost / failed / error          | `--status-error` | critical red  |
| idle / disabled / unknown                | `--status-idle`  | text-subtle   |

## 3. Typography

- **UI font:** Inter (variable), system-ui fallback. **Mono:** JetBrains Mono / ui-monospace for IDs,
  correlation IDs, timestamps, FPS/latency readouts.
- **Scale** (`--text-*`, rem, with paired line-height):

| Token       | Size / line | Use                             |
| ----------- | ----------- | ------------------------------- |
| `text-2xs`  | 11px / 16   | dense table meta, tags          |
| `text-xs`   | 12px / 16   | table cells, captions           |
| `text-sm`   | 13px / 20   | body default (operator density) |
| `text-base` | 14px / 20   | inputs, primary body            |
| `text-lg`   | 16px / 24   | card titles                     |
| `text-xl`   | 20px / 28   | page section headers            |
| `text-2xl`  | 24px / 32   | page titles                     |
| `text-3xl`  | 30px / 36   | big metric numerals             |

- **Weights:** 400 body · 500 medium (labels) · 600 semibold (titles/metrics) · tabular-nums on all
  numeric readouts (FPS, latency, counts) so digits don't jitter.

## 4. Spacing, radius, elevation, motion

- **Spacing:** Tailwind 4px base. **Density is a first-class concern** — a `density` prop on Table/List
  toggles `--space-row` between `compact` (28px row) and `comfortable` (40px row). Default page padding
  `--space-page: 1.5rem`; card padding `1rem`.
- **Radius:** `--radius-sm: 6px` (inputs, badges) · `--radius-md: 8px` (cards, buttons) ·
  `--radius-lg: 12px` (panels, dialogs) · `--radius-full` (status dots, avatars). Restrained — SOC, not
  consumer.
- **Elevation (dark):** elevation = **surface-lightening + hairline border + faint shadow**, never big
  drop shadows. `--elev-0` canvas · `--elev-1` surface-1 + border · `--elev-2` surface-2 + border +
  `shadow: 0 1px 2px oklch(0 0 0 / .4)` · `--elev-3` popovers/dialogs surface-2 + strong border +
  `0 8px 24px oklch(0 0 0 / .5)`.
- **Motion:** `--motion-fast: 120ms` · `--motion-base: 180ms`, ease-out. Only functional transitions
  (hover, drawer/dialog enter, skeleton shimmer). **No decorative animation.** Respect
  `prefers-reduced-motion` (disable all non-essential transitions).

## 5. Responsive breakpoints (desktop-first, widescreen-tuned)

Custom `@theme` screens beyond Tailwind defaults, tuned to operator monitors:

| Name  | Min-width | Target                                            |
| ----- | --------- | ------------------------------------------------- |
| `md`  | 768       | small laptop (secondary)                          |
| `lg`  | 1024      | laptop                                            |
| `xl`  | 1280      | baseline desktop                                  |
| `2xl` | 1536      | 1080p work area                                   |
| `3xl` | 1920      | **1920×1080 primary**                             |
| `4xl` | 2560      | **1440p ops wall**                                |
| `5xl` | 3200      | **4K** (grid density scales up, not element size) |

Grid columns (Live/Camera): responsive by breakpoint (2 → 3 → 4 → 6 tiles). 4K increases **tile count**,
not tile size, to maximise situational awareness.

## 6. Primitive components (variants)

shadcn/ui provides the accessible base (Radix); we theme it with the tokens above and add SOC-specific
composites. **Every page reuses these — no bespoke one-off styling.**

### From shadcn/ui (themed)

| Primitive                                                                                 | Variants / notes                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Button**                                                                                | `primary` · `secondary` · `ghost` · `outline` · `destructive`; sizes `sm·md·lg·icon`; loading state |
| **Card**                                                                                  | header/body/footer slots; `elev-1` default                                                          |
| **Panel / Section**                                                                       | titled container with actions slot; resizable variant (react-resizable-panels)                      |
| **Table**                                                                                 | sortable, sticky header, `density` prop, row-severity tint, zebra off (borders instead)             |
| **Badge**                                                                                 | `severity` (5) · `status` (4) · `neutral` · `outline`                                               |
| **Alert**                                                                                 | `info·success·warning·critical` (inline banners)                                                    |
| **Dialog**                                                                                | modal (confirm/resolve), `elev-3`                                                                   |
| **Drawer / Sheet**                                                                        | right-side detail (incident/evidence/camera detail)                                                 |
| **Sidebar**                                                                               | collapsible primary nav (icon-rail ↔ expanded)                                                      |
| **Navbar / Topbar**                                                                       | tenant + user + global search + live clock + connection state                                       |
| **Tabs / Select / Input / Textarea / Switch / Tooltip / DropdownMenu / Skeleton / Toast** | themed base                                                                                         |

### SOC composites (custom, built from primitives + tokens)

| Composite                | Purpose                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **StatusIndicator**      | dot + label; drives on/warn/error/idle from a status token; pulse for "live"                                   |
| **SeverityBadge**        | severity token → colour + label; used in tables/cards/timeline                                                 |
| **MetricCard**           | big tabular-num value + label + delta + sparkline (Recharts); dashboard KPIs                                   |
| **CameraTile**           | video/snapshot container + overlay (name, status dot, FPS/latency, live badge, detection boxes)                |
| **IncidentCard**         | severity left-border, title, camera/site, time-ago, status chip, quick actions (ack/resolve)                   |
| **NotificationCard**     | channel icon, delivery status, target, ack state, retry indicator                                              |
| **Timeline**             | vertical event/lifecycle timeline (events, incident transitions, deliveries) with severity dots                |
| **VideoPlayerContainer** | aspect-locked shell for live (MJPEG/img) or clip (`<video>`); overlay layer for detection boxes; controls slot |
| **DetectionOverlay**     | absolutely-positioned bbox layer (normalized [0,1] → %); label + confidence chips                              |
| **EmptyState**           | icon + message + optional action; every list/grid has one                                                      |
| **LoadingSkeleton**      | shape-matched skeletons per view (table rows, cards, tiles)                                                    |
| **PageHeader**           | title + breadcrumb + actions; consistent page chrome                                                           |
| **FilterBar**            | severity/status/time/camera filters + search; writes to URL query params                                       |

## 7. Tailwind v4 organization strategy

- **`app/styles/theme.css`** — the single `@theme { … }` block: all colour/space/radius/type/screen
  tokens above. This is the contract; nothing else defines tokens.
- **`@utility` / component classes** — repeated patterns become named utilities (e.g. `card-surface`,
  `row-hover`, `sev-tint`) via Tailwind v4 `@utility`, so pages compose semantic classes, not 15-class
  chains. **The Tailwind MCP is used to detect duplicated chains and propose these abstractions.**
- **cva (class-variance-authority)** for component variants (Button/Badge/etc.), co-located with each
  shadcn primitive — variants map to tokens, never raw hex.
- **`cn()` helper** (clsx + tailwind-merge) everywhere for conditional/merged classes.
- **No inline hex/px** and **no arbitrary values** except rare, reviewed one-offs — enforced by an
  ESLint rule (`no-restricted-syntax` on `[#...]`/`[NNpx]` in className) in CI.
- **Dark-first:** tokens are the dark values; a future light theme swaps CSS variables under
  `:root[data-theme=light]` with zero component changes.

## 8. Accessibility

WCAG AA contrast on text/critical UI (verified with the Tailwind MCP + a contrast check in CI);
full keyboard nav (Radix handles focus traps/roving tabindex); visible focus rings
(`--ring: brand`); `prefers-reduced-motion` honoured; severity/status never encoded by colour alone
(always paired with a label/icon); live regions (`aria-live=polite`) for incoming incidents/alerts so
screen readers announce them.

## 9. Definition of done (design system)

- `theme.css` tokens implemented and rendered on a **Design System / Storybook-style route**
  (`/design` in dev) showing every primitive + variant + all severity/status states.
- shadcn/ui installed + themed to tokens; cva variants for Button/Badge/Alert/Card.
- SOC composites (§6) built and documented (props + variants) in component docs.
- Tailwind MCP pass: no duplicated utility chains above threshold; contrast AA verified.
- Zero hardcoded colours/sizes outside `theme.css` (ESLint-enforced).

---

# v2 — Enterprise scope (P-5.2.0, 2026-08-03)

Everything below governs **all** customer-facing product pages, not just the SOC console. The
reference target is modern enterprise software — Azure Portal, Datadog, Grafana, Atlassian, GitHub
Enterprise, Linear — and explicitly not consumer application design: information density over
whitespace, restraint over delight, and no decorative motion.

## 10. Framework policy — Tailwind only, and now tested

**Tailwind CSS v4 is the only styling framework.** Bootstrap, Material UI, Ant Design, Chakra,
Mantine and any other component-CSS framework are forbidden.

⚠️ This was already true — and true **by accident**. Nothing recorded the policy and nothing checked
it, so the first `pnpm add @mui/material` would have succeeded and been reviewed as an ordinary
dependency change. `apps/console/src/test/design-system.test.ts` now asserts the ban against the
console's `package.json`, which is the difference between a rule and a preference.

| Layer                | Allowed                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Styling              | Tailwind v4 utilities + `@theme` tokens + `@utility` classes                                                         |
| Accessible behaviour | Radix UI primitives (unstyled)                                                                                       |
| Variants             | `class-variance-authority`, merged with `cn()` (clsx + tailwind-merge)                                               |
| Icons                | `lucide-react` — one icon set, no mixing                                                                             |
| Charts               | Recharts, themed from the same tokens                                                                                |
| Motion               | CSS transitions + the `@keyframes` in `theme.css`; Framer Motion only where a transition genuinely cannot express it |

**The token rule is absolute:** no component defines a colour, radius, font size or spacing value.
Everything resolves to a `@theme` custom property. Enforced by ESLint on `className` and by review
on CSS.

## 11. ⚠️ The four render states — the section this platform actually needed

Every data surface — panel, table, card, chart, list — renders exactly one of these. Most design
systems ship three; the platform needs four, and the fourth is the one that keeps the UI honest.

| State              | When                                                                                                                                       | Renders                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Loading**        | The request is in flight                                                                                                                   | A **shape-matched skeleton** — same row count, same column widths. Never a spinner over a blank pane, which discards the layout and makes the page jump when data lands. |
| **Content**        | Data came back                                                                                                                             | The data                                                                                                                                                                 |
| **Empty**          | The query succeeded and there is genuinely nothing                                                                                         | Icon + one sentence + the action that would create the first item                                                                                                        |
| **⚠️ Unavailable** | **Nobody could look.** No producer exists, the upstream timed out, the deployment has not configured it, or the principal lacks permission | A **stated reason**, visually distinct from Empty — muted, bordered, never an empty region                                                                               |

**Why the fourth exists.** "There are no AI recommendations" and "no AI has ever analysed this
incident" are different claims, and only one is true today. Rendering the second as the first is a
confident false statement inside an investigation record. This is CONSTRAINTS §44 and §63 — _a check
that could not run is not a check that passed_, and _an omitted source reads as an empty one_ —
expressed in pixels.

It is not a design nicety: it is wired to data. `WorkspacePanel.availability` (`available` /
`deferred` / `optional`) and its required `unavailableReason` come from the frozen layout contract,
`IncidentTimeline.gaps` carries the same distinction per source, and `SearchResponse.gaps` carries it
per entity. **A panel may not render Empty when the contract says Unavailable.**

Error is a fifth, narrower case: the request failed and retrying is meaningful. It renders the
message, the correlation id, and a Retry action. An error that is not retryable is Unavailable.

### Success feedback

Toasts (`sonner`) for completed actions, auto-dismissing at 4s. ⚠️ **Never a toast for a destructive
or irreversible action** — those confirm in a dialog _before_, and the confirmation is the feedback.
A toast that says "Incident closed" after the fact is an announcement, not a safeguard.

## 12. Status & badge system — semantics come from contracts, never from the component

A badge never invents a vocabulary. Each family maps 1:1 to a platform enum, so a new enum value
surfaces as a design-system gap rather than as an unstyled string.

| Family              | Source of truth             | Tokens                                                                                                                                      |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Severity**        | `EventPriority`             | `--color-sev-critical/high/medium/low/info`                                                                                                 |
| **Incident status** | `IncidentStatus` (6 values) | raised → critical · acknowledged → brand · investigating → warning · escalated → critical (outline) · resolved → success · closed → neutral |
| **SLA state**       | `IncidentSlaState`          | ⚠️ `unknown` renders **neutral with an explicit "not measured"**, never as success                                                          |
| **Job state**       | `JobState`                  | queued → neutral · running → brand (pulse) · succeeded → success · failed → critical · cancelled → muted                                    |
| **Actor kind**      | `IncidentActorKind`         | operator → neutral · system/service/automation → muted · **ai-advisor → distinct outline** · unknown → dashed border                        |
| **Stream health**   | `StreamHealthState`         | healthy/degraded/down/unknown                                                                                                               |

Three rules:

1. **Colour is never the only channel.** Every badge carries a label; every status dot carries text
   or an `aria-label`. Roughly 1 in 12 men has a colour vision deficiency, and a SOC is exactly
   where that must not matter.
2. **`unknown` is styled, not hidden.** A dashed or muted treatment that reads as "we do not know"
   — distinct from both success and failure. Hiding it is how an unmeasured SLA reads as a met one.
3. **`ai-advisor` is visually distinct wherever it appears.** An AI's suggestion sitting in the same
   chrome as an operator's note is indistinguishable from a finding, which is how it ends up quoted
   in a report.

## 13. Table standard

The densest surface in the product and the one most worth standardising.

- **Sticky header**, sticky first column on horizontal scroll.
- **Density** is a prop: `compact` (28px rows, the operator default) · `comfortable` (40px).
- **No zebra striping.** Hairline row borders instead — striping fights severity tinting and halves
  the usable background states.
- **Row severity** is a 2px left border plus an optional 4% tint, never a full-row colour fill.
- **Numeric columns** are right-aligned and `tabular-nums`, so digits do not jitter on refresh.
- **Sorting** is server-driven. ⚠️ A column is sortable **only if a covering index supports that
  sort** — an unindexed sort header is a UI affordance that triggers an in-memory sort of a tenant's
  history (CONSTRAINTS §40/§59/§61). Non-sortable columns render no affordance at all.
- **Virtualise past 100 rows.** Row height stays fixed so the scrollbar does not lie.
- **Selection** is checkbox-based with a header select-all scoped to the **loaded page**, labelled
  as such — "select all" that silently means 40,000 records is how a bulk action becomes an incident.
- Every table ships all four §11 states.

## 14. Card standard

`elev-1` surface · `--radius-md` · 1rem padding · optional header (title, subtitle, actions slot) ·
optional footer. Cards do not nest more than one level; a card inside a card inside a panel is a
layout that has lost an argument with itself. Metric cards use `--text-3xl` tabular numerals with
the label above and the delta below, and a metric with no measurement shows **an em-dash and a
tooltip**, never `0`.

## 15. Drawer and dialog standard

| Surface            | Use                                                                             | Rules                                                                                  |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Drawer** (sheet) | Detail that keeps context — incident detail beside the queue, evidence metadata | Right side · 420/560/720px widths · `Escape` closes · focus trapped · **never nested** |
| **Dialog**         | A decision that must block                                                      | Centred · `elev-3` · max 560px · focus trapped · returns focus to the trigger          |

⚠️ **Destructive and irreversible actions require a dialog with a typed or named confirmation** and
a primary button that states the verb ("Close incident"), not "OK". The platform has genuinely
irreversible operations — closing an incident **seals** it (CONSTRAINTS §57) and there is no reopen
by design — so the confirmation is not ceremony, it is the last point at which the operator can be
told what is about to become permanent.

Drawers never contain another drawer's trigger. Dialogs never contain forms longer than one screen —
that is a page.

## 16. Investigation panel chrome

The dock behaviour is data (`WorkspacePanel` in `@vip/contracts`); this is how it looks.

- **Panel header:** 32px, title in `--text-xs` uppercase tracking-wide `--color-text-muted`, actions
  right-aligned and revealed on hover or focus — but **always reachable by keyboard**, never
  hover-only.
- **Collapse** leaves the header visible. A collapsed panel that vanishes is a panel the operator
  cannot get back without knowing it existed.
- **Resize handles** are 4px hit targets with an 8px invisible grab area, `--color-border-strong` on
  hover, and respect `minSizePx`/`maxSizePx` from the contract.
- **Float** opens a `window.open` panel styled from the same tokens — a second monitor is how
  control rooms actually work.
- **Region weighting:** left 320px · right 380px · bottom 220px · centre takes the remainder, and the
  centre never drops below 480px regardless of what the side panels are dragged to.
- **Deferred panels** (§11 Unavailable) render their header and reason at 60% opacity. They are
  present, so the layout does not reflow when the capability arrives.

## 17. Timeline styling

- **Vertical rail**, oldest first, one entry per `IncidentTimelineEntry`.
- **Kind icon** in a severity- or neutral-toned dot; **source badge** (`incident` / `events` /
  `evidence` / `notify`) so "the incident says so" is distinguishable from "another service said so".
- ⚠️ **Gaps render as a visible break in the rail** — a dashed segment carrying the
  `IncidentTimelineGap` reason. `unavailable`, `truncated` and `not-requested` are three different
  labels, because "there is nothing" and "nobody asked" are different facts.
- **Playback track gaps** use the same language horizontally: a hatched region on the scrubber sized
  to real elapsed time. ⚠️ It is never closed up — a scrubber that concatenates segments shows 14:00
  running into 14:20 and reads as twenty uneventful minutes, when it is twenty minutes of missing
  footage. That is usually what the investigation is about.
- Grouping collapses runs of more than 5 same-kind entries into "12 detections" with a disclosure.

## 18. Keyboard, focus and the command palette

- **One focus affordance:** the `focus-ring` utility in `theme.css`. Nothing defines its own.
- **Focus is never removed** — `outline: none` without a replacement fails review. A visible ring on
  every interactive element, including inside virtualised lists.
- **Skip-to-content** link as the first tab stop on every page.
- **Shortcut affordances** come from the frozen `WORKSPACE_COMMANDS` registry: a `<kbd>` chip beside
  a menu item renders the command's chord, resolving `Mod` to ⌘ or Ctrl **per platform**. No
  component hardcodes a key.
- The **command palette** (`Mod+K`) is the discoverability surface: it lists every command the
  principal has permission for, and — ⚠️ per the registry's rule — **omits** the rest rather than
  disabling them, because a greyed-out "Resolve Incident" tells a viewer exactly which capabilities
  exist and who holds them.
- **Modifiers on mutations.** No unmodified single key changes stored state; enforced in the
  contract, visible here as: destructive commands always show a two-key chord.

## 19. Accessibility (extends §8)

- **WCAG 2.2 AA** on text and interactive controls; verified in CI on the token pairs.
- **Target size:** interactive controls ≥ 24×24 CSS px (AA 2.5.8), including the compact table's
  row actions — density is not an exemption.
- **Radix everywhere behaviour is non-trivial**: focus traps, roving tabindex, `aria-expanded`,
  listbox semantics. We theme; we do not reimplement.
- **Live regions** (`aria-live="polite"`) for arriving incidents; `assertive` reserved for critical
  severity only, because an assertive region interrupts a screen reader mid-sentence.
- **Reduced motion** honoured globally (already in `theme.css`); the skeleton shimmer and the
  running-job pulse both stop.
- **Never colour alone** (§12 rule 1). **Never hover alone** (§16).
- Every icon-only control has an `aria-label`; every chart has a table equivalent behind a toggle.

## 20. Responsive behaviour

Desktop-first, tuned to the operator monitors already in §5. The workspace adapts by **dropping
regions in a fixed order**, never by reflowing four docks into a column nobody can navigate:

| Width          | Investigation Workspace                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ≥ `3xl` (1920) | All four regions. The reference layout.                                                                                                                                                  |
| `xl`–`2xl`     | Bottom region becomes tabs; left and right stay docked.                                                                                                                                  |
| `lg`           | Right region becomes a drawer; left collapses to an icon rail.                                                                                                                           |
| `md`           | Centre only; queue and details open as full-height drawers.                                                                                                                              |
| `< md`         | ⚠️ **Read-only.** Triage, review and comment — no resize, no float, no bulk action. Investigating an incident on a phone is a real scenario at 3am; drawing an annotation on one is not. |

4K increases **density and tile count**, never element size (§5).

## 21. Theme extension points

- **Dark is the shipped theme.** Every token already resolves through a CSS variable, so light is a
  variable swap under `:root[data-theme="light"]` with **zero component changes** — that is the
  contract, and any component that would need to change is a component that hardcoded something.
- **Tenant accent:** `--color-brand` and its `-muted`/`-border` companions are the only tokens a
  tenant may override. ⚠️ **Severity and status tokens are not themeable.** A tenant that could
  restyle "critical" could make critical look calm, and the whole point of reserving colour for
  meaning is that the meaning is the platform's, not the deployment's.
- **Contrast is validated, not assumed.** Any overridden accent is checked against the surface ramp
  at load; one that fails AA falls back to the default and logs. An unreadable tenant brand colour
  is a support ticket at best and an unnoticed alert at worst.
- ⚠️ **Report themes are not UI themes.** `ReportThemeId` styles a generated PDF and lives in
  `@vip/contracts`; it shares no tokens with the console and must never be wired to `data-theme`.
  They are different artefacts with different audiences, and conflating them means a tenant's
  console accent silently restyles a document handed to a regulator.

## 22. Definition of done (v2)

A page is not done until:

- It consumes only `@theme` tokens and design-system primitives — **no page-specific styles**.
- It implements **all four §11 states**, and renders Unavailable where a contract says
  `deferred`/`gap`/`unknown` rather than falling back to Empty.
- Every action reachable by keyboard; focus ring visible; shortcuts come from `WORKSPACE_COMMANDS`.
- Lists past 100 rows virtualised; every sortable column backed by a covering index.
- AA contrast verified; colour never the sole channel.
- Responsive down to `md`, and read-only below it.
- No forbidden framework (§10) — asserted by `design-system.test.ts`.
