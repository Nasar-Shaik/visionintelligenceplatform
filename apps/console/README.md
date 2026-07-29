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
  features/    per-feature modules: components · hooks (Query) · <Feature>Page (later slices)
  test/        setup, MSW server/handlers, renderWithProviders
```

## Boundaries

- **State ownership:** TanStack Query = server state; Redux = client/session/UI/live state; URL =
  view state (filters/search/time-range). No overlap (OPERATIONS_CONSOLE §11).
- **Data access:** only through the typed `lib/api` gateway client — never `fetch` in a component.
- **Tokens:** every colour/size/radius comes from `app/styles/theme.css`; no hardcoded hex/px in
  `className` (ESLint-enforced).
- **Import graph:** `app` → shared (`packages/*`) only; never services/plugins; nothing imports the app.

## Status

**P2-1.0 Foundation** — scaffold, design-system tokens, store/query/router/API client wired.
Design system primitives (P2-1.1) and feature pages follow per [OPERATIONS_CONSOLE §14](../../docs/architecture/phase2/OPERATIONS_CONSOLE.md).
