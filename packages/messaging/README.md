# @vip/messaging

The event backbone client (Phase 1, **P1-5**). A thin, **fail-closed** wrapper over **NATS JetStream**
([ADR-0016](../../docs/adr/ADR-0016-nats-jetstream-event-backbone.md)) that keeps the heavy client
out of every service: the platform depends only on the `EventBus` port. Grounds:
[09-EVENT-PLATFORM](../../docs/architecture/09-EVENT-PLATFORM.md),
[EVENT_PIPELINE](../../docs/architecture/phase1/EVENT_PIPELINE.md), ADR-0005.

## What it provides

- **Tenant-partitioned subjects** `t.{tenantId}.…` with structural validation — a `.`/`*`/`>`/space in
  a tenant id is rejected (Law 5), so a consumer can never silently widen across tenants.
  - capability outputs (detections): `t.{tenantId}.capability.output.{capabilityId}`
  - persisted / domain events: `t.{tenantId}.event.{eventType}`
- **`EventBus` port** — durable `publish` (optional `msgId` for source-side dedup) + durable pull
  `subscribe` whose handler explicitly `ack`/`nak`/`term`s each message (at-least-once + idempotent
  consumers). `term()` is the dead-letter path: a poison message (e.g. missing tenant) is terminated,
  never redelivered; the bus itself terminates a message that exceeds `maxDeliver`.
- **`NatsEventBus`** — the JetStream implementation (`@nats-io` v3, pure-JS, no native addon). The
  only file that imports the client.
- **`InMemoryEventBus`** — a broker-free bus that mirrors JetStream subject routing + msg-id dedup, for
  unit tests and local wiring.
- **`JetStreamEventPublisher`** — backs each service's existing `publish({ type, tenantId, payload })`
  domain-event seam, turning lifecycle events into durable publishes with no change to app logic.

## Usage

```ts
import { NatsEventBus, CAPABILITY_OUTPUT_STREAM, ALL_CAPABILITY_OUTPUTS } from '@vip/messaging';

const bus = await NatsEventBus.connect({ servers: config.nats.url });
await bus.ensureStream(CAPABILITY_OUTPUT_STREAM, [ALL_CAPABILITY_OUTPUTS]);

await bus.subscribe(
  { stream: CAPABILITY_OUTPUT_STREAM, durable: 'events', filterSubject: ALL_CAPABILITY_OUTPUTS },
  async (m) => {
    const detectionResult = m.json();
    // normalize → dedup → persist → publish t.{tenant}.event.*
    m.ack();
  },
);
```

## Tested

Pure logic is CI-covered (subjects, routing, msg-id dedup, publisher seam, fail-closed tenant tokens).
The live JetStream path is validated against the dev-stack NATS (integration).
