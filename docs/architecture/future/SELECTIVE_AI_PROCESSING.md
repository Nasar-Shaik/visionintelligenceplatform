# Selective AI Processing — the assignment layer

_Status: 🔒 **Architecture frozen 2026-08-05** · design only — no contract changed, no code written · designed and ratified at the P-6.6 approval · Claude · measured against deployment `7642f97`_

> **What this document is.** The design for the one layer that does not exist anywhere in the
> platform: the **binding between a camera and processing**. A customer with 16 cameras records all
> 16 and analyses 2 — today there is no record capable of expressing that sentence.
>
> **What it is not.** It does not restate [AI_EXECUTION_ARCHITECTURE](AI_EXECUTION_ARCHITECTURE.md),
> which remains the canonical reference for how inference executes. It designs no scheduler, no cost
> model and no profile format, because ⚠️ **all three already exist** — §0 records what was found.
>
> **Frozen means:** §15 is ratified and implementation follows §14 in order. Changing a decision here
> needs the same ceremony as changing a foundation — a recommendation raised **before** any code, not
> a discovery inside a pull request.

---

## §0 · What was measured before anything was designed

The brief asked for a design of six subsystems. Five of them are substantially built. Reading the
tree before writing the design changed what P-8 is: **less new architecture than expected, and one
harder deployment problem than the roadmap states.**

| #       | Finding                                                                                                                                                                                                                                                                                                                                                              | Evidence                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-1** | **The frame path is complete up to one line.** ffmpeg already decodes each recorded stream to JPEG frames at the configured rate (`image2pipe`), the supervisor already pushes every frame to a sink — and the sink discards them. Frames are being produced in production **right now** and thrown away                                                             | [`stream-supervisor.ts:210`](../../../services/media/src/application/stream-supervisor.ts) · [`index.ts:78`](../../../services/media/src/index.ts) |
| **F-2** | ⚠️ **The AI runtime has never been deployed.** 121 Python modules and a `requirements.txt`, but **no container image and no compose service** — absent from `docker-compose.prod.yml`, which runs ten TypeScript services and nothing else. It has run in tests and on a developer's machine, never in the production stack. **The largest single item in P-8**      | `find ai -name 'Dockerfile*'` → nothing · `docker-compose.prod.yml`                                                                                |
| **F-3** | **The D-4 behaviour analyzers already exist** — loitering, intrusion, crowd, queue, occupancy, fire — written and unit-tested in AI-4. ⚠️ None has ever seen a frame from a real camera. `C-20` reads "no analyzer wired", which under-reports what is there: the analyzers are built, nothing feeds them                                                            | `ai/inference/behaviors/*.py`                                                                                                                      |
| **F-4** | **The scheduler exists in contract and in code.** `SessionPriority` · `PRIORITY_WEIGHTS` · `SchedulingStrategy` · `SchedulerPolicy` · `AdmissionVerdict` · `AdmissionRefusalReason` · `DegradationLevel` + `DEGRADATION_LADDER` · `AnalyzerCostModel` · `ResourceEstimate` · `SchedulerStats`, plus `sizing.py`. **P-8 does not design a scheduler; it deploys one** | `packages/contracts/src/inference/inference.ts` (frozen AI Runtime v1.0) · `ai/inference/scheduler.py`                                             |
| **F-5** | **The profiles exist — twice.** `BehaviorProfile` configures _what to detect_; `DeploymentProfile` configures _what the box may spend_. Seven deployment profiles already ship as JSON: retail · warehouse · office · school · hospital · factory · parking — the brief's list, already written                                                                      | `ai/inference/profiles/deployment/*.json`                                                                                                          |
| **F-6** | ⚠️ **The binding does not exist in any form.** No contract, route, collection or field anywhere says "this camera is analysed". Not a missing UI — a missing record. Nothing to enable, nothing to schedule against, nothing to price                                                                                                                                | `rg 'aiEnabled\|analysisProfile\|processingEnabled'` → one unrelated console helper                                                                |

**The conclusion that shapes everything below:** P-8 is a **deployment and connection** milestone with
**one new record** in it, not a subsystem build. Designing a second scheduler or a third profile
format would be inventing work that the AI Runtime freeze already paid for.

---

## §1 · Per-camera AI enable/disable

### The record

One tenant-scoped record per camera, expressing intent — **not** a field on the camera.

```
CameraProcessingIntent {
  tenantId, cameraId,
  recording: { enabled },                  // closes L-38: today this lives in memory
  analysis:  { enabled, profileId, priority, mode, reason?, zones?, schedule? },
  updatedAt, updatedBy,                    // optimistic concurrency + audit, as P-6.6
}
```

Three properties are deliberate:

1. **Recording and analysis are two flags on one record**, because they are the same question — _what
   should be running for this camera_ — and because splitting them creates two sources of truth for a
   camera's runtime state. It also means P-8 closes [L-38](../../project/KNOWN_LIMITATIONS.md) (stream
   state held in memory) with the same store, rather than leaving one honest disclosure behind.
2. **The camera record is not touched.** [PLATFORM_BOUNDARIES](../PLATFORM_BOUNDARIES.md) forbids the
   Camera Service from containing perception logic; a `profileId` on `Camera` puts model selection
   inside the device-identity context and makes the Camera Foundation's freeze negotiable. It also
   fails the "does it persist a conclusion?" test — the assignment is configuration owned elsewhere.
3. **The AI runtime does not store it.** The same document forbids the runtime from persisting tenant
   data. The runtime **reads** intent as configuration; it never owns it.

### Ownership — 🔒 ratified

**The Media domain owns `CameraProcessingIntent`. It is not a new microservice.** Media already owns
per-camera runtime intent and the worker lifecycle, already has a tenant-scoped store, is already
routed at `/api/media/*`, and — under §15 ADR-A — is where the gate physically sits.

The rejected alternatives are kept because they are the arguments that would justify revisiting this:
a dedicated `perception` service would decouple analysis configuration from recording availability
(if media is down, so is the assignment API — though a customer whose recording is down is not
editing AI profiles); the `Camera` record would match how operators _think_ about it and is refused
on the boundary above.

### The gate — where "not analysed" costs nothing

⚠️ **A camera with AI disabled must never be connected for analysis, never queued, and never filtered
after inference.** Filtering downstream produces the same screen and the same bill; the entire
commercial premise is that an unanalysed camera consumes no inference capacity.

⚠️ **What "zero" precisely means under ADR-A, measured rather than assumed.** One ffmpeg process
already produces two outputs per recorded camera: MP4 segments (stream-copied, no re-encode) **and
JPEG frames, re-encoded unconditionally**, which are then discarded. So today _every recorded camera
already pays an MJPEG encode for nothing_. The gate therefore has two depths, and P-8 should reach
the second:

| Depth                              | Saves                                      | Cost remaining                                 |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Gate at the sink (`push` not sent) | the bus, the queue, the inference          | ⚠️ the JPEG encode, still paid by every camera |
| **Gate in the ffmpeg arguments**   | the encode as well — output 2 is not built | decode for recording, which recording pays for |

**Fail-closed.** Intent unreadable, profile unresolvable, tenant unknown → **no analysis**, recording
unaffected. The failure mode of a configuration outage must be an unanalysed camera, never an
unrecorded one.

**Audited.** Enabling analysis is a billing-relevant and privacy-relevant act — who turned it on,
when, for which camera, under which profile and for what reason (§8). Permissions checked, optimistic
concurrency, immutable audit entry, exactly as P-6.6.

---

## §2 · Processing profiles

### ⚠️ The word "profile" is already used six ways

| Name                                     | Means                                    | Owner                |
| ---------------------------------------- | ---------------------------------------- | -------------------- |
| `CaptureProfile` / `CameraStreamProfile` | which stream, at what resolution/codec   | Camera Foundation    |
| `BehaviorProfile`                        | **what to detect**, with what thresholds | AI Runtime (AI-4)    |
| `DeploymentProfile`                      | **what the box may spend** running it    | AI Runtime (AI-5b)   |
| `profiles/cameras/*.json`                | device compatibility per vendor model    | Camera compatibility |
| `EvidenceExportProfile`                  | what an export bundle contains           | Reporting            |
| `WorkspaceProfile`                       | investigation workspace layout           | Workspace            |

**A seventh independent "Processing Profile" would be the worst possible addition to that list.**

### 🔒 Ratified: a processing profile is a composition, not a new type

> **Processing Profile = a named, customer-facing composition of one `BehaviorProfile` (what to
> detect) with one `DeploymentProfile` (what it may cost), plus its entitlement.**

Nothing new is stored except the composition and its name. Extensibility comes for free: adding a
capability to a profile is a config edit to an existing `BehaviorProfile`; adding a _new_ capability
is analyzer code plus certification — and the catalogue cannot advertise it until it exists.

### The catalogue, stated honestly

⚠️ **A profile may not advertise a capability whose analyzer does not exist.** The catalogue renders
per-capability status exactly as the camera page does.

| Profile                    | Capability                 | State today                                        |
| -------------------------- | -------------------------- | -------------------------------------------------- |
| **Retail loss prevention** | Person detection           | manifest registered, ⚠️ no model registered (TD-5) |
|                            | Loitering                  | analyzer built, never fed a real frame             |
|                            | Restricted area            | analyzer built (intrusion), never fed              |
|                            | Queue / checkout dwell     | analyzer built, never fed                          |
|                            | Object left behind         | ⛔ not built                                       |
|                            | Object removed             | ⛔ not built                                       |
|                            | Cash-counter monitoring    | ⛔ not built — a zone + composite over the above   |
| **Warehouse safety**       | Intrusion                  | analyzer built, never fed                          |
|                            | Fire / smoke               | analyzer built (fire), never fed, ⚠️ uncertified   |
|                            | PPE                        | ⛔ not built — needs a model, not a rule           |
|                            | Forklift                   | ⛔ not built — needs a model                       |
| **School · hospital**      | Person · crowd · intrusion | analyzers built, never fed                         |
| **Parking · office**       | Person · occupancy         | analyzers built, never fed                         |

**Only one profile ships in P-8** — the one whose every capability is real end to end. A catalogue of
six profiles, five of which resolve to nothing, is the placeholder UI this platform does not build.

**Industry semantics stay in the profile.** No analyzer learns the word "retail" (Law 1); the core
stays industry-neutral and packs carry vertical meaning ([AI_PACKS](AI_PACKS.md)).

---

## §3 · Runtime processing scheduler

🔒 **Ratified: do not create another scheduler.** Five of the six asks already exist; the table
records where, so P-8 wires rather than builds.

| Ask                         | Mechanism                                                         | State                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enable / disable processing | `CameraProcessingIntent` (§1) → session admission                 | ⛔ **new** — the only new record in this design                                                                                                                          |
| Processing priority         | `SessionPriority` · `PRIORITY_WEIGHTS` · `SchedulingStrategy`     | ✅ exists, never deployed — §10                                                                                                                                          |
| FPS limits                  | `DeploymentProfile.targetFps` · `samplingStride`                  | ✅ exists, never deployed                                                                                                                                                |
| Overload behaviour          | `AdmissionVerdict` · `DEGRADATION_LADDER` · `AnalyzerCostModel`   | ✅ exists, never deployed — §4                                                                                                                                           |
| Zone-based processing       | `Zone` + `ZoneRole` (analyzer input); intent carries the zone set | ✅ analyzer side exists — §9                                                                                                                                             |
| Business-hours schedule     | A window on the intent, evaluated by whatever starts sessions     | ⛔ new, small — §11. ⚠️ The window is in the **site's** time zone (Location Hierarchy), never the server's, or every deployment outside one region is wrong twice a year |

**One state that must reach the operator:** a camera whose analysis is _enabled_ but whose session was
**refused admission** (capacity) is not the same as one that is off, and not the same as one that is
running. Silent degradation is how a customer discovers at an incident review that the camera they
enabled was never analysed. `SchedulerDecision` · `SchedulerReason` · `AdmissionRefusalReason`
already carry the vocabulary; P-8 surfaces it rather than inventing a message.

---

## §4 · Capacity planning

**The model exists and is already honest.** `sizing.py` derives per-camera cost from the same
`ComputeRegistry.unit_cost()` the scheduler's admission control uses — one set of numbers, no drift —
and marks a recommendation `estimated=True` whenever no measured `BenchmarkReport` backs it. It
refuses to recommend hardware that cannot hold 30% headroom rather than reporting a tight fit.

What P-8 adds is **not a model**. It is a deployment that produces real numbers, and a surface that
shows them with their provenance.

| Need                              | Mechanism                                                                                                                         | State                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Estimated GPU usage               | `ComputeResource` (kind `cuda`) + `ResourceEstimate` per admitted session                                                         | exists, undeployed          |
| Estimated CPU usage               | `ComputeResource` (kind `cpu`) + `ResourceSnapshot` · `SessionResourceUsage`                                                      | exists, undeployed          |
| Cameras assigned                  | ⚠️ **Derived** from intent, never stored — a stored count is a second source of truth                                             | new with §1                 |
| Cameras recording only            | Derived: recording enabled ∧ analysis disabled                                                                                    | new with §1                 |
| Processing queue depth            | `StreamBackpressureStats` — queue depth, wait time, **deliberate down-sampling kept separate from genuine loss**                  | exists, undeployed          |
| Overload behaviour                | `AdmissionVerdict` + `AdmissionRefusalReason` — a session is **refused**, which is reported, not silently dropped                 | exists, undeployed          |
| Graceful degradation              | `DEGRADATION_LADDER` + `AnalyzerCostModel` + `protected_analyzers` — the most expensive analyzer sheds first, protected ones last | exists, undeployed          |
| "What does this profile cost me?" | Per-analyzer cost at target fps per reference hardware class, before and after enabling                                           | ⛔ measured in Phase 6 only |

⚠️ **No cost figure may be shown to a customer without its evidence class.** The rule that governs the
camera capability panel governs this: an estimate presented as a measurement is the same defect,
priced. A number becomes `measured` only from a benchmark run against the **deployed** runtime — never
from a spreadsheet, never from simulation, never hand-edited.

⚠️ **Degradation must be explainable, not merely graceful.** "The system reduced load" is not an
answer an operator can act on; "camera 14's loitering analyzer was shed at 09:12 because the box
passed 85% and it is the most expensive analyzer running" is. The vocabulary for the second sentence
already exists — P-8 must not settle for the first.

---

## §5 · Camera capability matrix

**The vocabulary already exists in the product** — `CapabilityEvidence` in
[`cameraCapabilityTruth.ts`](../../../apps/console/src/features/cameras/cameraCapabilityTruth.ts),
rendered by `CapabilityTruthPanel`, shipped in P-6.6. Do not invent a second one. The design work is
not the classes; it is **the promotion rule for each row** — what evidence, specifically, moves a row
to `measured`.

| Capability        | Today                                            | Promoted to `measured` by                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recording**     | `measured` — from a live media worker            | already there; P-8 makes it durable (L-38) rather than more true                                                                                                                                                 |
| **Playback**      | `measured` when a segment exists, else `unknown` | a retrievable segment for that camera                                                                                                                                                                            |
| **Live view**     | `not-built`                                      | a frame rendered in a browser against the deployment, per engine — the transport ADR, tracked separately from perception                                                                                         |
| **AI processing** | `not-built`                                      | 🔒 **an inference that actually happened for that camera** — a `lastInferenceAt` from the runtime. **Never from the intent flag.** Ratified: processing intent is configuration; measured capability is a result |
| **PTZ**           | `declared` (amber)                               | a real pan executed against the device — P-8 has no control write path, so this stays `declared`                                                                                                                 |
| **Audio**         | `declared`                                       | an audio track observed in a decoded stream                                                                                                                                                                      |
| **Retention**     | ⛔ **no row exists** — no per-camera policy      | add the row when a policy exists; its absence is the honest statement, not an "unknown" that implies a setting is somewhere                                                                                      |
| **Export**        | `not-built` (P-11)                               | a generated bundle — unchanged by P-8                                                                                                                                                                            |

**Two rows move in P-8** (AI processing, and Live view if the transport lands). Everything else is
unchanged, and saying so prevents P-8 from being sold as a capability sweep.

---

## §6 · Resource allocation strategy — and what it is worth

**Sixteen cameras. All recorded. Two analysed.**

| Dimension            | Recording (16)                        | Analysis (2)                                                                   |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Scales with          | storage and retention                 | **compute** — cameras × fps × analyzer cost                                    |
| Marginal camera cost | a disk line item                      | a share of a GPU or of the CPU budget                                          |
| Failure of scale     | the disk fills — visible, predictable | frames drop or sessions are refused — ⚠️ invisible unless the platform says it |

The commercial argument is that **the expensive resource is the one you can choose not to spend.** A
retail customer analyses the entrance and the till; the stockroom camera records for investigation and
costs nothing to keep. Without selective assignment, the smallest viable deployment is priced by the
largest camera count — which is why a 4-camera shop and a 500-camera campus cannot otherwise be the
same product.

**What it supports, stated as the platform will have to defend it:**

| Claim                | Why it follows                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Lower GPU usage      | Inference capacity is consumed per admitted session; an unassigned camera opens none                                                     |
| Lower CPU usage      | ⚠️ Only once the gate reaches the ffmpeg arguments (§1) — at the sink alone, the JPEG encode is still paid                               |
| Lower hardware cost  | `sizing.py` recommends against **assigned** cameras, not the estate — the whole point of the model                                       |
| Easier deployment    | A box is sized for the cameras that create value, so a 40-camera site can start on a mini-PC instead of waiting for a GPU purchase order |
| Privacy requirements | §12 — and this is the one that is not about money                                                                                        |

**Two honesty notes carried into the sales conversation:**

- ⚠️ Nothing **enforces** a camera or capability count. `C-61` licensing does not exist; every
  deployment behaves as Enterprise ([PRODUCT_EDITION_MATRIX](../../project/PRODUCT_EDITION_MATRIX.md)).
  Selective processing makes the _meter readable_, not enforceable.
- ⚠️ Every hardware figure quoted before a benchmark exists is `estimated=True` and must be said that
  way. The first customer who returns a mini-PC learns what the second one is told.

---

## §7 · The AI processing lifecycle

**Every future AI capability follows this pipeline.** A capability that skips a stage is a capability
that cannot be explained to a customer when it is wrong — and being wrong occasionally is what
perception does.

```
Camera  →  Processing Intent  →  Runtime Scheduler  →  Stream Connection  →  Frame Extraction
        →  Inference Runtime  →  Detection Engine   →  Incident Engine    →  Evidence  →  Operator
```

| #   | Stage                 | Owner                          | Today                                                    | P-8 phase |
| --- | --------------------- | ------------------------------ | -------------------------------------------------------- | --------- |
| 1   | **Camera**            | Camera Service (frozen)        | ✅ production-verified                                   | —         |
| 2   | **Processing Intent** | **Media** (§1)                 | ⛔ does not exist                                        | 3         |
| 3   | **Runtime Scheduler** | AI Runtime (`scheduler.py`)    | ✅ built · ⛔ never deployed                             | 1 → 4     |
| 4   | **Stream Connection** | Media `StreamSupervisor`       | ✅ production — reconnect, backoff, `media.stream.lost`  | —         |
| 5   | **Frame Extraction**  | Media `FfmpegDecoder`          | ✅ production — ⚠️ frames produced and discarded (F-1)   | 2         |
| 6   | **Inference Runtime** | AI Runtime (`app.py`/`server`) | ✅ built · ⛔ never deployed                             | 1         |
| 7   | **Detection Engine**  | capability registry + adapters | ✅ built · ⚠️ `stub` backend, no model registered (TD-5) | 5         |
| 8   | **Incident Engine**   | Rules → Workflow               | ✅ production-verified since P-5                         | 5         |
| 9   | **Evidence**          | Evidence Foundation (frozen)   | ✅ production-verified                                   | 5         |
| 10  | **Operator**          | Console                        | ✅ production-verified                                   | —         |

⚠️ **The two ends of this pipeline are built and the middle is disconnected.** Stages 1, 4, 5 run in
production today; stages 8, 9, 10 have been production-verified since P-5. Stages 2, 3, 6, 7 are the
milestone. That is why P-8 is a connection problem, and why an estimate built on "we need to build a
perception pipeline" would be wrong in both directions.

**Three boundary rules that travel with the pipeline** (from
[PLATFORM_BOUNDARIES](../PLATFORM_BOUNDARIES.md), restated because this is where they get broken):

1. **Stage 7 never reaches stage 8 directly.** The runtime emits observations; the Rule Engine decides
   what is an incident. A runtime that creates incidents is one whose behaviour changes when a rule
   changes, and it can no longer be certified independently.
2. **AI is advisory.** Nothing in stages 6–7 mutates an incident, an evidence record or a rule.
3. **Naming happens where the fact is produced.** The runtime names a detection; the console renders
   words for that name and never derives its own.

---

## §8 · AI assignment reasons

**Why is the platform watching this camera?** The reason is carried on the intent, authored by the
operator who assigned it.

Suggested list, extensible per tenant: **Cash counter · Jewellery counter · Restricted area · Server
room · Warehouse exit · Staff entrance · High-value shelf.**

**Why the field earns its place** — four answers it gives that nothing else does:

| Question                             | Without a reason                                       |
| ------------------------------------ | ------------------------------------------------------ |
| Why is this camera analysed?         | ask whoever configured it, if they still work here     |
| Why is that one not?                 | unanswerable, and therefore unauditable                |
| Where is the analysis budget going?  | a count of cameras, with no business meaning attached  |
| What do we tell the regulator (§12)? | "an administrator enabled it" — true, and insufficient |

**Design rules:**

- ⚠️ **A reason must never drive behaviour.** The moment "Cash counter" changes which analyzer runs,
  it has become a second, undeclared rule engine sitting beside the real one. It is documentation
  attached to configuration — that is the whole of it.
- **Suggested list _plus_ free text**, not a closed enum. A fixed enum in a security product forces a
  customer's real reason ("the till the office cannot see") into the nearest wrong box; the suggested
  list exists so grouping and reporting stay consistent when the customer takes it.
- **Tenant-scoped**, like every other piece of tenant configuration.
- It is **not** a zone (§9), **not** a capability, and **not** a rule.

---

## §9 · AI zones

**The entire frame is recorded. Only selected polygons are analysed.**

What exists already: `Zone`, `ZoneRole` (`entrance · exit · checkout · cash · queue · restricted ·
storage · loading · aisle`), `zones.py` and `coordinates.py` in the runtime, and
`BehaviorProfile.zoneRoles`. What P-8 would add is carrying the zone set on the intent, and an editor
to draw it. **The analyzer side is not the missing part.**

**Four rules, and the third is the one that gets sold wrongly:**

1. ⚠️ **Recording is never cropped.** A zone restricts _analysis_, never _evidence_. Cropping the
   recording to the zone would destroy the footage of what happened just outside it — which, in an
   investigation, is usually where the person came from.
2. **Coordinates are normalized** to the analysed stream, never pixel coordinates of one resolution.
   A sub-stream that changes resolution after a firmware update must not silently move every zone.
3. ⚠️ **Zones are a precision feature, not a cost feature.** Inference typically runs on the whole
   frame and filters detections afterwards, so excluding 80% of the frame does not save 80% of the
   cost. It saves **false positives**, which is worth more — but the saving must not be quoted as
   compute unless the pipeline crops before inference, which would be a measured claim and is not one
   today.
4. **A privacy mask is a different feature.** "Never analyse this region" (a compliance control) and
   "only analyse this region" (a precision control) look identical on screen and mean different things
   when one of them fails. Do not conflate them into one polygon list.

---

## §10 · AI priority

Four levels, feeding deterministic degradation when compute runs short.

⚠️ **The frozen enum is `low · normal · high · critical` — there is no `medium`.** `SessionPriority`
is published in `@vip/contracts` and renaming a published value is forbidden ([CONSTRAINTS §41]:
a rename is a breaking change for every consumer, stored document and integration, bought for a
clearer word). Two ways to honour the brief:

| Option                                                     | Consequence                                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Display "Normal"** _(recommended)_                       | The screen, the API, every log line and every support conversation use one word. A Critical/High/Normal/Low scale reads fine |
| Display "Medium", map to `normal` at the presentation tier | The customer's word, at the cost of a label that disagrees with every artefact an engineer will ever read during an incident |

**How priority actually behaves** (all of it already built):

- `PRIORITY_WEIGHTS` feeds `weighted-fair` scheduling; `strict-priority` and `round-robin` are the
  alternatives, selected by `SchedulerPolicy` — a **deployment** choice, not a per-camera one.
- Under pressure, `DEGRADATION_LADDER` sheds in a defined order and `AnalyzerCostModel` decides that
  the most expensive analyzer goes first, with `protected_analyzers` never shed.
- ⚠️ **Degradation must be explainable per camera.** `SchedulerDecision` carries the reason; the
  operator sees _why_ their camera is not being analysed, not merely _that_ it is not. A priority
  system whose outcome cannot be explained is indistinguishable from one that is random.

---

## §11 · Processing modes

| Mode                 | Means                                              | Needs                                         | State                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Continuous**       | analysed whenever the camera streams               | nothing new                                   | ✅ **the only mode P-8 builds**                                                                                                                                                                                                                                                                |
| **Scheduled**        | analysed inside a window (e.g. after hours)        | a window + the **site's** time zone           | ⛔ new, small — the contract shape belongs in P-8, the editor can follow                                                                                                                                                                                                                       |
| **Motion triggered** | analysed when the scene changes                    | ⚠️ **a motion source, which does not exist**  | Two candidates, each a decision: **device-side ONVIF motion** (cheap, vendor-variable, unvalidated until P-9 — and `capabilityTruth` already says the platform does not subscribe to it) or a **decode-side motion stage** (the decode is paid anyway, so the saving is inference, not decode) |
| **Event triggered**  | analysis armed by something that happened          | an event that exists without analysis running | ⛔ Circular today: the only events come from the analysis that is not running. It becomes real when a **rule action** can arm a camera — a Rule Engine change, not an intent change                                                                                                            |
| **Manual**           | an operator turns analysis on for an investigation | an expiry                                     | ⛔ new, small and genuinely useful. ⚠️ **Must expire**, or "manual" quietly becomes "continuous that somebody forgot"                                                                                                                                                                          |
| **Disabled**         | assigned, configured, deliberately off             | nothing                                       | ⛔ new — and ⚠️ **not the same as unassigned**: disabled retains profile, reason and zones so re-enabling restores the configuration; unassigned has none to restore                                                                                                                           |

**Do not ship a mode selector listing six options where one works.** The honest surface in P-8 is
continuous, with the others recorded here as the shape they will take.

---

## §12 · Privacy and compliance

**Selective processing is a compliance control as much as a cost control**, and the compliance half is
the one that will be asked about in a procurement questionnaire.

Recording a space and _analysing_ it are different processing activities. A customer may be obliged to
record a staff room for security and obliged **not** to analyse it — proportionality, works-council
agreements, clinical areas, changing rooms, prayer rooms. A platform that can only be "on" makes that
customer choose between a security system and their obligations.

**What the platform must therefore be able to answer, per camera:**

| Question                                     | Answered by                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Is this camera analysed?                     | the intent record                                                               |
| By which profile — what is being looked for? | the composition (§2)                                                            |
| Since when, and on whose authority?          | ⚠️ the **audit trail**, not the record — the record only knows the present      |
| Why? (§8)                                    | the assignment reason                                                           |
| Was it analysed last March?                  | the audit trail, which is why assignment changes are audited from the first day |

⚠️ **Historical answerability is the requirement, not current state.** A record that only knows "today
it is off" cannot answer a regulator asking about a period. The audit entry is the answer; the intent
record must never be treated as its own history.

**Fail-closed, again, for a different reason:** if intent cannot be read, nothing is analysed and
nothing about that camera is inferred or stored. In §1 that rule protects the bill; here it protects
the customer's legal position, and the two agree.

**Unchanged by this design:** face recognition and LPR remain outside the contracts entirely.
They are biometric processing under GDPR Art. 9 — a lawful basis, a DPIA, a retention position and a
subject-rights path come _before_ there is a schema to store a faceprint in.

---

## §13 · Engineering principles carried into P-8

These are not new rules. They are the P-5/P-6 rules, with the form each takes in a perception
milestone written down — because every one of them has an AI-specific way of being broken.
Authoritative texts: [DEFINITION_OF_DONE](../../project/DEFINITION_OF_DONE.md) items 17–37 ·
[CONSTRAINTS](../../project/CONSTRAINTS.md) · [P6-5-LESSONS](../../review/p6/P6-5-LESSONS.md).

| Principle                                    | How it gets broken in P-8, specifically                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Never build placeholder functionality        | A mode selector with six modes where one works; a profile catalogue with six entries where one resolves                                          |
| Never create fake configuration UI           | An assignment toggle shipped before the gate exists — the P-6.6 refusal, repeated one milestone later                                            |
| Never invent backend behaviour               | A "GPU usage" gauge fed by an estimate that the screen presents as a reading                                                                     |
| Never overstate capability                   | ⚠️ Promoting the `ai` capability row from the **intent flag** instead of from an inference that happened                                         |
| Deployment verification outweighs unit tests | The runtime's 121 modules are unit-tested and have **never run in the production stack** — F-2 is precisely this principle's bill arriving       |
| Mutation-test the verification scripts       | A perception check that passes because the `stub` adapter always returns a detection is a check that cannot fail                                 |
| Every production claim is evidence-backed    | ⚠️ Simulation never certifies: `evidenceClass: simulated` sits on every camera profile today, and a `stub` detection is not evidence of anything |
| Every measurement comes from the deployment  | Benchmarks run against the deployed runtime, not a laptop, or the number describes the laptop                                                    |
| Stop and recommend before changing           | Raise it before the code, as §15 ADR-A was raised — not inside a pull request                                                                    |

---

## §14 · The P-8 implementation plan — 🔒 ratified order

**Implementation begins at Phase 1 and proceeds in this order.** Each phase's proof is
deployment-verified; each verification script is mutation-tested before its result is trusted.

### Phase 1 · Deploy the AI Runtime

Package it · containerize it · deploy it beside the platform · verify **health, startup, logging,
metrics**. ⚠️ **Do not connect cameras.**

> Favourable finding: the `stub` backend is **stdlib-only**, so Phase 1 needs no ONNX, no MLflow and
> no model — a slim Python image with zero third-party dependencies. The runtime already serves
> `/health`, `/ready`, `/status`, `/metrics`, `/capabilities`, `/scheduler`, `/resources` and
> `/fleet-health`, so this phase builds no HTTP surface.
>
> **Proves:** the image is in the production stack, `deployment-integrity.mjs` covers its bytes, the
> commit hash is recorded, and readiness is meaningful rather than a process-is-up probe (P-6.4's
> lesson: `/health` cannot fail while the process can answer).

### Phase 2 · Replace the `NullFrameSink` with the real runtime

Verify decoded frames reach the runtime. **Measure:** frames received · frames processed · frames
dropped · latency.

> ⚠️ Frames processed may be counted with the `stub` adapter — that measures the **transport**, which
> is what this phase is about, and must be labelled as transport rather than as detection.

### Phase 3 · Implement `CameraProcessingIntent`

The record, the API, permissions, optimistic concurrency, audit. Recording stays independent.

> ⚠️ **Recommendation, raised rather than assumed:** the phase as written also says "allow operators
> to choose which cameras are analysed". Shipping the operator control here — one phase before the
> scheduler is connected — is a control that does not yet change what runs. **Recommend the record and
> API land in Phase 3 and the console control lands with Phase 4**, when toggling it visibly changes
> the deployment. If the control must appear in Phase 3, it has to say on screen that assignment takes
> effect when the scheduler is connected.

### Phase 4 · Connect the scheduler

Assigned cameras start processing. Unassigned cameras consume zero AI resources.

> ⚠️ "Zero" is precise here (§1): gating at the sink saves the bus, the queue and the inference, but
> **every recorded camera still pays an MJPEG encode** for frames nobody consumes. Reaching zero means
> the gate reaches the ffmpeg arguments. Both depths must be **measured**, not asserted.

### Phase 5 · Run inference

Produce detections. Connect them to the **existing** Incident Engine. ⚠️ **No new incident pipeline** —
the runtime emits observations and the Rule Engine decides (§7 rule 1). This is where TD-5 is paid:
a real model registered and `onnx` becomes the default backend.

### Phase 6 · Measure

CPU · GPU · FPS · latency · dropped frames · memory · queue depth — before and after enabling, on the
deployment. **Every claim comes from these numbers**, and `estimated=True` flips to measured only
here.

### Phase 7 · Verify against the deployed stack

No mocks. No component-only verification. Playwright against the deployed application. Every
verification script mutation-tested — broken once, on purpose, and seen to fail for the right reason.

### What P-8 must not do

- ⛔ Build the assignment UI before the gate exists
- ⛔ Promote the `ai` capability row from the intent flag
- ⛔ Show a cost number without its evidence class
- ⛔ Introduce a seventh meaning of "profile", or a second scheduler
- ⛔ Put perception configuration on the `Camera` record, or let the runtime persist tenant data
- ⛔ Ship a profile catalogue, a mode selector or a capability whose backing does not exist
- ⛔ Create a new incident pipeline

---

## §15 · Decisions — ratified 2026-08-05

| Ref       | Decision                                                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-A** | **The frame path: media pushes frames to the runtime** (`NullFrameSink` is replaced)                         | 🔒 **Decided — option A**, by the Phase 2 instruction. The alternative (the runtime opening the sub-stream itself) was recommended and is **not** taken. What option A buys: **one RTSP session per camera**, so the concurrent-session limit of cheap devices never becomes a risk, and ⚠️ **the analysed frame is provably the recorded frame** — a custody argument that matters in an evidence product. What it costs: analysis fps is a media-side setting, the runtime's certified AI-5b live-ingestion path goes unused for this route, and analysis depends on media being up. **Revisit only if** per-camera transport cost or the coupling proves material in Phase 6 — as a new ADR, not a drift |
| **ADR-B** | **`CameraProcessingIntent` belongs to the Media domain.** Not a new microservice                             | 🔒 Ratified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **ADR-C** | Live video transport (HLS · LL-HLS · WebRTC · fMP4-over-WebSocket)                                           | ⏳ Still owed. Independent of perception — neither blocks the other                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —         | **Do not create another scheduler**; reuse the existing framework                                            | 🔒 Ratified — §3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —         | **Do not introduce another profile system**; a Processing Profile is `BehaviorProfile` + `DeploymentProfile` | 🔒 Ratified — §2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —         | **The AI Runtime is the critical path** and is the first implementation objective                            | 🔒 Ratified — §14 Phase 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| —         | **Processing intent ≠ measured capability.** A camera marked for analysis is not evidence AI is operating    | 🔒 Ratified — §5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —         | **No UI may advertise a capability that has not been deployed and verified**                                 | 🔒 Ratified — §13                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **D-4**   | Which behaviours ship first                                                                                  | Unchanged: loitering · intrusion · crowding. F-3 makes this cheaper than assumed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **D-7**   | May a `retired` camera be analysed?                                                                          | **No.** Lifecycle gates assignment; intent is retained so re-commissioning restores it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **D-8**   | Does a camera with analysis off still get a live-view connection?                                            | **Yes** — live view is an operator action, not processing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **D-9**   | Priority label: "Normal" or "Medium"?                                                                        | ⏳ Open — §10 recommends **Normal**, so one word appears in the screen, the API and every log line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## §16 · Risks

| ID       | Risk                                                                                                                                       | Sev      | Response                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SP-1** | ⚠️ **Deploying the runtime is treated as a packaging chore.** It is the critical path and nothing in P-8 works before it                   | **High** | Phase 1, alone, verified before anything connects to it                                                                                                     |
| **SP-3** | The assignment UI gets built before the gate, because it is the visible part                                                               | Med      | §14 order is a gate, not a preference — the Phase 3/4 note exists for exactly this                                                                          |
| **SP-4** | A capability is marked supported because a profile enables it                                                                              | Med      | §5 promotion rules: intent never promotes evidence                                                                                                          |
| **SP-5** | Cost estimates quoted to a customer as measurements                                                                                        | Med      | `estimated=True` is already in the model; the surface must render it                                                                                        |
| **SP-6** | The profile catalogue ships six entries to look complete                                                                                   | Med      | One real profile — §2                                                                                                                                       |
| **SP-7** | Fire/smoke reaches a customer uncertified — a false negative in a safety capability is a different class of failure than a missed loiterer | **High** | Safety capabilities require certification against labelled footage **with negatives** before a profile names them                                           |
| **SP-8** | ⚠️ **Analysis load degrades recording**, because under ADR-A they share one media process per camera                                       | **High** | Recording is the contractual obligation and analysis is the feature: back-pressure must shed **frames to the runtime**, never segments. Measured in Phase 6 |

> SP-2 (concurrent RTSP session limits) is **retired by ADR-A**: option A opens one session per
> camera, which is what the estate already sustains.

---

## §17 · Not built now

Nothing in this document is implemented. No contract changed, no code written, no frozen foundation
touched. **The architecture is frozen; implementation begins at §14 Phase 1.**

**Related:** [AI_EXECUTION_ARCHITECTURE](AI_EXECUTION_ARCHITECTURE.md) (canonical execution reference)
· [ANALYSIS_PROFILES](ANALYSIS_PROFILES.md) (ADR-0021) · [INFERENCE_SCHEDULER](INFERENCE_SCHEDULER.md)
· [HARDWARE_RECOMMENDATIONS](HARDWARE_RECOMMENDATIONS.md) · [AI_PACKS](AI_PACKS.md)
· [PLATFORM_BOUNDARIES](../PLATFORM_BOUNDARIES.md) · [L-37 / L-38](../../project/KNOWN_LIMITATIONS.md)
· [PRODUCT_ROADMAP P-8](../../project/PRODUCT_ROADMAP.md)

[CONSTRAINTS §41]: ../../project/CONSTRAINTS.md
