# 05 — Video Pipeline, AI Engines, Rule Engine, Smart Clips & Search

The processing core: how a frame becomes an alert, a clip and a searchable event.

---

## 1. End-to-End Video Processing Pipeline

```
Camera ─▶ RTSP/RTMP ─▶ Decoder ─▶ Frame Extraction ─▶ Object Detection ─▶ Tracking
       ─▶ Pose Estimation ─▶ Behaviour Analysis ─▶ Rule Engine ─▶ Event Detection
       ─▶ Clip Extraction ─▶ Storage ─▶ Notifications ─▶ Dashboard
```

### Step-by-step

**1. Camera.** Any ONVIF/IP camera. Metadata (resolution, FPS, codec H.264/H.265, PTZ) captured at onboarding; credentials in vault; health heartbeat + auto-reconnect.

**2. RTSP/RTMP Stream Ingest.** The media/ingest service pulls the stream (RTSP pull or RTMP push). Maintains connection, handles reconnection, backpressure, and per-camera session. Also produces **HLS** (scalable playback) and **WebRTC** (low-latency live view) renditions for the UI.

**3. Video Decoder.** Hardware-accelerated decode (NVDEC/CUDA on Jetson/GPU, or VAAPI/QuickSync on Intel via OpenVINO). H.264/H.265 → raw frames. GPU decode avoids CPU bottleneck and enables many concurrent streams.

**4. Frame Extraction (Adaptive Sampling).** Not every frame is analyzed. An **adaptive sampler** picks FPS per model need (e.g., 5–10 fps for detection, higher on motion). **Motion gating** (lightweight background subtraction) skips static frames → massive compute savings. Frames are batched onto the GPU.

**5. Object Detection.** YOLO (TensorRT/OpenVINO/ONNX) detects persons, vehicles, objects, and safety classes (fire, PPE, weapon). Region-of-interest (ROI) masks restrict compute to relevant zones. Outputs bboxes + classes + confidences.

**6. Tracking.** ByteTrack/DeepSORT assigns **stable track IDs** across frames, enabling trajectory, dwell time, line-crossing, direction, speed, and re-identification. Tracks are the substrate for all behaviour logic.

**7. Pose Estimation.** For people of interest, MediaPipe/HRNet extracts keypoints → enables fall/slip, action recognition, fight, sleeping, mobile/phone-use, hygiene gestures. Pose can run selectively (only on tracked persons) to save compute.

**8. Behaviour Analysis.** Combines detections + tracks + poses over time into **behaviours**: intrusion, loitering (dwell in zone), tailgating (multi-person door-cross), abandoned/removed object (static/absent object + owner gone), running (speed), crowding (density), concealment gestures, PPE compliance per zone, etc. Temporal models (ST-GCN, SlowFast) handle complex actions.

**9. Rule Engine.** Customer-defined IF/THEN logic evaluated against behaviours + context (zone, time window, identity, count, camera group). Decides whether a behaviour is an **actionable event** for *this* customer. (Detailed in §3.)

**10. Event Detection.** The event engine debounces/dedupes (a person loitering for 5 min = one event, not 300), assigns severity, attaches snapshots, and creates a lifecycle record (open→ack→resolve). Cross-camera correlation links the same actor across cameras.

**11. Clip Extraction.** On event trigger, extract **pre-roll (from ring buffer, e.g. 10s before) + post-roll (e.g. 20s after)**, transcode to MP4, thumbnail, and store. Overlapping events merge into one clip. (Detailed in §4.)

**12. Storage.** Event metadata → MongoDB; embeddings → vector DB; clips/thumbnails → object storage (MinIO/S3/Blob) under `s3://{tenantId}/{cameraId}/{eventId}`, encrypted, retention-tagged.

**13. Notifications.** Alert engine routes the event through channels (email/SMS/WhatsApp/push/voice/webhook/Slack/Teams) per rule + escalation policy, with dedupe/quiet-hours. (See [Doc 06](./06-DASHBOARD-NOTIFY-MOBILE.md).)

**14. Dashboard.** Event appears live on dashboards/live wall, event timeline, clip viewer, analytics rollups; searchable via NL search. Operators acknowledge/assign/resolve.

**Where it runs:** Steps 1–12 run **at the edge** when an edge box is present (real-time, offline-capable, bandwidth-saving), shipping only events/clips upstream. In pure-cloud mode the stream is relayed to cloud GPU workers. Hybrid splits by model weight (light real-time at edge, heavy/batch in cloud).

---

## 2. AI Architecture — The Nine Engines

Each engine is an independently scalable service with a clear contract.

**1. Detection Engine.** *Responsibility:* run object/attribute detectors (YOLO family, fire/PPE/weapon models) on sampled frames; manage model loading, batching, GPU scheduling, ROI masking; emit normalized detections. Owns the inference runtime and model placement (edge/cloud).

**2. Tracking Engine.** *Responsibility:* multi-object tracking (ByteTrack/DeepSORT); maintain stable IDs, trajectories, velocity, dwell, line-crossings; provide re-identification for cross-frame/cross-camera continuity. Feeds every temporal behaviour.

**3. Recognition Engine.** *Responsibility:* face detection + recognition (ArcFace embeddings, gallery match, known/unknown), LPR/OCR, and attribute recognition (age/child/elderly, uniform, color). Manages per-tenant enrollment galleries and vector matching, with liveness/anti-spoof and jurisdiction gating.

**4. Pose Engine.** *Responsibility:* human keypoint extraction; supply skeletons for fall/slip, action, fight, sleeping, phone-use, hygiene; support pose-only privacy mode (no RGB retained).

**5. Behaviour Engine.** *Responsibility:* fuse detections/tracks/poses over time into semantic behaviours (intrusion, loitering, tailgating, abandoned/removed object, running, crowd, concealment, PPE compliance); host temporal action models and per-scene anomaly baselines.

**6. Event Engine.** *Responsibility:* convert behaviours + rule outcomes into deduped, severity-scored, lifecycle-managed events; attach snapshots/metadata; correlate across cameras; persist to DB and emit to downstream engines. Source of truth for "what happened."

**7. Alert Engine.** *Responsibility:* route events to notification channels per rules + escalation policies; handle throttling, quiet hours, acknowledgment tracking, escalation timers, and delivery retries/logging.

**8. Analytics Engine.** *Responsibility:* aggregate events/tracks into metrics (footfall, counting, occupancy, heatmaps, dwell, queue/wait, conversion, compliance %, incident trends); build materialized read models and time-series; power dashboards and scheduled reports; forecasting.

**9. Search Engine.** *Responsibility:* index events with structured metadata + visual embeddings (CLIP) + auto-captions into a vector store; parse natural-language queries into filters + semantic search; return ranked events/clips. (Detailed in §5.)

**Orchestration:** a **pipeline manager** assigns cameras→models→engines based on plan entitlements, camera config, and edge/cloud placement; a **model manager** loads/quantizes/updates models (OTA to edge). BullMQ handles async work (clip transcode, batch inference, embeddings, reports).

---

## 3. Rule Engine (No-Code, Drag-and-Drop)

**Goal:** let non-technical customers define what becomes an alert — without code.

### Structure — IF / THEN
```
IF   [trigger]  (AND/OR nested conditions)
WHEN [context filters]
THEN [actions]
```

**Triggers (conditions):**
- Object/behaviour: person/vehicle/weapon/fire detected, loitering, intrusion, tailgating, PPE violation, fall, abandoned object, queue length, occupancy, LPR match, face match/unknown, speed > X.
- Zone/ROI: enters/exits/inside polygon zone or crosses a line/direction.
- Time: within schedule (e.g., 10 PM–6 AM), day-of-week, holidays.
- Count/threshold: count in zone > N, dwell > T seconds, occupancy > capacity.
- Identity: is employee / is unknown / is on watchlist.
- Composite: combine with AND/OR/NOT and sequence (A then B within T).

**Actions (then):**
- Create Alert (severity), Extract Clip (pre/post roll), Save Event, Notify (channel + recipients/roles), Escalate, Webhook/POST, Trigger PTZ preset, Sound siren/relay (edge I/O), Add to case, Suppress for T (cooldown).

### Example rules
```
Rule "Restricted Area — Night"
IF   person enters zone "ServerRoom"
WHEN time 20:00–06:00 AND identity != employee
THEN create alert(HIGH) + extract clip(10s/20s) + notify(Manager, Security) via push+SMS + escalate if not ack in 3m + save event

Rule "PPE Compliance — Floor A"
IF   person in zone "FloorA" AND helmet == false
THEN create alert(MEDIUM) + extract clip + notify(SafetyOfficer) + save event

Rule "Queue SLA"
IF   queue length in zone "Checkout" > 6 for > 120s
THEN notify(StoreManager) via push + log analytics
```

### Builder UX
- **Canvas** with draggable **condition blocks** and **action blocks**, connected visually; live validation; test against recorded footage ("dry run" to preview trigger rate/false positives before enabling).
- **Zone/line editor** overlaid on the camera image (draw polygons/lines, name zones).
- **Templates** per industry (prefilled rules from solution packs).
- **Versioning & audit** of rule changes; per-camera-group or per-branch scoping.

### Evaluation engine
- Compiled to a fast **condition tree** evaluated per behaviour event; stateful conditions (dwell, sequence, cooldown) tracked in Redis; scoped by tenant/branch/camera. Deterministic, low-latency, and testable.
- **Collections:** `rules`, `ruleVersions`, `zones`, `ruleState`, `ruleTemplates`.

---

## 4. Smart Clip Extraction (Storage Reduction)

**Principle:** never store continuous video in the cloud — store **only event clips** with context. Delivers **~90%+ storage reduction** vs 24/7 recording.

### How it works
1. **Pre-roll ring buffer.** Each camera keeps a short rolling buffer (e.g., last 30–60s) in memory/edge disk. So when an event fires, we already have the **10s before**.
2. **Trigger.** Event engine fires → capture window = **T_pre (10s) before + T_post (20s) after** the trigger timestamp.
3. **Dynamic extension.** If the behaviour continues (e.g., loitering ongoing), extend post-roll until the behaviour ends + cooldown, capping max length.
4. **Merge overlapping clips.** Multiple events within the window (or across nearby cameras) merge into **one clip** with multiple event markers → avoids duplicate storage.
5. **Transcode & thumbnail.** Extract to MP4 (H.264/H.265), generate thumbnail + optional keyframe sprite for the timeline.
6. **Timeline generation.** Build an **event timeline** per camera/day: markers for every event, jump-to-clip, severity coloring, filterable — the "highlight reel" of the day.
7. **Store & tag.** Clip → object storage with `{tenantId, cameraId, eventId, type, severity, retention}`; metadata → MongoDB; embedding → vector DB.
8. **Retention tiering.** Hot (recent) → cold archive → delete per policy; safety-critical/legal-hold clips retained longer.

### Storage math (illustration)
- Continuous 1080p H.265 ≈ ~5–8 GB/camera/day. With ~2% event coverage (30s clips on real events) → **~0.1–0.4 GB/camera/day** → **90–95% reduction**, plus only relevant footage to review.
- Optional: keep a **low-bitrate continuous "background" recording** on-prem for compliance while cloud holds only event clips (configurable).

**Collections:** `clips`, `clipSegments`, `timelines`, `ringBufferConfig`.

---

## 5. Natural-Language Search Engine

**Goal:** answer queries like *"show possible theft yesterday"*, *"all fire events last week"*, *"customers hiding products"*, *"employee entering warehouse after 10 PM"* — instantly, without scrubbing footage.

### What gets indexed (at event creation)
1. **Structured metadata:** event type, detections, zone, camera, branch, timestamp, identity (known/unknown), attributes (PPE, vehicle color, plate), severity, rule name.
2. **Visual embeddings:** CLIP image embedding of key event frames → enables semantic/visual matching ("person in red jacket", "hiding product").
3. **Auto-captions:** a vision-language model generates a short natural-language description per event ("A person places an item into a bag near shelf 4 without scanning") → embedded as text.
4. **Track/attribute tags:** color, object classes, counts, direction, dwell.

All indexed into a **vector store (Qdrant/Milvus)** per-tenant namespace + Mongo for structured filters.

### Query flow
```
NL query ─▶ Query Understanding (LLM/parser)
          ├─ extract structured filters: time range, event type, camera/zone, identity, attributes
          └─ extract semantic intent → embed (text → vector)
        ─▶ Hybrid retrieval:
            • structured filter on Mongo (time, type, zone, branch)
            • vector similarity on CLIP/caption embeddings (semantic)
        ─▶ Re-rank (fusion of filter match + semantic score + severity/recency)
        ─▶ Return ranked events + clips + thumbnails + explanations
```

### Examples → resolution
- *"Show possible theft yesterday"* → filter `type ∈ {shoplifting, suspicious, concealment}` + time=yesterday → ranked by suspicion score, with clips.
- *"Show all fire events"* → filter `type=fire/smoke` → chronological, all cameras.
- *"Show customers hiding products"* → semantic match on CLIP/caption embeddings for concealment gestures + retail zones → ranked.
- *"Show employee entering warehouse after 10 PM"* → filter `identity=employee` + zone=`warehouse` + time>22:00 → track-based intrusion/entry events.

### Implementation notes
- **LLM (latest Claude models via the AI integration layer)** parses queries into a structured filter JSON + semantic intent; guarded to tenant scope; falls back to keyword/filter search offline.
- **Precompute embeddings** at ingest (async via BullMQ) so search is instant.
- **Saved searches, alerts-from-search** ("notify me whenever this query matches"), and **conversational follow-ups** ("only camera 3", "just the red car").
- **Privacy:** search respects RBAC/camera scope; FR-based queries gated by permission and jurisdiction; all searches audited.
- **Collections:** `eventEmbeddings` (vector), `savedSearches`, `searchAudit`.
