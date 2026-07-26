# edge/ — Edge Platform

The tenant-bound, offline-capable on-premise runtime. Runs the **same capability contracts** as the cloud; placement decides what executes here ([ADR-0004](../docs/adr/ADR-0004-edge-first-placement.md)).

## Layout
```
agent/        Containerized edge runtime: ingest→decode→frame-extract→capability DAG→
              embedded event log→rule engine→evidence(ring buffer + local store)→sync client→OTA client
sync/         Store-and-forward reconciliation (idempotent, conflict resolution)
ota/          Signed, staged, rollback-able agent + model updates (INT8 quantization)
provisioning/ Device identity (TPM/secure element), enrollment, mTLS certs
```

## Non-negotiables
- Full **offline** operation during WAN loss; **no data loss** on reconnect (chaos-tested — milestone M6).
- Tenant-bound; local storage encrypted; same tenant context as cloud.
- Managed at fleet scale by `services/fleet` (config sync, health, OTA campaigns, remote wipe).

See [14-EDGE-PLATFORM](../docs/architecture/14-EDGE-PLATFORM.md).
