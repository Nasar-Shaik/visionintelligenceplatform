# Upgrading a deployment

Images are built from source on the host, so an upgrade is: fetch the new source, rebuild, replace
containers. Compose recreates only what changed.

---

## 1. Before you touch anything

```sh
infra/docker/backup.sh
```

Not optional. [ROLLBACK.md](ROLLBACK.md) can restore the _code_ in a minute, but a migration that
has already run against the database is only undone by a restore.

Record what you are on, so rollback has a target:

```sh
git -C /opt/vip rev-parse HEAD > /opt/vip/backups/last-known-good.sha
```

---

## 2. Read what changed

```sh
git fetch --all
git log --oneline HEAD..origin/main
git diff HEAD..origin/main -- .env.production.example
```

The third command is the one people skip. A new required variable is declared `${VAR:?}` in compose,
so the stack **refuses to start** rather than running misconfigured — good, but you would rather find
out now than during the window.

If `.env.production.example` gained a variable, add it to your `.env.production` before deploying.

---

## 3. Upgrade

```sh
git pull
infra/docker/prod.sh up -d --build
```

`up -d --build` rebuilds every image and recreates only containers whose image or configuration
changed. Data volumes are untouched.

Expect a brief per-service interruption as each is replaced. `stop_grace_period` is 20 s so a service
finishes what it is doing — a process SIGKILLed mid-write while appending an audit record is exactly
the loss immutable history cannot repair.

### Upgrading one service

```sh
infra/docker/prod.sh up -d --build gateway
```

Valid when the change is genuinely scoped to that service. It is not valid when a shared package
(`@vip/contracts`, `@vip/config`, `@vip/messaging`) changed — those are compiled into **every**
image, and a partial upgrade leaves services disagreeing about a contract. When in doubt, rebuild
everything; it costs minutes, and a contract skew costs an investigation.

---

## 4. Verify

```sh
infra/docker/prod.sh ps                 # 15 healthy, one host-port row (the proxy)
curl -kfsS https://localhost/ready      # {"status":"pass",…}
infra/docker/prod.sh logs --since 5m | grep '"level":50'
```

Then the browser loop from [DEPLOYMENT.md §5](DEPLOYMENT.md). An upgrade that passes health checks
and cannot play a recording has not been verified — that is precisely the failure P-5.8 found, and
`/ready` was green throughout it.

---

## 5. Database and index changes

Services reconcile their own indexes at startup, including dropping and recreating an index whose key
set changed under an existing name. There is no separate migration step and no migration tool.

Consequences worth knowing:

- **Index changes happen on the way up.** A service with a large collection may take longer to become
  healthy on first start after an upgrade. Do not interpret that as a hang.
- **Adding a field is safe.** Documents are read with defaults applied, so old rows load under new
  code.
- **Removing or renaming a field is not automatically safe.** Nothing rewrites existing documents.
  Any release that needs that says so in its notes and ships the step.

---

## 6. If it goes wrong

Go to [ROLLBACK.md](ROLLBACK.md). Decide quickly: rolling back a bad release in the first minutes is
routine, and diagnosing it live while operators cannot work is not.
