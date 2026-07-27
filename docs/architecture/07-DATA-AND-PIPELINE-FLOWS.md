# 07 — Data, Video, AI & Event Flows

## Purpose
Define the end-to-end runtime flows: how a frame becomes a detection, an event, an incident, an alert, and evidence — and how data moves through the planes. This is the "verbs" companion to the "nouns" in [04](04-SYSTEM-OVERVIEW.md) and [05](05-CAPABILITY-ARCHITECTURE.md).

## Responsibilities
- Specify the primary pipeline and every named sub-flow (video, AI/inference, event, rule, workflow, alert, evidence, incident, API, auth).
- Define where each stage runs (edge/cloud) and the reliability guarantees.

---

## 1. Master pipeline / execution graph (frame → value)

The runtime execution graph — every processing stage from camera to dashboard:

```
Camera ─▶ RTSP/RTMP Ingest ─▶ Frame Decoder ─▶ Frame Sampling (adaptive + motion-gate)
       ─▶ Inference ─▶ Tracking ─▶ [Capability DAG: Pose/ReID/OCR/Attribute/Fire/… + Spatial(zone/line/speed) + Behavior/Anomaly]
       ─▶ COMPOSITION LAYER (people-counting / queue / occupancy / perimeter / safety …)
       ─▶ EVENT PLATFORM ─▶ RULE ENGINE ─▶ (match) ─▶ WORKFLOW ENGINE
       ─▶ Evidence(clip+snapshot+timeline) ─▶ Notification ─▶ Analytics/Search + Digital Twin ─▶ Dashboards/API
```

Stage responsibilities: **Ingest** (session/reconnect/backpressure) → **Decode** (HW-accelerated) → **Frame Sampling** (per-capability FPS, motion gating) → **Inference** (model-agnostic detections) → **Tracking** (stable IDs) → **Capability DAG** (perception/spatial/reasoning nodes) → **Composition** (reusable business measures → higher-order events, [24](24-COMPOSITION-FRAMEWORK.md)) → **Event Platform** (normalize/dedup/correlate) → **Rule Engine** (tenant meaning) → **Workflow** (response) → **Evidence / Notification / Analytics / Digital Twin** (outputs).

Stages up to Composition are **capabilities/compositions** wired as a DAG by the Execution Scheduler ([05 §4b](05-CAPABILITY-ARCHITECTURE.md)); everything from the Event Platform onward is the composition backbone. **Steps run at the edge when an edge box is present** (real-time, offline, bandwidth-saving), shipping only events/evidence upstream; pure-cloud relays streams to cloud GPU workers; hybrid splits by capability placement.

## 2. Video flow

1. **Onboard**: ONVIF discovery or manual RTSP/RTMP; credentials to vault; capture metadata (resolution, FPS, codec H.264/H.265, PTZ); health heartbeat + auto-reconnect. → [14](14-EDGE-PLATFORM.md)
2. **Ingest**: media service pulls RTSP / accepts RTMP; maintains session, reconnection, backpressure.
3. **Renditions**: **WebRTC** (sub-second live), **HLS** (scalable playback), snapshots/thumbnails. All via short-lived **signed URLs**, authorized per camera per user.
4. **Decode**: hardware-accelerated (NVDEC/CUDA at edge/GPU, VAAPI/QuickSync via OpenVINO on Intel) → raw frames.
5. **Ring buffer**: rolling pre-roll buffer (e.g. 30–60s) per camera in memory/edge disk → enables pre-event evidence.
6. **Recording (optional)**: segment recording for compliance; default is smart-clip-only. → [12](12-EVIDENCE-MANAGEMENT.md)

## 3. AI / inference flow

1. **Frame extraction**: adaptive sampler picks per-capability FPS; **motion gating** skips static frames (largest compute saving); frames batched to accelerator.
2. **Capability DAG execution**: detection → tracking → (pose/reID/OCR/face/fire/…) → spatial → behavior/anomaly, per [05 §4](05-CAPABILITY-ARCHITECTURE.md). Model-agnostic runtime loads pinned registry model versions. → [08](08-AI-ML-PLATFORM.md)
3. **Normalization**: each capability emits a typed output; perception outputs a normalized detection `{type, bbox, trackId, confidence, zone, ts, attributes, thumbnailRef}`.
4. **Placement & scheduling**: scheduler assigns nodes edge/cloud by resource profile, accelerator, latency class, connectivity; safety-critical prefers edge; heavy/batch (embeddings, temporal action, search) prefers cloud.
5. **Two-stage confirmation** for high-severity (weapon/violence): fast edge detector → cloud/secondary verifier before escalation, to cut false positives. → [08](08-AI-ML-PLATFORM.md)

## 4. Event flow

Capability outputs are lifted into **events** on the durable backbone. The Event Platform deduplicates, correlates (same actor across cameras/time), assigns priority, and persists. Raw high-volume detections are TTL'd; events persist per retention. → [09](09-EVENT-PLATFORM.md)

## 5. Rule flow

The Rule Engine subscribes to events, evaluates tenant-defined rules (compiled condition trees; stateful conditions like dwell/sequence/cooldown tracked in Redis), scoped by tenant/branch/site/zone/camera, and emits **rule-match** outcomes (e.g. `incident.candidate`). Deterministic, low-latency, testable, dry-runnable against recorded data. → [10](10-RULE-ENGINE.md)

## 6. Workflow flow

A rule match instantiates a **workflow** (incident/case): assignment, escalation timers, approvals, operator/manager actions, SLA tracking, and audit — all declarative. Workflows can call actions (notify, extract evidence, webhook, PTZ preset, relay/siren, add-to-case). → [11](11-WORKFLOW-ENGINE.md)

## 7. Alert / notification flow

The Notification capability routes workflow/rule actions to channels (email/SMS/WhatsApp/push/voice/webhook/Slack/Teams) per escalation policy, with dedupe, quiet hours, retries, delivery logging, and acknowledgment tracking. Target: **< 3 s** event→notification for critical events. → [11](11-WORKFLOW-ENGINE.md)

## 8. Evidence flow

On event/incident: extract **pre-roll (from ring buffer) + post-roll**, dynamically extend while behavior continues, **merge overlapping** windows, transcode to MP4 + thumbnail/sprite, build the **timeline**, store to object storage (`{tenantId}/{cameraId}/{eventId}`, KMS-encrypted, retention-tagged), index embeddings for search, and record **chain of custody**. → [12](12-EVIDENCE-MANAGEMENT.md)

## 9. Incident flow

Incidents aggregate related events/evidence into a reviewable case with state (open→ack→investigating→resolved→closed), owner, notes, linked evidence, and audit — the human-facing unit of the Workflow Engine. → [11](11-WORKFLOW-ENGINE.md)

## 10. API flow

External clients call `POST/GET /api/v1/*` through the gateway → authN/Z + tenant routing + rate limit → service (gRPC internally) → response envelope `{success,data,meta,error}`. Long-running/reactive results delivered via **WebSocket** and **webhooks**. → [21](21-API-ARCHITECTURE.md)

## 11. Authentication flow

`client → gateway → identity`: OIDC/password/SSO → issue JWT access + rotating refresh (+ MFA) → subsequent calls carry bearer token → gateway validates, resolves tenant context, injects into request. Machine clients use scoped API keys. → [15](15-SECURITY-ARCHITECTURE.md)

## 12. Authorization flow

Resolved context `{tenantId, roles, permissions, scopes, attributes}` → policy check `resource:action[:scope]` + ABAC attributes (time, camera sensitivity, reason-for-access, jurisdiction) → data-layer applies `tenantId` + scope filter → allow/deny (fail-closed), audited for sensitive actions. → [15](15-SECURITY-ARCHITECTURE.md)

## Reliability guarantees
- **At-least-once** event delivery; consumers **idempotent** (dedupe keys).
- **Outbox pattern** for services that write OLTP and emit events (no dual-write races).
- **Backpressure & graceful degradation**: under load, drop to lower FPS / defer non-critical capabilities before dropping frames for safety-critical ones.
- **Edge store-and-forward**: during WAN loss, events/evidence buffer locally and reconcile on reconnect with conflict resolution. → [14](14-EDGE-PLATFORM.md)

## Design decisions
- **Events are the seam** between perception and meaning; nothing downstream depends on how a detection was produced.
- **Evidence is derived from a ring buffer**, so pre-event context exists without continuous recording.

## Advantages
- Each flow is independently observable, testable, and scalable.
- Same flows at edge and cloud; only placement differs.

## Tradeoffs
- Eventual consistency between planes; mitigated by correlation IDs, idempotency, and the outbox.

## Future expansion
- Non-video flows (audio/thermal/IoT) enter at "Ingest" as new media capabilities; the rest of the pipeline is unchanged.

## Cross-references
[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [10-RULE-ENGINE](10-RULE-ENGINE.md) · [11-WORKFLOW-ENGINE](11-WORKFLOW-ENGINE.md) · [12-EVIDENCE-MANAGEMENT](12-EVIDENCE-MANAGEMENT.md) · [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md)
