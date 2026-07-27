# Risk Register

> Living register. Every sprint identifies new risks and re-scores existing ones. Never delete a risk — close it with a status change.
>
> Schema: **ID · Description · Category · Impact · Probability · Severity · Mitigation · Owner · Status**.
> Severity = Impact × Probability (High/Med/Low). Statuses: `Open` · `Mitigating` · `Accepted` · `Closed`.

| ID    | Description                                                                                                                    | Category                 | Impact | Probability | Severity | Mitigation                                                                                                                                  | Owner  | Status     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------ | ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- |
| R-001 | `typescript-eslint` does not support TS 7; staying on TS 5.9.3 delays newest language features                                 | Technology / Dependency  | Low    | High        | **Low**  | Pinned latest stable 5.x; type-aware lint retained; pay-down trigger tracked ([TD-1](../../tracking/TECH-DEBT.md), typescript-eslint#10940) | Claude | Open       |
| R-002 | "Newest stable everything" policy may surface ecosystem incompatibilities as more deps are added                               | Dependency               | Med    | Med         | **Med**  | Registry-verify + install/build/test/lint before commit; document each in [DEPENDENCIES](DEPENDENCIES.md); pin exact majors                 | Claude | Mitigating |
| R-003 | Security scanners (gitleaks, semgrep) run GitHub-side and have not yet executed on a real push                                 | Security / Operational   | Med    | Med         | **Med**  | Local gate green; validate on first push to remote; treat first CI run as a gate                                                            | Claude | Open       |
| R-004 | Docker dev stack authored + config-validated but not yet launched in this environment                                          | Operational              | Med    | Med         | **Med**  | `docker compose config` validated; run `pnpm dev:stack` before P0-5/P1; add a smoke check to onboarding                                     | Claude | Open       |
| R-005 | No performance/load testing yet; NATS/Mongo/edge assumptions unproven at scale                                                 | Performance              | High   | Med         | **Med**  | Deferred by design to P2/P4; capture as [assumption A-002](ASSUMPTIONS.md); load harness via camera-simulator later                         | Claude | Open       |
| R-006 | First industry (Retail/Supermarket) not started; product-market fit unvalidated                                                | Customer                 | High   | Low         | **Med**  | Capability-first core keeps industries as plugins; defer vertical build until platform slices land                                          | Claude | Open       |
| R-007 | `pnpm audit` is advisory (non-blocking); a real vuln could slip if advisories are not triaged                                  | Security / Dependency    | Med    | Low         | **Low**  | Audit still runs + turns the log red; triage on each sprint's Quality Gate review                                                           | Claude | Mitigating |
| R-008 | Solo maintainer; branch protection intentionally deferred                                                                      | Operational              | Low    | Med         | **Low**  | `ci-summary` rollup exists to require later; CONTRIBUTING documents the flow; enable protection when collaborators join                     | Claude | Accepted   |
| R-009 | Contract-testing harness currently validates generated schemas only (no consumer-driven contracts yet)                         | Technology               | Med    | Med         | **Med**  | Harness seam in place (`tools/contracts/`); expand to consumer-driven tests as service-to-service calls appear (P1+)                        | Claude | Open       |
| R-010 | Tenant isolation is a non-enforcing seam until P1; a premature business route could trust unauthenticated context              | Security                 | High   | Low         | **Med**  | Documented in [ED-0013](ENGINEERING_DECISION_LOG.md) + [CONSTRAINTS](CONSTRAINTS.md); enforcement + isolation test suite is a P1 exit gate  | Claude | Open       |
| R-011 | Dev-stack infra image versions (Mongo/Redis/MinIO/NATS) not yet governed by the dependency policy                              | Dependency / Operational | Low    | Med         | **Low**  | P0-5 pinned postgres:17 + python:3.12; MinIO/NATS still floating `latest` — pin remaining tags next                                         | Claude | Mitigating |
| R-012 | MLflow 3.x host-header + CORS hardening can silently block internal service integration if hosts aren't allowlisted            | Operational / Technology | Med    | Med         | **Med**  | `--allowed-hosts` set for the compose service name; document for any new client host ([ED-0017](ENGINEERING_DECISION_LOG.md))               | Claude | Mitigating |
| R-013 | Python MLOps deps are pinned (`==`) but have no lockfile — transitive drift possible, unlike the pnpm `--frozen-lockfile` gate | Dependency               | Med    | Med         | **Med**  | Exact pins now; adopt a Python lockfile (uv/pip-tools) — Q-011                                                                              | Claude | Open       |
| R-014 | MLflow/Postgres/S3 dev credentials are placeholders; MLflow runs without auth/TLS (dev-scoped)                                 | Security                 | High   | Low         | **Med**  | Dev-only; prod needs auth/TLS + KMS secrets (P0-6, [ED-0015](ENGINEERING_DECISION_LOG.md))                                                  | Claude | Open       |
| R-015 | `.env`-only secrets have no built-in rotation/audit/leasing that a managed store provides                                      | Security / Operational   | Med    | Low         | **Low**  | Accepted for the self-host model (ADR-0018); protect env via OS/orchestrator; managed store is an optional future extension point           | Claude | Accepted   |

## New this sprint (Slice 3 + governance)

- **R-010** raised — tenant seam is non-enforcing in Phase 0.
- **R-009** raised — harness scope is schema-validation only.
- **R-011** raised — infra image versions not yet under dependency governance.

## New this sprint (Slice 4 — P0-5)

- **R-012** raised — MLflow host-header allowlisting required for internal clients.
- **R-013** raised — Python deps pinned but no lockfile.
- **R-014** raised — MLflow has no auth/TLS (dev-scoped).
- **R-011** downgraded to Mitigating (postgres/python images now pinned).
