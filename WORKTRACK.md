# WORKTRACK

**Read this first.** Engineering handoff for the Vision Intelligence Platform — current state, not
history. Last revised **2026-08-10** at `9b5cc68`.

> Maintain this file. When a milestone closes, update it and delete what stopped being true.
> Milestone narrative belongs in `docs/project/`; this file is the 5-minute picture.

---

## 1. Project vision

**VIP is a CCTV intelligence platform that explains itself.** It watches video, decides what
happened, and produces an incident an operator can *disagree with* — every conclusion decomposes into
geometric facts, each naming the threshold it was computed at, each clickable back to a video frame.

**Long-term goal:** professional CCTV intelligence for retail — theft, loss prevention, queue and
staffing insight — without ever shipping an unexplainable verdict.

**Current maturity:** the platform reasons correctly about **people, places and movement** on real
footage. It reasons about **objects** only as far as a 3.7 MB detector allows. Infrastructure and
behaviour layers are frozen and production-grade; perception is the ceiling.

⭐ **Evidence durability is solved.** A completed run's evidence does not change after the run
completes — proven byte-identical across service, runtime, deployment and ungraceful restarts. And
when evidence *is* lost, the read says so: six states, never collapsed. See § 5 and § 6.

---

## 2. Current development stage

```
Foundation                ✔ Complete      6 foundations frozen, additive-only
Behaviour Intelligence    ✔ Complete      primitives · graph · reasoning · console
Evidence Integrity        ✔ Complete      durability · six-state reads · byte-identical replay
Professional Perception   ⬅ NEXT          YOLO11 / RT-DETR / pose / re-ID
Retail Intelligence         Not started   shelf, checkout, loss prevention
Production CCTV             Not started   RTSP estates, NVR, scale
Customer Deployments        Not started   install, support, SLA
```

---

## 3. Completed capabilities

| Capability | State |
| --- | --- |
| **Detection** | yolox-nano, 80 COCO classes, per-class confidence floors |
| **Tracking** | `predictive-iou` associator, stable identities across frames |
| **Identity** | identity ≠ track id; no id reuse (ADR-0038, ADR-0041) |
| **Recorded video pipeline** | upload → analyse → read, verified on real footage |
| **Live webcam pipeline** | `getUserMedia` → ingest → runtime → read, verified end to end |
| **Zone reasoning** | operator-drawn polygons; membership resolved once, in media (ADR-0053) |
| **Cross-line detection** | entry, exit, direction, repeat — one primitive, differently configured |
| **Behaviour primitives** | dwell · idle · linger · proximity · follow · approach · recede · group merge/split · queue · occlusion gaps |
| **Object association** | carried · picked — executed on real multi-class detections |
| **Behaviour graph** | identity / zone / line / object nodes; typed edges with evidence |
| **Reasoning engine** | composable temporal rules over the graph; 15 step kinds |
| **WHY chains** | every incident decomposes into clickable, traceable steps |
| **Investigation console** | timeline · graph · identity · primitives · reasoning · video, synchronised |
| **Evidence durability** | a run closes itself; nothing finished is held in memory |
| **Evidence states** | present · notYetAvailable · absent · lost · corrupted · expired |
| **Browser verification** | 8 spec files × 4 engines against the deployed stack |
| **Soak validation** | 6.5 h, 6 271 operations, 0 failures |

⚠️ Implemented ≠ verified on real footage. See § 6.

---

## 4. Current architecture

```
                Video  (recorded upload OR live webcam)
                  ↓
              Detection        yolox-nano · per-class floors
                  ↓
              Tracking         predictive-iou
                  ↓
              Identity         durable movement paths
                  ↓
              Behaviour        9 primitive modules
                  ↓
              Graph            nodes + typed edges
                  ↓
              Reasoning        composable temporal rules
                  ↓
              Console          six synchronised surfaces
```

⭐ **ONE pipeline serves both recorded and live video.** There is no second inference path — the
offline analyser and the live capability share the same adapter, postprocessor and stages. A contract
gate (`perception-boundary.mjs` §A) proves the runtime has exactly one caller.

⭐ **Nothing derived is persisted.** Timeline, graph, primitives and reasoning are pure functions over
stored movement paths, recomputed on every read (ADR-0054). A corrected formula fixes history instead
of being unable to reach it.

**Services:** gateway · identity · tenant · camera · media · events · evidence · rules · workflow ·
notify. Runtime is Python (stdlib + onnxruntime) on :8085, reachable only from media.

---

## 5. Verification status

| | State |
| --- | --- |
| **Repository gate** | ⭐ 70/70 green — `pnpm turbo lint typecheck test` |
| **Contracts** | ⭐ green — 70 generated schemas + perception boundary §A–§K |
| **Browser** | ⭐ green — chromium · firefox · webkit · edge, against built images |
| **Deployment** | ⭐ verified via `./infra/docker/prod.sh`, never `pnpm dev` |
| **Soak** | ⭐ 6.49 h · 6 271 timed operations · 0 failed · no operation drifted materially |
| **Replay** | ⭐ byte-identical across service · runtime · deployment · SIGKILL |
| **Evidence stress** | ⭐ 24 runs × concurrency 6, control clean; loss under kills always reported |
| **Production readiness** | ⭐ unblocked — the remaining ceiling is the detector, not correctness |

⚠️ Verification runs against **built images**. A change to console or runtime source is not verified
until `prod.sh build <svc>` has run — this has caused false failures twice.

---

## 6. Current known limitations

### 6.1 Implemented, needs more validation

- **`dropped`, `object_missing`, `object_returned`, `handover`** — implemented, unit-tested,
  deployed, **never executed on real footage**. One 30–60 s recording of two people and one carried
  object closes all four. See `docs/validation/OBJECT_FOOTAGE.md`.
- **Object detection recall** — 9 of 30 photographs chosen for a carried object have it admitted.
  Real, measured, and poor. The primitive is fine; the detector is the ceiling.
- **Physical-camera crossing** — automated live verification substitutes the lens, not the pipeline.
  A person walking past a real camera remains a manual UAT step.
- **Ambiguity case** — two people reaching for one object makes association alternate.
  `AssociationModule` has warned about this since it was written; never checked against reality.

### 6.2 Actually missing

- ⚠️ **Power-loss durability.** `write()` returns once the data is with the kernel, not once it is on
  the platter — there is no `fsync`. The platform survives process death, not power death. Stated
  rather than fixed: the cost was not measured, and it lands on the shutdown flush.
- **A cancelled run keeping what it saw** is unproven on real footage — every cancelled run in the
  stress suite detected nothing before stopping. Unit-tested, not evidenced. **PENDING FOOTAGE.**
- **Re-identification** — no appearance embedding, so nothing spans cameras or re-entry.
- **Pose / segmentation** — no keypoints, so "reached toward" and "hand on object" are not expressible.
- **Open-vocabulary detection** — hard 80-class ceiling.
- **GPU execution** — CPU only. RT-DETR is in the catalogue, `disabled`, at 944 ms/frame on CPU.

### 6.3 Future work

- Retail semantics (shelf interaction, checkout correlation) — deliberately absent; the platform
  states observations, and meaning lives in operator-written rules (ADR-0052).
- Multi-camera estates, RTSP/NVR at scale, installation and support tooling.
- Event spine non-linearity at 10 000 events (1 030/s → 235/s) — recorded, well above live rates.
- Unfiltered `/api/track-history` returns ~73 MB; scoped reads are 90 ms.

---

## 7. Immediate next work — Professional Perception

⭐ Evidence Integrity closed 2026-08-10. Full account: `docs/project/EVIDENCE_INTEGRITY_REPORT.md`.
Four root causes, each measured before it was fixed: shutdown discarded open evidence; one fact was
held at two precisions; **nothing closed a run when it ended** (28 identities across 12 finished runs
lost to one `SIGKILL`); and a torn write destroyed the record appended after it.

⚠️ **Two decisions are outstanding before any Phase 3 code.** YOLO11 is **AGPL-3.0** where every
catalogue model today is Apache-2.0. Re-identification is **biometric processing** and needs a
governance decision and an ADR. Design: `docs/project/PROFESSIONAL_PERCEPTION_ARCHITECTURE.md`.

The approved implementation order: detector benchmark lab → YOLO11 / RT-DETR → pose → segmentation →
re-ID → open-vocabulary → object permanence → hand-object → shelf → retail behaviour → theft
reasoning.

<details>
<summary>Why Evidence Integrity came first (kept — the reasoning still applies to the next phase)</summary>

### Why this before Professional Perception

⛔ **Because every perception capability multiplies the facts a run produces, and multiplying facts
that are not durably stored multiplies the loss — invisibly.** Pose, segmentation and re-ID would all
be verified by reads taken minutes after a run and would all silently degrade by the hour. We would
be measuring a system that forgets, and calling the measurement a benchmark.

⚠️ It is also not a perception problem at all. An investigation opened an hour after an incident
currently shows fewer facts than the same investigation opened immediately. For a platform whose
entire proposition is *explainable evidence*, that is the defect that matters most.

### What will be built

1. **Confirm the mechanism.** Hypothesis: retirement runs on the frame path (`_sweep` /
   `_close_history`, *"no timer, no thread"*), so a stream that has stopped sending frames is exactly
   the one nothing drives. `retire_stream` already exists and is already called on the camera-idle
   path. Confirm before fixing.
2. **Close open identities when a run ends**, driven by something other than the arrival of more
   frames. No new service, no new stage.
3. **Make the loss impossible to miss.** A read whose sources shrank must say so — the same
   discipline as `lineGeometry` (four states) and `associationDiagnostic` (six reasons). Silence that
   used to be a fact must never render as a fact that never existed.
4. **Prove it with replay.** `tools/validation/association-replay.mjs` already diffs reads byte for
   byte. Acceptance: a run's reads taken immediately and one hour later are **identical**.
5. **Regression suite + browser spec** that would fail today, plus retention and provenance checks
   across the evidence boundary.

⭐ Acceptance was a single sentence: *a completed run's evidence does not change after the run
completes.* It holds.

</details>

---

## 8. After that

```
Professional Perception     detector abstraction · benchmark lab · YOLO11 / RT-DETR · pose · re-ID
      ↓
Retail Intelligence         shelf interaction · checkout correlation · loss prevention
      ↓
Production CCTV             RTSP estates · NVR · multi-camera scale
      ↓
Customer Deployments        installation · support · SLA
```

Design for the next phase: `docs/project/PROFESSIONAL_PERCEPTION_ARCHITECTURE.md` (design only).

⚠️ **Two decisions are outstanding and can invalidate unstarted work.** YOLO11 is **AGPL-3.0** where
every catalogue model today is Apache-2.0. Re-identification is **biometric processing** and needs a
governance decision and an ADR before any code.

---

## 9. Current metrics

| | |
| --- | --- |
| Python tests | **1 540** |
| TypeScript tests | 636 console · 529 contracts · 384 media · 315 rules · 278 camera · 82 events · 45 e2e |
| Browser tests | 8 spec files × 4 engines |
| Contracts | 70 schemas + perception boundary §A–§L |
| Repository gate | **70/70 green** |
| Deployment | ⭐ verified — built images, `prod.sh` |
| Soak | 6.49 h · 6 271 ops · **0 failed** (2026-08-09) |
| Current detector | `yolox-nano` 1.0.0 · 416×416 · CPU · **41.2 ms/frame**, 21.7 fps |
| Current tracker | `predictive-iou` |
| Current reasoning | composable temporal rules over the behaviour graph · 15 step kinds · WHY chains |
| Evidence replay | ⭐ byte-identical · service · runtime · deployment · SIGKILL |

---

## 10. Executive summary

**What is completed.** The full path from video to explained incident, for both recorded and live
sources, over one pipeline. Detection, tracking, identity, nine behaviour primitive families, zone
and line reasoning, a behaviour graph, a composable temporal rule engine producing WHY chains, and a
six-surface investigation console synchronised to the video. Six platform foundations are frozen and
change additively only.

**What is verified.** Gate 70/70; contracts green across a language-boundary checker with eleven
sections; browser certification on four engines against built images; a 6.5-hour soak with zero
failures; and — the part that matters — behaviour verified on **real footage**, with negative
controls, on the deployed stack rather than a dev server. Where footage did not exist, the reports
say `PENDING FOOTAGE` rather than claiming a pass.

**What remains.** Perception. The behaviour vocabulary is now larger than what a 3.7 MB detector can
see, and four object primitives have never had real input. Then retail semantics, estate scale, and
deployment tooling. ⚠️ One durability gap is stated rather than closed: writes are not `fsync`ed, so
the platform survives process death and not power death.

**How close is production-ready?** ⭐ **The hard part is done and it is the part most platforms get
wrong**: this one can explain itself, and it says so honestly when it cannot see something. The
architecture is frozen, the pipeline is single, and the verification discipline is real —
fourteen defects were found in the last three milestones, every one a *correct-looking silence*, and
none by a unit test.

⭐ **VIP is now a production-ready behaviour intelligence platform whose *accuracy ceiling* — not its
correctness, not its explainability — is set by the detector.** Evidence survives the run that
produced it, byte for byte, across every lifecycle event short of pulling the plug; and when
something is lost, the platform names which of six things happened rather than returning the same
empty list it returns for a quiet afternoon. Professional Perception raises the ceiling.
