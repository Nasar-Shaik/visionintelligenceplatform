# Demo & Seed

`pnpm seed` bootstraps a ready-to-use dev environment so you can log into the console and see real
data immediately — no manual database work.

## Run it

```bash
pnpm dev:stack     # Mongo must be up
pnpm seed          # idempotent — safe to re-run; replaces the same records
```

The seed writes **directly to MongoDB** (it needs no running services and no NATS), so this works
before `pnpm dev:all`.

## Default credentials

| Field        | Value                                                    |
| ------------ | -------------------------------------------------------- |
| **Tenant**   | `tnt_dev`                                                |
| **Email**    | `admin@vip.dev`                                          |
| **Password** | `DevPassw0rd!`                                           |
| Role         | `admin` (sees every console surface, including Settings) |

## What it creates

| Entity       | Detail                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Tenant       | `tnt_dev` — "Dev Tenant" (active)                                                                             |
| Organization | Root org node                                                                                                 |
| Admin user   | `admin@vip.dev` (password hashed with the same KDF identity uses)                                             |
| Camera       | "Front Entrance" (RTSP, online)                                                                               |
| Rule         | "Person detected — Front Entrance" (enabled; `perception.person.detected`, confidence ≥ 0.8 → raise incident) |
| Event        | A `perception.person.detected` detection (92% confidence)                                                     |
| Incident     | "Person detected — Front Entrance" (raised, high)                                                             |
| Alert        | An in-app notification for that incident (delivered)                                                          |

## Walk through the console

Start everything (`pnpm dev:all`), open **http://localhost:5173**, and log in.

1. **Dashboard** (`/`) — KPI tiles + active-incidents + camera-health panels populate from the seed.
2. **Events** (`/events`) — the seeded detection appears; try the severity filter / search.
3. **Rules** (`/rules`) — the seeded rule is **Enabled**. Open it; use **Dry run** with the sample
   event to see the prefilter → condition → window breakdown. Toggle enable/disable.
4. **Incidents** (`/incidents`) — the raised incident is in the queue. Open the drawer and walk the
   lifecycle: **Acknowledge → Resolve → Close** (watch the timeline grow).
5. **Alerts** (`/alerts`) — the delivered notification is listed; **Acknowledge** it.

### Permission behaviour

The admin sees and can do everything. To see deny-by-default gating, create a `viewer`/`operator`
user (via the identity API or another seeded user) — a viewer gets read-only surfaces with no action
buttons; an operator can ack/resolve incidents and ack alerts but not author rules.

## Reset

Re-running `pnpm seed` restores the same records. To wipe entirely, drop the `vip` database (or
`pnpm dev:stack:down` and remove the `mongo_data` volume) and seed again.
