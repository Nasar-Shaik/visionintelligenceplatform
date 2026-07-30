# Run the Full Stack Locally

How to run the entire platform — infrastructure, all backend services, and the Operations Console —
on one machine.

## 1. Infrastructure (Docker)

```bash
pnpm dev:stack          # up -d
pnpm dev:stack:logs     # tail
pnpm dev:stack:down     # stop
```

Host ports (from `.env`; the `4xxxx` range avoids clashing with other local projects):

| Service                 | Host port         |
| ----------------------- | ----------------- |
| MongoDB                 | `47017`           |
| Redis                   | `46379`           |
| MinIO (API / console)   | `49000` / `49001` |
| NATS (client / monitor) | `44222` / `48222` |
| MLflow                  | `45000`           |

## 2. Build

```bash
pnpm build              # compiles all workspace packages (services import each other's dist)
```

`dev:all` already depends on this, so you rarely run it by hand.

## 3. Services + console

```bash
pnpm dev:all            # every service + the console, concurrently (Turborepo, watched)
```

Or narrow it:

```bash
pnpm dev:services                          # all services, no console
pnpm dev:web                               # just the console (Vite)
pnpm --filter @vip/service-gateway dev     # a single service
```

### Service port map

Each service has a **distinct default port**, so `pnpm dev:all` works with zero env config. The
gateway is the single edge the console talks to; it reverse-proxies `/api/<service>/*` to the
matching upstream.

| Service       | Port     | Notes                                                  |
| ------------- | -------- | ------------------------------------------------------ |
| **gateway**   | **8080** | The console proxies `/api/*` here (`VITE_GATEWAY_URL`) |
| identity      | 8089     | `/api/identity/*` — auth + users                       |
| tenant        | 8081     | `/api/tenant/*`                                        |
| camera        | 8082     | `/api/camera/*`                                        |
| media         | 8083     | `/api/media/*`                                         |
| events        | 8084     | `/api/events/*`                                        |
| _(inference)_ | 8085     | Python runtime (separate; not part of `dev:all`)       |
| rules         | 8086     | `/api/rules/*`                                         |
| workflow      | 8087     | `/api/workflow/*`                                      |
| notify        | 8088     | `/api/notify/*`                                        |
| **console**   | **5173** | Vite dev server                                        |

Override any port with `PORT=<n> pnpm --filter <svc> dev`; if you move the gateway, point the console
at it with `VITE_GATEWAY_URL=http://localhost:<n> pnpm dev:web`.

## 4. Log in

Open **http://localhost:5173**. If you haven't seeded yet, run `pnpm seed` (see [DEMO](DEMO.md)) and
log in with `tnt_dev` / `admin@vip.dev` / `DevPassw0rd!`.

## How auth flows through the gateway

The console never talks to a service directly — it calls the gateway, which validates the access
token and injects trusted tenant/principal context before proxying. The **only** unauthenticated
passthroughs are the auth-bootstrap endpoints (`POST /api/identity/auth/{login,refresh,logout}`),
because they are how a client obtains a token in the first place. Everything else requires a valid
bearer token.

## Troubleshooting

| Symptom                              | Fix                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Console data spins / network errors  | The gateway isn't up. `pnpm dev:all` (or at least `dev:services`).                         |
| Login returns 401                    | No seeded tenant/user, or wrong tenant id. Run `pnpm seed`; log in with `tnt_dev`.         |
| A service exits: config/secret error | `.env` missing — `cp .env.example .env`. Services find the repo-root `.env` automatically. |
| Port already in use                  | Change the `*_PORT` in `.env` (infra) or `PORT=<n>` for a service.                         |
| `pnpm seed` fails to connect         | The stack isn't up. `pnpm dev:stack` first.                                                |
