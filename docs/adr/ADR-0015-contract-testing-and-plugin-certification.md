# ADR-0015 — Contract testing & plugin certification gate

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Final Architecture Enhancement (v1.0), Engineering Director
- **Touches:** Law 4, Principles 6, 14; docs/architecture/03, 20

## Context

The platform is contract-first ([00 §7](../00-ENGINEERING-CONSTITUTION.md)) and plugin-based ([20](../architecture/20-EXTENSIBILITY.md)). To keep a large, multi-agent, plugin ecosystem safe over 10 years, contracts must be **verified automatically**, and plugins (including third-party) must be **certified** before they can run in production.

## Decision

1. **Contract testing** across every contract type — API, capability, event, connector, plugin, workflow, rule, configuration, and model-adapter — runs in CI; a change that breaks a published contract fails the build. Every plugin must **pass contract validation before loading** (the loader refuses non-conforming plugins).
2. **Plugin certification**: a plugin is production-enabled only after passing a certification pipeline (compatibility, security scan, performance/memory/CPU/GPU budgets, version compatibility, documentation, tests, API/capability compliance, observability, health checks), yielding a signed certification bound to a platform-API range and trust tier.

## Alternatives considered

- **Manual review only.** Doesn't scale to many plugins/agents; inconsistent. Rejected.
- **Runtime failure instead of pre-load validation.** Unsafe in production; a bad plugin can degrade the pipeline. Rejected — validate/certify before enable.

## Consequences

- Positive: contracts can't silently drift; only vetted plugins run in production; safe open ecosystem for regulated customers.
- Negative/cost: build/certification tooling and per-contract test suites (part of Definition of Done).
- Follow-ups: [03 §Contract testing](../architecture/03-ARCHITECTURE-PRINCIPLES.md) and [20 §Plugin certification](../architecture/20-EXTENSIBILITY.md) added; certification integrates with the registry ([23](../architecture/23-SERVICE-OWNERSHIP.md)).

## Compliance

Enforces Law 4 (contract-first) and hardens Principle 14 (extensible) — mechanism, not philosophy change.
