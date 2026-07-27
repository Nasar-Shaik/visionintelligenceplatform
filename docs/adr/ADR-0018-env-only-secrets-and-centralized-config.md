# ADR-0018 — `.env`-only secrets & centralized configuration

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Repo owner (deployment-simplicity directive) + development
- **Touches:** Principle 8 (12-factor); docs/architecture/15 §4; P0-6; supersedes the earlier "Vault/cloud-KMS" secrets assumption ([Q-006](../project/OPEN_QUESTIONS.md))

## Context

Phase-0 task P0-6 was originally framed as "wire a Vault / cloud-KMS integration pattern." The repo owner set an explicit deployment philosophy: the platform must stay **simple to deploy and self-host** — a new deployment should be `cp .env.example .env` → edit → `docker compose up -d`, with **no additional infrastructure**. External secret services (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, Google Secret Manager) must **not** be required or integrated now.

This decision governs **application/deployment secrets and configuration** (DB passwords, connection strings, API keys, JWT secrets). It does **not** change data-protection concepts elsewhere in the architecture (per-tenant KMS envelope encryption for evidence/PII, camera/connector credential vaulting) — those remain as architected and are separate concerns.

## Decision

1. **`.env` is the only secrets source.** In development a gitignored `.env` (from `.env.example`); in production the orchestrator injects the same variables as real environment variables (no file). No external secret manager is required or integrated.
2. **Centralized configuration package `@vip/config`.** All TypeScript services load configuration through it — **no business logic reads `process.env` directly**. It:
   - loads `.env` via Node's built-in `process.loadEnvFile()` (**no `dotenv` dependency**);
   - **validates at startup and fails fast** with a clear, aggregated error naming every offending key;
   - exposes **strongly typed**, camelCase config **grouped by concern** (`app`, `database`, `redis`, `storage`, `nats`, `ai`, `jwt`);
   - lets each service import only the groups it needs.
     The Python side (`ai/mlops/config.py`) follows the same philosophy independently (stdlib, typed, fail-fast).
3. **Future integrations are documentation-only extension points.** If an enterprise customer later needs Vault / cloud secret managers / Kubernetes Secrets, the single integration point is populating `process.env` before start (a sidecar/agent or a `loadDotEnv` replacement) — the group loaders are unchanged. **Not built now.**

## Alternatives considered

- **HashiCorp Vault (self-host).** Powerful (dynamic secrets, leasing) but adds a service every self-hosted deployment must run — rejected against the simplicity directive.
- **Cloud KMS / Secrets Manager.** Least prod ops but couples to a cloud and weakens local/self-host parity — rejected as a requirement (kept as an optional future extension point).
- **A `SecretsProvider` abstraction now, backend later.** Rejected: adds an interface with no immediate second implementation (violates "no abstraction without immediate value").
- **`dotenv` package.** Unnecessary — Node ≥20.12 provides `process.loadEnvFile()`.

## Consequences

- **Positive:** trivial deployment; one typed, validated config surface; fail-fast on misconfiguration; zero new runtime dependencies; identical dev/prod code path.
- **Negative/cost:** no built-in secret rotation/audit that a managed store would provide (acceptable for the target self-hosted model; revisit per enterprise customer). Operators must protect `.env`/injected env by OS/orchestrator means.
- **Follow-ups:** `.env.example` header + [docs/architecture/15 §4](../architecture/15-SECURITY-ARCHITECTURE.md) updated to reflect `.env`-based secrets with documented optional extensions. Q-006 resolved.

## Compliance

Reinforces Principle 8 (12-factor: config in the environment). No change to the frozen data-protection model (encryption/KMS for evidence, credential vaulting) — those remain in [15](../architecture/15-SECURITY-ARCHITECTURE.md). Evaluated against the owner's primary test ("Is this required today? If no, don't build it"): external secret managers are **not** built now, only documented as extension points.
