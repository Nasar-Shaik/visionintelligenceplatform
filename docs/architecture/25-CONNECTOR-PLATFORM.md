# 25 — Connector Platform

> Enterprise Architecture Review addition. Integrations with external systems are **plugins**, never core code. Ratified by [ADR-0008](../adr/ADR-0008-connector-platform.md).

## Purpose
Provide a uniform framework for integrating the platform with external systems — business (POS, ERP, HMS, school ERP, attendance), security/physical (RFID, access control), messaging (Email/SMS/WhatsApp), and industrial/IoT buses (MQTT, Kafka, Modbus, OPC-UA, BACnet) — so any integration is added as a plugin without touching or coupling the core (Law 1).

## Responsibilities
- Define the connector contract (inbound + outbound) and the `connector.provider` extension point.
- Translate between external systems and the platform's **event/contract surface** ([09](09-EVENT-PLATFORM.md)).
- Own connector instances, credentials, mappings, health, and audit.

---

## 1. Model: connectors are event-boundary plugins

```
        INBOUND                                   OUTBOUND
External system ──▶ Connector ──▶ connector.inbound.* ──▶ EVENT PLATFORM
                                                          │
EVENT PLATFORM ──▶ incident.*/workflow.*/rule-action ──▶ Connector ──▶ External system
```
- **Inbound connectors** ingest external signals and normalize them into platform events (e.g. POS → `pos.transaction`, access control → `access.door.opened`, RFID → `asset.tag.read`). Those events then feed compositions/rules exactly like vision events — enabling e.g. **video↔POS correlation** with zero core change.
- **Outbound connectors** deliver platform events/actions to external systems (e.g. open a door, post to a ticketing system, publish to an MQTT topic, write a Modbus register, send WhatsApp).

## 2. The connector contract

```yaml
connector:
  id: connector.pos.generic
  version: 1.0.0
  direction: [inbound]                 # inbound | outbound | bidirectional
  protocol: rest                       # rest|graphql|webhook|mqtt|kafka|modbus|opcua|bacnet|smtp|sms|...
  trust_tier: verified-partner         # first-party | verified-partner | community
  config_schema:                       # tenant-provided connection config
    endpoint: {type: url}
    auth: {type: secretRef}            # credentials vaulted, never inline
  inbound_mapping:                     # external → normalized event
    - from: "$.txn"
      to_event: pos.transaction
      map: { amount: "$.total", lane: "$.register", items: "$.lines[*].sku" }
  outbound_subscriptions:              # platform events → external calls (for outbound)
    - on_event: incident.raised
      action: POST {endpoint}/alerts
  health: { probe: "GET {endpoint}/health", interval: 60s }
```

**Every connector declares:** direction · protocol · config schema · inbound event mapping and/or outbound subscriptions · trust tier · health probe. It behaves as a plugin under the same loader/registry/trust-tier rules as other plugins ([20](20-EXTENSIBILITY.md)).

## 3. Supported protocols & adapters (initial)
- **Web/API:** REST, GraphQL, Webhook (HMAC-signed).
- **Messaging:** Email (SMTP), SMS, WhatsApp — (these also back Notification channels).
- **Streaming/IoT:** MQTT, Kafka.
- **Industrial/building automation:** Modbus, OPC-UA, BACnet.
- **Business/physical systems** are built **on top** of these protocol adapters: POS, ERP, HMS, school ERP, RFID, access control, attendance — shipped as connector plugins (often within Industry Packs).

## 4. Governance & isolation
- Connectors are **tenant-scoped, entitlement-gated, and audited**; credentials are vaulted per instance ([15 §4](15-SECURITY-ARCHITECTURE.md)).
- Inbound event types register in the **event catalog** ([09 §2](09-EVENT-PLATFORM.md)) so rules/compositions can consume them.
- Connector failures are isolated per instance (retry + dead-letter); a broken connector never affects the vision pipeline.
- Trust tiers gate what a connector may do; community connectors run sandboxed with restricted scopes.

## Design decisions
- **Connectors sit at the event boundary**, so external systems become first-class event sources/sinks without the core learning any vendor protocol.
- **Reusing protocol adapters** (REST/MQTT/Modbus/…) under named business connectors avoids re-implementing transport per integration.
- **Notification channels and outbound connectors share machinery** (both deliver to external systems) but stay distinct concerns.

## Advantages
- Any external system integrates as a plugin; POS/access/SIEM/industrial buses supported uniformly.
- Video intelligence correlates with business/physical/IoT data (e.g. shrink = video + POS) with no core change.
- Partners/OEMs publish connectors via the marketplace.

## Tradeoffs
- A connector runtime, protocol adapters, and per-connector credential/health management are real infrastructure; contained entirely in the Connector context and `plugins/` — the core stays generic.

## Future expansion
- Connector marketplace with revenue share; bidirectional stateful connectors; connector-level transformation pipelines; more industrial protocols and sensor gateways feeding the Digital Twin ([26](26-DIGITAL-TWIN.md)).

## Cross-references
[20-EXTENSIBILITY](20-EXTENSIBILITY.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [13-INDUSTRY-PACKS](13-INDUSTRY-PACKS.md) · [15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md) · [ADR-0008](../adr/ADR-0008-connector-platform.md)
