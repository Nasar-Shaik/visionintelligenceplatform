# System Health

**Milestone P-6.4 · recorded 2026-08-04 against the production deployment**

▶ [`system-health.webm`](system-health.webm) — 1280×720

## What this demonstrates

The page reads healthy across ten services, three infrastructure dependencies and seven
capabilities. Then **object storage is stopped underneath it**, and the page says so on its own —
no refresh, no reload — in about sixteen seconds. Then storage comes back and the page clears
itself.

That is the whole claim: **truthful operational state**, not a wall of green icons.

Three things worth pointing at while it plays:

- **Seven states, in words.** Healthy · Degraded · Unavailable · Not configured · Not built ·
  Forbidden · Unknown. Colour is the secondary channel; the word is the primary one. Three of the
  seven are some shade of "not working" and two of those are nobody's fault.
- **Degraded is not Unavailable.** When storage fails, Evidence and Media report **Degraded** —
  they answered; their dependency did not — while Object storage itself reports **Unavailable**.
  The operator is sent to the dependency, not to the service.
- **It never says "All systems operational."** That sentence is only true if every component is
  `ready`, and `unknown` is not `ready`. The summary counts what is actually known.

## The engineering claim behind it

Health is read from **readiness** (`/ready`), never from liveness (`/health`). Every service's
`/health` returns `{"status":"ok"}` unconditionally — it cannot fail while the process can answer,
so a page built on it is green by construction. Demonstrated in verification: with MongoDB paused,
every liveness probe still answered `ok` while the platform could not serve a single request.

Infrastructure rows are **derived** from what the services report about their own dependencies.
Nothing opens a socket to MongoDB. One call from the browser, one fan-out inside the cluster,
cached 5 s so concurrent viewers collapse into one — **p50 2.9 ms, p95 4.9 ms** through the edge.

## Screenshots

[healthy](../../review/p6/screens/health-02-healthy.png) ·
[one service down](../../review/p6/screens/health-03-service-down.png) ·
[a database outage](../../review/p6/screens/health-04-database-outage.png) ·
[gateway unreachable, last reading kept](../../review/p6/screens/freeze-health-02-gateway-down.png) ·
[partial degradation](../../review/p6/screens/freeze-health-03-partial-degradation.png) ·
[mixed state](../../review/p6/screens/freeze-health-04-mixed.png) ·
[permission denied](../../review/p6/screens/health-06-forbidden.png) ·
[phone](../../review/p6/screens/health-05-phone.png)

## What the freeze pass measured

Every dependency taken away one at a time, **held down until the screen said so** rather than
restarted — a container that is out for three seconds behind a five-second cache on a fifteen-second
refresh is invisible by arithmetic, which is what P-6.4 learned when six restart checks failed
against a page that was right.

⚠️ The reading tool had to be fixed before the readings meant anything: it took the row's label from
the first `<p>, span` in the row, which for a **healthy** row is the state dot's empty `<span>`, so
healthy rows were dropped entirely and the run reported that MinIO went away in ten seconds and
**never came back** — on a platform where it had recovered in fifteen. _A reading that can only see
the states it is looking for will confirm whatever it expects._

Screenshots added: [degraded, live](../../review/p6/screens/freeze-system-02-degraded.png) ·
[recovered after a restart](../../review/p6/screens/freeze-system-03-recovered-after-restart.png)

## ⚠️ Known limitations — say these before a customer finds them

- **It is a live reading, not a history** (L-28). "Was it down last night?" is not answerable from
  the product. The deployment exposes `/health` and `/ready` for the customer's own uptime monitor,
  which is where that question belongs.
- **It samples every 15 seconds.** A component that fails and recovers inside that window is never
  seen — measured, not assumed: a three-second container restart is invisible by arithmetic.
- **A hung dependency reads as Unavailable rather than Degraded** (L-29 · TD-50). A blocked
  readiness check and a stopped container look the same from outside. Mitigated on the page: the
  dependency keeps its own row and reads `Unknown — nothing can speak for it`, which is the signal
  that the services share a cause.
- **A viewer cannot see this page at all.** Deliberate — `system:inspect` is granted to
  administrators and operators only.
- **No alerting.** Nothing here pages anyone. Platform alerting belongs to the customer's monitoring,
  not to a page somebody has to be watching.
