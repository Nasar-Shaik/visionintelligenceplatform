# Operations Console — Design System (P2-1)

_Status: ⏳ Architect Review Pending · Author: Claude · Date: 2026-07-29 · Stack: Tailwind CSS v4 + shadcn/ui_

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
