# ADR-0008 — Connector Platform for external system integration

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Enterprise Architecture Review
- **Touches:** Law 1, Law 3, Principle 3; docs/architecture/25, 20, 09

## Context

Real deployments must integrate with external systems — POS, ERP, HMS, school ERP, RFID, access control, attendance, messaging (Email/SMS/WhatsApp), and industrial/IoT buses (MQTT, Kafka, Modbus, OPC-UA, BACnet). Ad-hoc integrations would scatter industry/vendor logic into the core (violating Law 1) and couple services to external protocols.

## Decision

Introduce a **Connector Platform** ([25](../architecture/25-CONNECTOR-PLATFORM.md)): connectors are **plugins** implementing a uniform `connector.provider` extension point, translating between external systems and the platform's event/contract surface. **Inbound** connectors ingest external signals as normalized events (e.g. `pos.transaction`); **outbound** connectors deliver platform events/actions to external systems (e.g. open a door via access control). Connectors carry no core dependency and are tenant-scoped, entitlement-gated, and audited.

## Alternatives considered

- **Point integrations inside services.** Fast for one customer; but leaks vendor logic into core, unmaintainable at N integrations. Rejected — violates Law 1.
- **Only generic webhooks.** Covers HTTP; but not Modbus/OPC-UA/BACnet/MQTT or stateful bidirectional systems. Insufficient.

## Consequences

- Positive: any external system integrates as a plugin; POS/access/SIEM/industrial buses supported uniformly; core stays generic.
- Negative/cost: a connector runtime, credential vaulting per connector, protocol adapters, and connector health/observability.
- Follow-ups: [25](../architecture/25-CONNECTOR-PLATFORM.md) created; `connector.provider` added to [20](../architecture/20-EXTENSIBILITY.md); inbound events registered in the event catalog ([09](../architecture/09-EVENT-PLATFORM.md)).

## Compliance

Connectors are event-driven plugins (Laws 1 & 3); external integration never enters the core.
