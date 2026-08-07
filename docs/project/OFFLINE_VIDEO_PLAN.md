# P-8 Phase 8 · Offline Video Investigation

**Upload an MP4. Get incidents, evidence and a report — from the same pipeline that serves a live
camera.**

**Written 2026-08-07.** This plans work; it authorises none of it. Closes **C-21** and **TD-9 G-2**,
both open since the Phase-1 exit review.

> ⚠️ **Reuse is not an aspiration here, it is the acceptance criterion.** This milestone adds **no
> inference, no tracking, no rule evaluation, no overlay rendering and no service.** If a slice below
> finds itself writing perception code, the slice is wrong, not the platform.

Related: [PRODUCT_READINESS](PRODUCT_READINESS.md) · [PRODUCT_IMPLEMENTATION_ORDER](PRODUCT_IMPLEMENTATION_ORDER.md) ·
[PHASE_8_PLAN](PHASE_8_PLAN.md) · [ADR-0043](../adr/ADR-0043-assignment-is-a-control-plane-with-a-measured-data-plane.md) ·
[ADR-0036](../adr/ADR-0036-browser-facing-object-storage-endpoint.md)

---

## 1 · Why this milestone, and why now

Three arguments, in descending order of strength.

**1 · ⭐ It is the only way to validate anything without hardware.** Every perception capability in the
matrix carries `⬜ unvalidated` for pilot readiness, and the reason is always the same: no real footage
has ever passed through the chain. The fixtures are ffmpeg test patterns, composited sprites on
authored trajectories, and a CC0 photograph of two people looped over RTSP. **An uploaded MP4 is real
footage.** This milestone converts "we have never seen real video" into "we can analyse any video a
customer sends us", and it does it while the purchase order for cameras is still being signed.

**2 · It is the verification instrument for everything after it.**
[PHASE_8_PLAN](PHASE_8_PLAN.md) §4.1 schedules the capability pack first and warns, in its own words,
that the risk is _"a capability that is configurable and unverified… five templates nobody has run are
five of those waiting"_. The thing that runs them is this. P-8's own exit criterion — _"loitering,
intrusion and crowding each fire on recorded footage a **human** labelled first"_ — is unmet today and
unmeetable without an offline path. ⚠️ **This is why the two are swapped relative to PHASE_8_PLAN §4**,
and it is the only change to that plan's ordering.

**3 · It is the customer's first-day workflow and it needs nothing installed.** _"Here is yesterday's
footage from the camera we already own — tell me what happened in it."_ A prospect can evaluate the
product before agreeing to a site survey, and a customer whose incident happened last Tuesday can
investigate it, which is the request a security team actually makes.

⚠️ **A fourth reason, stated as a consequence rather than a goal:** analysed footage with a human's
labels beside it is the labelled corpus that **TD-64** (no accuracy gates on the model) and **TD-68**
(no accuracy number on real footage) have been blocked on. This milestone does not close either — it
removes the reason they could not be started.

---

## 2 · Architecture

### 2.1 The chain, and what is new in it

```
 Console  ──upload──▶  media                                    ◀── 1 new route group
                        │
                        ├─▶ MinIO  (@vip/storage, tenant-scoped)   ◀── existing package
                        │
                        └─▶ job worker  (@vip/jobs, kind=ai.analyse) ◀── NEW package, first consumer
                              │
                              ├─▶ ffmpeg  -i <file>                  ◀── existing decoder, file input
                              │
                              └─▶ HttpFrameSink ─▶ runtime POST /infer   ◀── UNCHANGED
                                                      │
   ┌──────────────────────────── everything below this line is untouched ──────────────────────────┐
   │  runtime: detect ▸ track ▸ NatsEventSink                                                      │
   │      └─▶ t.{tenant}.capability.output.*  ▸ events: normalize ▸ dedup ▸ persist                │
   │              └─▶ t.{tenant}.event.*      ▸ rules: condition ▸ window ▸ dwell ▸ zones          │
   │                      └─▶ IncidentCandidate ▸ workflow ▸ Incident ▸ evidence ▸ console         │
   └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**New code, in full:** an upload/analysis route group in media, a job worker package with its loop
inside media, a file-source mode on the existing decoder, and a console feature. **That is the
milestone.**

### 2.2 Why media owns it, and why that is not a new service

`JobOwner` is already `['workflow', 'evidence', 'media']`, and `JobKind` already reserves **`ai.analyse`**
— _"run a capability over stored media out of band. ⚠️ Reserved — AI Runtime v1.0 is closed; this
submits work to the existing runtime and adds no new inference architecture"_ — plus `import.bulk`,
`analysis.offline` and `media.render`. ⭐ **The contract for this milestone was frozen at P-5.2 and has
been sitting unused ever since.** Media already owns decoding, the frame sink, the object store and
the catalogue. Nothing moves.

⚠️ **`@vip/jobs` is Track A work and it must be justified by Track B, not built ahead of it.** It is
justified here: a two-hour recording cannot be analysed inside an HTTP request, and P-11 prescribes
exactly this package with _"the worker loop inside each owning service"_ because a central job service
would need read access to every context ([CONSTRAINTS §5](CONSTRAINTS.md)). This milestone builds the
smallest correct version of it with a real consumer, instead of P-11 building it speculatively.
**C-46 moves from P-11 to here, and P-11 gets shorter.**

### 2.3 The single hardest decision: what time is it?

⭐ **This is the milestone.** Everything else is plumbing.

The entire downstream chain is keyed on **event time** (`occurredAt`): the events service's dedup
window, the rule engine's `window` stage, the dwell stage, and the cool-down. Verified while writing
this plan:

- `services/events/src` contains **no `Date.now()` at all**.
- `services/rules/src/domain/dwell.ts` is explicit: _"Time comes from the event, not from the node.
  `atMs` is the envelope's `occurredAt`"_.

So if a frame carries the right `occurredAt`, **the entire chain gives the same answer offline as it
does live, at any replay speed.** If it carries `Date.now()`, every time-based rule is wrong by the
ratio between the replay speed and real time — silently, with no error anywhere.

**Decision — three clocks, kept apart:**

| Clock            | Value                                      | Used for                                              |
| ---------------- | ------------------------------------------ | ----------------------------------------------------- |
| **Footage time** | `footageStartedAt + seq / frameRate`       | ⭐ `Frame.at` → `occurredAt` → **every rule stage**   |
| **Wall time**    | `Date.now()`                               | `Incident.raisedAt`, job progress, audit, SLA         |
| **Media offset** | `seq / frameRate`, seconds from file start | The analysis timeline, evidence clip ranges, playback |

⚠️ **`footageStartedAt` is supplied by the operator and defaults to the file's container creation time
when one is present.** It cannot be inferred and must not be guessed: an incident stamped "today" for
footage from last Tuesday is a report that is confidently wrong about when something happened, which is
the same class of defect as [TD-20](../../tracking/TECH-DEBT.md) (evidence resolving _current_
ancestry). The console shows both times and says which is which.

⚠️ **The `seq / frameRate` derivation is exact by construction** — the decoder's `-vf fps=N` filter
emits uniformly spaced frames — **but it must be pinned rather than assumed.** A variable-frame-rate
source with `fps_mode` left at its default can drift. Slice 3 measures the derived timestamp of the
last frame against the container's duration and fails on a drift over one frame interval.

---

## 3 · Customer workflow

```
Upload MP4 ─▶ Select camera ─▶ Confirm footage start ─▶ Run ─▶ Progress
                                                                  │
  ┌───────────────────────────────────────────────────────────────┘
  ▼
Timeline (detections · tracks · events · incidents, in footage time)
  ▼
Incidents ─▶ the existing Investigation Workspace ─▶ evidence clip ─▶ export
```

**Step by step, with what each step reuses:**

| #   | Step               | Reuses                                                    | ⚠️ Notes                                                                     |
| --- | ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | **Upload**         | `@vip/storage` `TenantObjectStore`, MinIO, ADR-0036       | Two-step presigned PUT, **not** multipart through the gateway — §6.1         |
| 2   | **Select camera**  | Camera registry (C-08)                                    | ⭐ The camera is what carries the **zones and the rules**. It is not a label |
| 3   | **Footage start**  | —                                                         | Defaulted from the container, always confirmable, never silently assumed     |
| 4   | **Run**            | `@vip/jobs` + the frozen `Job` contract                   | `kind: 'ai.analyse'`, `owner: 'media'`. Queued, bounded, cancellable         |
| 5   | **Decode**         | `FfmpegDecoder` (`-i url`, already non-RTSP capable)      | ⚠️ No `-re`. Decode as fast as the runtime will accept frames                |
| 6   | **Inference**      | `HttpFrameSink` → `POST /infer` — **byte-identical path** | ⛔ Must respect the assignment gate — §7 R-3                                 |
| 7   | **Track → events** | Runtime tracker → `NatsEventSink` → events service        | Zero changes                                                                 |
| 8   | **Rules**          | condition · window · dwell · zone scope                   | Zero changes. This is where the time decision pays or fails                  |
| 9   | **Incidents**      | Workflow, frozen lifecycle (ADR-0045)                     | ⚠️ Must be **distinguishable** from live incidents — §7 R-1                  |
| 10  | **Evidence**       | Evidence context, custody chain, integrity hashes         | The clip references the **uploaded asset** + an offset range                 |
| 11  | **Export**         | P-11 report renderer, or the existing evidence download   | ⚠️ Scoped as _stretch_ — §9                                                  |

---

## 4 · APIs

All additive. **No frozen contract changes** except the one in §4.3, which needs an ADR.

### 4.1 New routes — media service, `/api/media/*` through the gateway

| Method   | Route                    | Permission       | Purpose                                                        |
| -------- | ------------------------ | ---------------- | -------------------------------------------------------------- |
| `POST`   | `/analyses`              | `stream:control` | Create an analysis; returns an id and a **presigned PUT URL**  |
| `POST`   | `/analyses/:id/start`    | `stream:control` | Asset uploaded → submit the `ai.analyse` job                   |
| `GET`    | `/analyses`              | `stream:read`    | Page of analyses, keyset-paged like the camera list            |
| `GET`    | `/analyses/:id`          | `stream:read`    | State, progress, counts, findings                              |
| `POST`   | `/analyses/:id/cancel`   | `stream:control` | Cancel a queued or running job                                 |
| `DELETE` | `/analyses/:id`          | `stream:control` | ⚠️ Removes the asset. **Refused** if evidence references it    |
| `GET`    | `/analyses/:id/timeline` | `stream:read`    | Derived: events + incidents + track spans, in **footage time** |
| `GET`    | `/analyses/:id/playback` | `stream:read`    | Signed URL to the source asset (ADR-0036 pattern)              |
| `GET`    | `/jobs/:id`              | `stream:read`    | The frozen `Job` shape. ⭐ Generic — not analysis-specific     |

### 4.2 New contracts — `packages/contracts/src/media/analysis.ts`, additive

```ts
VideoAnalysisState = 'draft' | 'uploaded' | 'queued' | 'running'
                   | 'succeeded' | 'failed' | 'cancelled'

VideoAnalysis {
  id, tenantId, cameraId, jobId?
  asset: { key, bytes, contentType, durationSeconds, codec, resolution, frameRate }
  footageStartedAt: IsoDateTime      // ⭐ the operator's answer, never inferred silently
  footageStartSource: 'operator' | 'container-metadata'
  analysisFrameRate: number          // frames per second of FOOTAGE analysed
  state, progress, startedAt?, finishedAt?
  counts: { framesDecoded, framesAnalysed, framesDropped, detections, events, incidents }
  findings: AnalysisFinding[]        // ⚠️ see below
}
```

⚠️ **`findings` is not decoration.** It is where the analysis says what it could not do: a codec it had
to transcode, a stretch where the runtime shed frames, an assignment gate it had to wait on, a zone
that was disabled. An analysis that returns zero incidents and no findings is a claim that nothing
happened; one that returns zero incidents and a finding is a claim that we could not tell.
[ADR-0039](../adr/ADR-0039-absent-metrics-are-unavailable-never-zero.md) applied one layer up.

### 4.3 ⚠️ The one frozen contract that must change — and its ADR

**`IncidentCandidate` and `Incident` must carry analysis provenance.**

⛔ **Without it, an offline analysis pollutes the live product**: incident counts, mean-time-to-resolve,
the operator's queue, SLA timers and every future dashboard would mix "this happened on your premises"
with "this is what would have happened if that rule had been on last Tuesday". There is no way to
separate them afterwards, because nothing recorded the difference.

**Proposed — `ADR-0047 · An incident knows whether it happened or was reconstructed`:**

- One optional, additive field: `analysisId?: string` on `IncidentCandidate`, carried to
  `Incident.source`. Absent ⇒ live. Present ⇒ reconstructed from a named analysis.
- ⚠️ **Absent must mean live, and that must be a decision rather than a default.** Every incident that
  exists today has no field, and they are all live — so the absent case is correct for history, which
  is the property that makes the field additive rather than a migration.
- The incident queue **excludes** analysis incidents by default and says so in the empty state; the
  analysis detail page is where they live. SLA timers do not run on them.
- ⚠️ **Rule statistics count them separately or not at all.** A dry-run rule already has this problem
  solved (`dryRun` is a property of the rule, visible in its list) and the same discipline applies.

---

## 5 · UI

New feature directory `apps/console/src/features/investigations/`. **Four screens, three of which are
thin.**

| Route                    | Screen              | ⭐ Reuses                                                          |
| ------------------------ | ------------------- | ------------------------------------------------------------------ |
| `/investigations`        | Analysis list       | The camera list's server-side keyset paging and table primitives   |
| `/investigations/new`    | Upload              | Presigned PUT + progress; the zone editor's camera picker          |
| `/investigations/:id`    | **Analysis detail** | `PlaybackTimeline`, `EvidencePlayer`, `ZoneCanvas` — all shipped   |
| `/workspace/:incidentId` | Investigation       | ⭐ **Unchanged.** An offline incident opens the existing workspace |

**The analysis detail screen is the only real design work.** It is the existing playback timeline with
three extra lanes below the scrubber, all in footage time:

```
 ├─ video ────────────────────────────────────────────────────────────┤
 ├─ detections   ▁▂▅█▅▂▁▁▁▁▂▃▂▁▁▁▁▁▁▁▁▂▅█▇▅▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ │  density bar (shipped)
 ├─ tracks       ──── #1 ────────      ── #2 ──────────────           │
 ├─ zone dwell   ░░░░▓▓▓▓████░░░░                                     │  accumulating ▸ met
 └─ incidents         ▲                              ▲                │  click ▸ workspace
```

⚠️ **Every lane must be derivable from data the platform already stores.** Detections are ephemeral by
design ([18-DATA-ARCHITECTURE](../architecture/18-DATA-ARCHITECTURE.md) — raw detections are TTL'd,
only aggregates and events persist), so the detections lane is drawn from **persisted events**, not
from detections. If a lane needs a new store, the lane is cut.

⚠️ **No overlay renderer.** Boxes burned onto video are `media.render` (reserved, not this milestone).
The detail page draws zones on a **snapshot** using the shipped `ZoneCanvas`, exactly as the zone
editor does.

---

## 6 · Storage

### 6.1 ⚠️ Upload does not go through the gateway

A 2 GB multipart POST through Caddy → gateway → media buffers a customer's video in three processes and
turns a JWT-authorised request into a fifteen-minute connection. **Two-step, presigned:**

```
POST /api/media/analyses            → { id, uploadUrl, expiresAt }   (JWT, 15-min TTL)
PUT  <uploadUrl>                    → MinIO, direct from the browser
POST /api/media/analyses/:id/start  → media HEADs the object, probes it, submits the job
```

⭐ **ADR-0036 already decided the browser may talk to object storage directly** for evidence playback.
This is the same decision in the opposite direction and needs no new ADR — but it does need the
**write** half of the policy stated: a presigned PUT is scoped to one key, one tenant prefix, one
content type and a short expiry, and the object is **not trusted until media has probed it**.

### 6.2 Layout, limits and lifetime

| Concern        | Decision                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Key**        | `t/{tenantId}/analyses/{analysisId}/source.{ext}` — via `TenantObjectStore`, which already enforces the prefix   |
| **Size**       | ⚠️ A configured ceiling with a **stated default** (2 GB). Refused at `POST /analyses`, before a byte is uploaded |
| **Containers** | `mp4`, `mkv`, `mov`, `avi`. ⛔ Allow-list, never a deny-list                                                     |
| **Codecs**     | H.264 and H.265 probed on ingest. ⚠️ **`hev1` is warned about** — WebKit genuinely cannot play it (TD-29)        |
| **Retention**  | ⭐ An uploaded file is **customer data**: `retainUntil` and `legalHold` apply, exactly as evidence does          |
| **Deletion**   | ⛔ Refused while any evidence record references the asset. A dangling clip is worse than a full disk             |
| **Disk**       | ⚠️ Decode is streamed from the object store. **Nothing writes the whole file to a container's filesystem**       |

### 6.3 ⛔ Untrusted input, treated as such

An uploaded file is the first arbitrary customer-controlled binary this platform has ever handed to a
subprocess. Non-negotiable:

1. **Probe before decode** (`ffprobe`), and refuse on anything the allow-list does not name.
2. **Never interpolate a filename into a shell.** The decoder already uses `spawn` with an argument
   array — keep it.
3. **The object key is generated, never taken from the upload.** No path traversal surface exists if
   the customer never supplies a path.
4. **Bounded decode**: a wall-clock ceiling per job and a hard frame ceiling, both configured. A
   maliciously crafted file that decodes to ten million frames must fail as a job, not as a host.
5. **The original filename is metadata, displayed escaped, and is never a path.**

---

## 7 · Risks

| #       | Risk                                                                                                    | Severity | Mitigation                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R-1** | ⭐ Offline incidents pollute live metrics, queues and SLAs                                              | ⛔ high  | `analysisId` provenance + **ADR-0047** (§4.3). Queue excludes by default; SLA timers do not run                                                                                                                                                               |
| **R-2** | ⭐ An analysis evicts a **live** customer's in-progress dwell                                           | ⛔ high  | `InMemoryDwellStateStore` has one 50 000-entry LRU shared by everything, touched by **wall clock**. Namespace analysis keys and give them a separate budget. Verified by a test that runs an analysis beside a live dwell and asserts the live visit survives |
| **R-3** | An analysis of a camera with AI **unassigned** silently produces nothing ([L-54](KNOWN_LIMITATIONS.md)) | ⚠️ med   | The gate is checked at `POST /start` and **refuses with a named reason**, offering to assign. ⛔ Never bypass the gate — it is a control plane (ADR-0043)                                                                                                     |
| **R-4** | Offline analysis starves live perception of CPU                                                         | ⛔ high  | ⚠️ Sizing is **2 cameras per host at 2 fps** ([L-41](KNOWN_LIMITATIONS.md)). One analysis at a time per runtime by default; it counts against the same budget; it is the **first** thing shed under pressure. Same rule as recording > perception             |
| **R-5** | Replay speed changes the answer                                                                         | ⛔ high  | The three-clock decision (§2.3), and a **1× vs 8× byte-identical** acceptance criterion                                                                                                                                                                       |
| **R-6** | The dedup window makes short dwell unreliable ([L-57](KNOWN_LIMITATIONS.md))                            | ⚠️ med   | Inherited, not introduced. ⭐ **Offline analysis is the first tool that can measure it** — the finding goes in the analysis, not in a footnote                                                                                                                |
| **R-7** | An uploaded file is untrusted input to ffmpeg                                                           | ⚠️ med   | §6.3, all five rules                                                                                                                                                                                                                                          |
| **R-8** | Storage cost grows without bound                                                                        | ⚠️ low   | Retention on the asset from day one; the size ceiling; the analysis list shows total bytes per tenant                                                                                                                                                         |
| **R-9** | ⚠️ A customer reads "no incidents" as "nothing happened"                                                | ⚠️ med   | `findings` (§4.2) and an empty state that states what was analysed, at what rate, against which rules — **never a bare zero**                                                                                                                                 |

---

## 8 · Implementation order

Seven slices. ⚠️ **Each slice ends with the deployment green** and carries its own verification.

| #     | Slice                                | Delivers                                                                                     | Proves                                                                                         |
| ----- | ------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **1** | **`@vip/jobs` + the media worker**   | Lease/claim protocol over the frozen `Job` contract; worker loop in media; `GET /jobs/:id`   | A job survives a service restart mid-run and is not run twice                                  |
| **2** | **Upload & asset lifecycle**         | `POST /analyses`, presigned PUT, probe, allow-list, retention, refusal-to-delete             | ⛔ A 4 GB file, a `.exe` renamed `.mp4` and an `hev1` file are each refused or warned, by name |
| **3** | **⭐ File decode with footage time** | Decoder file mode, `Frame.at` from `footageStartedAt + seq/rate`, drift assertion            | ⭐ Derived last-frame time matches container duration within one frame interval                |
| **4** | **The chain, end to end**            | Job runs decode → `/infer` → events → rules → incident, with `analysisId` provenance         | ⭐ **1× and 8× produce identical incidents** — count, dedup keys, dwell durations              |
| **5** | **Console: list, upload, detail**    | Three screens, timeline lanes from persisted events, incidents linking to the workspace      | Every route renders against the **deployment**; nothing off-screen at 390→1920                 |
| **6** | **Evidence & isolation**             | Clip refs into the asset; queue exclusion; SLA exclusion; dwell-state namespacing (R-2)      | ⭐ A live dwell survives a concurrent analysis; a live queue shows no analysis incidents       |
| **7** | **Verification & governance**        | The eight deliverables, nightly stage, benchmark, mutation set, matrix + limitations updates | The night runs it unattended and a mutation turns it red                                       |

⚠️ **Slice 1 is Track A and is the only part of this milestone with no customer value on its own.** It
is first because slices 2–7 cannot start without it, and it is bounded: lease, claim, heartbeat,
progress, terminal states, one owner. ⛔ **No scheduler, no cron, no priorities, no DAG.** `JobSchedule`
exists in the contract and stays unimplemented — it belongs to P-11's scheduled reports.

---

## 9 · Scope boundaries

**In scope:** upload · probe · analyse · track · rule · incident · evidence reference · timeline ·
the console screens · provenance · retention.

**⛔ Out of scope, deliberately:**

| Excluded                            | Why, and where it goes                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Burned-in overlay video**         | `media.render`, reserved. A snapshot with `ZoneCanvas` answers the same question for a tenth of the work                                                           |
| **Report generation** (C-47)        | **P-11.** ⚠️ The export button ships **only** if P-11's renderer lands first; otherwise the analysis detail page offers the existing evidence download and says so |
| **Multi-file / batch analysis**     | One file, one camera, one analysis. Batching is a job-queue feature and the queue will be one week old                                                             |
| **Re-analysis with a changed rule** | ⭐ Genuinely valuable ("what would this rule have caught?") and it is `analysis.offline`, a **second** milestone. Doing it here doubles the surface                |
| **Live video in the console**       | C-22 / TD-28. Unrelated and still needs its transport ADR                                                                                                          |
| **Cross-camera correlation**        | ⛔ Research ([VERTICALS §4](../customer-workflows/VERTICALS.md))                                                                                                   |
| **Any new inference or tracking**   | AI Runtime v1.0 is **closed**                                                                                                                                      |

---

## 10 · Verification

The eight deliverables ([DEFINITION_OF_DONE](DEFINITION_OF_DONE.md)), all in the same commit as the
work.

| Deliverable    | This milestone                                                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**    | Unit tests: job lease/claim, footage-time derivation, probe allow-list, provenance, dwell namespacing                                                                                          |
| **Metrics**    | `analysesQueued/Running/Succeeded/Failed`, frames decoded vs analysed vs dropped, minutes-of-footage per minute-of-wall-clock. ⚠️ **Absent is `null` with a reason**, never `0` (ADR-0039)     |
| **Browser**    | Playwright over the three screens against the deployment; 390→1920                                                                                                                             |
| **Deployment** | `docs/review/p8p8/offline-analysis.mjs` — upload → incident → evidence, on the production stack, clean tree                                                                                    |
| **Mutation**   | ⭐ Five named: (1) `Frame.at = Date.now()` (2) provenance dropped (3) assignment gate bypassed (4) dedup key from wall time (5) dwell namespace removed. **Each must turn a verification red** |
| **Nightly**    | `stages/offline/analysis.sh` in `nightly.stages`, registered in the commit that introduces it                                                                                                  |
| **Benchmark**  | Throughput ladder at 1×/4×/8× and 1/2/4 concurrent analyses, ⭐ **with live recording running throughout**                                                                                     |
| **Governance** | C-21 row, TD-9 G-2 closed, C-46 moved, ADR-0047, KNOWN_LIMITATIONS entries, this document's status                                                                                             |

⚠️ **The 8× benchmark must run as a nightly stage, not during the day** — [verification economy](VERIFICATION_AUDIT.md):
10–15 minutes by default, long runs registered as a nightly stage in the same commit.

---

## 11 · Acceptance criteria

Track this milestone closed only when **every** line is verified against the deployment on a clean tree.

- [ ] An operator uploads an MP4 in the console and an incident appears, **unaided by an engineer**
- [ ] ⭐ **The same file at 1× and at 8× produces identical incidents** — same count, same dedup keys, same dwell durations to the millisecond
- [ ] ⭐ **A human labels a clip first, and the platform's incidents match the labels** — including at least one **negative** clip that must produce nothing
- [ ] An offline incident opens in the existing Investigation Workspace with an intact custody chain
- [ ] ⛔ An offline incident **never** appears in the live incident queue and **never** starts an SLA timer
- [ ] ⛔ A live camera's dwell in progress **survives** a concurrent analysis of a two-hour recording
- [ ] ⛔ Recording continues, unaffected, throughout every analysis — measured, not asserted
- [ ] An analysis of a camera with AI unassigned **refuses with a named reason** and offers to assign
- [ ] A 4 GB file, an executable renamed `.mp4`, and a zero-byte file are each refused **by name**
- [ ] An `hev1` recording produces a **warning naming Safari**, not a silent success
- [ ] A job survives a media restart mid-analysis: it resumes or fails cleanly, and **never runs twice**
- [ ] Cancelling a running analysis stops decode within one frame interval and leaves no orphan process
- [ ] Deleting an analysis whose evidence is referenced is **refused**, with the reference named
- [ ] An analysis that finds nothing reports **what it analysed**, never a bare zero
- [ ] All eight deliverables present; the nightly stage runs unattended; **each of the five mutations turns a verification red**
- [ ] Capability matrix, limitations, tech debt and ADR-0047 updated **in the same commits as the work**

---

## 12 · Estimate

**5–7 engineer-days of implementation, 2–3 of verification and governance. Call it two weeks.**

| Slice | Days    | Confidence | ⚠️ Where it slips                                                         |
| ----- | ------- | ---------- | ------------------------------------------------------------------------- |
| 1     | 1.5–2   | high       | The restart-safety test is the whole slice; the loop itself is an evening |
| 2     | 1       | high       | —                                                                         |
| 3     | 0.5–1.5 | ⚠️ medium  | ⭐ Frame-rate drift on a VFR source. **The single most likely surprise**  |
| 4     | 1–2     | ⚠️ medium  | The 1× vs 8× parity is where an unnoticed wall clock will surface         |
| 5     | 1.5–2   | high       | Timeline lanes; everything else is existing primitives                    |
| 6     | 1       | ⚠️ medium  | R-2 may need a `DwellStateStore` port change — additive, but it is a port |
| 7     | 2       | high       | Non-negotiable and not compressible                                       |

⚠️ **The estimate assumes slices 3 and 4 find something.** They are the two that run existing code
under a condition it has never met, and this platform's record on that is eleven defects in P-9 and
nine in P-5.8. **An estimate for switching something on that assumes nothing breaks is not an
estimate.**
