# @vip/console — SOC Operations Console (P2-1)

The platform's first frontend: a dark, operator-grade Security Operations Console. It is a
**pure client of the API gateway** — it holds no business logic and imports only `@vip/contracts`
(for types) from the workspace (import-graph `app` layer, [ADR-0019](../../docs/adr/ADR-0019-operations-console-and-apps-layer.md)).

- **Plan:** [OPERATIONS_CONSOLE.md](../../docs/architecture/phase2/OPERATIONS_CONSOLE.md)
- **Design system:** [DESIGN_SYSTEM.md](../../docs/architecture/phase2/DESIGN_SYSTEM.md)

## Stack (Architect-frozen, ADR-0019)

React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui (Radix) · Redux Toolkit (client state) ·
TanStack Query (server state) · React Router · Lucide · Recharts · React Hook Form + Zod.

## Scripts

| Command          | Purpose                                             |
| ---------------- | --------------------------------------------------- |
| `pnpm dev`       | Vite dev server (proxies `/api` → gateway)          |
| `pnpm build`     | Typecheck + production build                        |
| `pnpm typecheck` | `tsc --noEmit`                                      |
| `pnpm test`      | Vitest + React Testing Library (MSW-mocked gateway) |
| `pnpm lint`      | ESLint (incl. no-hardcoded-hex/px in className)     |

Dev API target is overridable: `VITE_GATEWAY_URL=http://localhost:8080 pnpm dev`.

## Layout

```
src/
  main.tsx · App.tsx
  app/         store, hooks, queryClient, providers, router, styles/theme.css (design tokens)
  lib/         api client (gateway), cn, format, severity, queryKeys
  store/       RTK slices: session · ui · live · filters
  routes/      route components (foundation splash for P2-1.0)
  ui/          design-system primitives + composites (P2-1.1)
  features/
    auth/      login, session (authClient), silent refresh, RequireAuth guard, permission gating
    shell/     AppShell, Sidebar (permission-gated nav), Topbar, navModel
    …          per-feature modules land here: components · hooks (Query) · <Feature>Page
  routes/      route components (Dashboard, PlaceholderPage stubs, DesignSystem, NotFound)
  test/        setup, MSW server/handlers, renderWithProviders
```

## Auth & session

- **Login** (`/login`) → `/api/identity/auth/login` (tenant via `x-tenant-id`). Access token is
  **in-memory only**; the rotating **refresh token** persists (localStorage) for silent re-auth.
- **Silent refresh:** single-flight `refreshSession()`; the http client refreshes once on a 401 and
  retries the original request. `AuthBootstrap` hydrates on load behind a splash.
- **Gating:** roles from `/auth/me` expand to permission patterns via `@vip/permissions`; nav +
  actions are deny-by-default (`usePermission` / `can`). The gateway is the real authz boundary.

## Boundaries

- **State ownership:** TanStack Query = server state; Redux = client/session/UI/live state; URL =
  view state (filters/search/time-range). No overlap (OPERATIONS_CONSOLE §11).
- **Data access:** only through the typed `lib/api` gateway client — never `fetch` in a component.
- **Tokens:** every colour/size/radius comes from `app/styles/theme.css`; no hardcoded hex/px in
  `className` (ESLint-enforced).
- **Import graph:** `app` → shared (`packages/*`) only; never services/plugins; nothing imports the app.

## Design system (`src/ui`)

- **Primitives** (shadcn/ui, Radix + cva, themed to tokens): Button, Card, Badge, Alert, Input,
  Textarea, Label, Select, Switch, Tabs, Dialog, Sheet (drawer), DropdownMenu, Tooltip, Skeleton,
  Separator, ScrollArea, Table (density-aware), Toast (sonner).
- **SOC composites** (`src/ui/soc`): StatusIndicator, SeverityBadge, MetricCard, CameraTile,
  VideoPlayerContainer, DetectionOverlay, IncidentCard, NotificationCard, Timeline, EmptyState,
  LoadingSkeletons, PageHeader, FilterBar. Import all from `@/ui`.
- **Gallery:** run `pnpm dev` and open **`/design`** — every primitive + variant + severity/status state.
- **A11y:** WCAG AA contrast verified over the oklch tokens; keyboard focus via the `focus-ring`
  utility; severity/status never colour-only; `prefers-reduced-motion` honoured.

## Status

**P2-1.0 Foundation** ✅ · **P2-1.1 Design System** ✅ · **P2-1.2 Authentication** ✅ · **P2-1.3 App
Shell & Navigation** ✅ · **P2-1.4 Dashboard** ✅ · **P2-1.8 Events** ✅ · **P2-1.9 Rules** ✅ (first
write slice — authoring + dry-run + version history over `/api/rules`). Next: **P2-1.10 Incidents** →
**P2-1.11 Alerts** (enabler-free); the Cameras/Live/Analysis/Evidence slices wait on backend enablers
G-1…G-6, per [OPERATIONS_CONSOLE §13–14](../../docs/architecture/phase2/OPERATIONS_CONSOLE.md).
