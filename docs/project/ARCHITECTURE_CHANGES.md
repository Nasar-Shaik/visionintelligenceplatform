# ARCHITECTURE CHANGES (post-freeze)

> The architecture is **frozen at v1.0** (2026-07-27). Every change after the freeze happens **only through an ADR** and is logged here, newest first. This is the human-readable trail of how the frozen baseline has evolved.

| Date       | Change                                                                                         | ADR                                                          | Docs updated              |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------- |
| 2026-07-27 | Event backbone technology = **NATS JetStream** (was Kafka/Redpanda placeholder); resolves ND-1 | [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md) | TECH-STACK, 04, 09, 18    |
| 2026-07-27 | TS service framework = **Fastify** (was Express placeholder)                                   | [ADR-0017](../adr/ADR-0017-fastify-control-plane.md)         | TECH-STACK, (23 template) |

Both are **technology selections**, not philosophy changes — capability/event/contract abstractions are unaffected.

## How to add a row

1. Write the ADR ([`docs/adr/`](../adr/), next number, `Proposed`→`Accepted`).
2. Update the affected `docs/architecture/NN-*.md` and/or `docs/reference/*`.
3. Add a row here and a line in [`tracking/PROGRESS.md`](../../tracking/PROGRESS.md) changelog.
