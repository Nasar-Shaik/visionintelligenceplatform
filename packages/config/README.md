# @vip/config

Centralized, typed, **fail-fast** configuration for all TypeScript services.

> **`.env` is the only secrets source** — no HashiCorp Vault, no cloud secret manager,
> no external dependency ([ADR-0018](../../docs/adr/ADR-0018-env-only-secrets-and-centralized-config.md)).
> Deployment stays: `cp .env.example .env` → edit → `docker compose up -d`.

## Purpose

- Load configuration from the environment (`.env` in dev; injected env in prod).
- **Validate at startup** and fail fast with a clear, aggregated error naming every bad key.
- Expose **strongly typed**, camelCase config **grouped by concern**.
- Guarantee **no business logic reads `process.env` directly** — everything goes through a group loader.

## Groups

| Loader                          | Reads                                                       | Returns                                                |
| ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `loadAppConfig(env, defaults?)` | `NODE_ENV`, `SERVICE_NAME`, `HOST`, `PORT`, `LOG_LEVEL`     | `{ nodeEnv, serviceName, host, port, logLevel }`       |
| `loadDatabaseConfig(env)`       | `MONGO_URI`                                                 | `{ uri }`                                              |
| `loadRedisConfig(env)`          | `REDIS_URL`                                                 | `{ url }`                                              |
| `loadNatsConfig(env)`           | `NATS_URL`                                                  | `{ url }`                                              |
| `loadStorageConfig(env)`        | `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `{ endpoint, accessKeyId, secretAccessKey }`           |
| `loadAiConfig(env)`             | `MLFLOW_TRACKING_URI`, `MLFLOW_ARTIFACTS_BUCKET`            | `{ mlflowTrackingUri, artifactsBucket }`               |
| `loadJwtConfig(env)`            | `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`           | `{ secret, accessTtl, refreshTtl }` (consumed from P1) |

Each loader validates **only its own keys**, so a service pulls just the groups it needs.

## Usage

```ts
import { loadDotEnv, loadAppConfig, loadDatabaseConfig } from '@vip/config';

loadDotEnv(); // once, at process start — best-effort; no-op if .env is absent (prod)

const app = loadAppConfig(process.env, { serviceName: 'identity', port: 8080 });
const db = loadDatabaseConfig(process.env); // throws ConfigError if MONGO_URI is missing
```

`loadDotEnv()` uses Node's built-in `process.loadEnvFile()` (Node ≥20.12) — **no `dotenv` dependency**.

## Architecture Position

`packages/` shared library; importable by any service (never imports a service/plugin).
The Python side (`ai/mlops/config.py`) follows the same philosophy independently.

## Future extension points (documentation only — not implemented)

If an enterprise customer later requires an external secret store, a single `loadDotEnv`
replacement (or a pre-start step that populates `process.env`) is the only integration
point — the group loaders are unchanged. Candidates: Vault Agent / cloud Secrets Manager
sidecar / Kubernetes Secrets mounted as env. **Not built now** (ADR-0018, principle #4).

## Testing

```bash
pnpm --filter @vip/config test        # unit tests
pnpm --filter @vip/config typecheck
pnpm --filter @vip/config lint
```

## References

[ADR-0018](../../docs/adr/ADR-0018-env-only-secrets-and-centralized-config.md) ·
[15-SECURITY §4](../../docs/architecture/15-SECURITY-ARCHITECTURE.md) ·
[CONSTRAINTS](../../docs/project/CONSTRAINTS.md).
