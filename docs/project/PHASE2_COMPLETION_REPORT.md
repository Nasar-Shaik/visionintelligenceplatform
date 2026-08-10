# Phase 2 — Behaviour Intelligence: completion report

**2026-08-10.** Slices 2.1 → 2.10, closing at `a8d5095`. Every number in this document was measured
against the deployed stack at `https://localhost` running the built images, or is a count taken from
the repository at that commit. ⛔ **Nothing here is estimated, and nothing is simulated.**

> **Verdict: production-complete for the capabilities listed in § 3, with one blocker (§ 8.1) that
> must be fixed before an investigation's evidence can be relied on hours after the event.**
> The blocker is an evidence-durability defect, not a perception one, and it is fixable inside the
> frozen architecture.

---

## 1. What Phase 2 set out to do, and whether it did it

| objective | state |
| --- | --- |
| Make all intelligence visible | ⭐ done — five console surfaces over the existing reads, no duplicate computation |
| Make all intelligence explainable | ⭐ done — every incident carries a WHY chain of clickable, traceable steps |
| Make it production-ready | ⚠️ **qualified** — deployed, gated and browser-certified; see § 8.1 |
| Begin no retail-specific AI | ⭐ held — every primitive passes the hospital test (ADR-0052) |

---

## 2. Architecture

⭐ **Nothing in the frozen AI Runtime v1.0 architecture changed in Phase 2.** No new service, no new
pipeline stage, no new runtime, and every contract change additive. Behaviour arrived as a *plugin
task* through the seam P-10 built for exactly that purpose.

```
                    ┌───────────────────────────────────────────────────────────────┐
  operator ────────▶│  console (React 19)                                           │
                    │   timeline · graph · identity · primitives · reasoning · video │
                    └───────────────┬───────────────────────────────────────────────┘
                                    │  /api/behaviour/{timeline,graph,primitives}
                                    │  /api/track-history · /api/rules/…/evaluate
                    ┌───────────────▼──────────┐
                    │  gateway                 │  tenant + authz, one edge
                    └───────────────┬──────────┘
                ┌───────────────────┼────────────────────┐
                ▼                   ▼                    ▼
        ┌───────────────┐   ┌───────────────┐    ┌────────────────┐
        │ media         │   │ rules         │    │ camera         │
        │ ⭐ the ONLY   │   │ behaviour     │    │ zones: polygon │
        │ caller of the │   │ reasoning     │    │ rectangle line │
        │ runtime (§A)  │   │ (WHY chains)  │    └───────┬────────┘
        └───────┬───────┘   └───────────────┘            │ assignment plan
                │ frames + zone membership + line geometry│
                ▼                                        │
        ┌────────────────────────────────────────────────▼──────────┐
        │  inference runtime :8085  — perception only, stdlib + ORT  │
        │                                                            │
        │  FrameContext ─▶ preprocess ─▶ infer ─▶ postprocess ──┐    │
        │                                     (per-class floors)│    │
        │       ┌────────────────────────────────────────────────┘    │
        │       ▼  StageChain — ⭐ a stage added without adding a stage │
        │   RuntimeTracker ─▶ BehaviourStage ─▶ translate ─▶ Detection │
        │       │                    │                                │
        │       ▼                    ▼                                │
        │  track history       9 behaviour modules                    │
        │  (durable,           motion · zone · relational ·           │
        │   ADR-0051)          association · presence · grouping ·    │
        │       │              crossing · scene · pairwise            │
        └───────┼─────────────────────────────────────────────────────┘
                │
                ▼  ⭐ pure functions, recomputed on every read (ADR-0054)
        timeline ──▶ graph ──▶ reasoning ──▶ incident
```

### The three decisions that shaped the phase

⭐ **1. Behaviour is a perception plugin, not a new layer.** `register_task("behaviour", …)` was the
P-10 design being *tested* rather than described. Nothing in `perception.py`, the registry or the
pipeline widened to accommodate it. Had either needed to, the P-10 design would have been wrong and
that would have been the finding.

⭐ **2. Nothing derived is persisted.** Timeline, graph, primitives and reasoning are pure functions
over the movement paths ADR-0051 made durable. A corrected formula therefore *fixes history* rather
than being unable to reach it — which is how the slice-2.10 confidence-floor change could be verified
by re-reading old runs instead of re-analysing them.

⭐ **3. Configuration travels with the question.** Operator-drawn line geometry is not stored in the
runtime; it rides on the behaviour read from the assignment gate media already enforces. That is what
makes a crossing *recomputable*: a line drawn today applies to last week's analysis, and a corrected
line corrects history.

---

## 3. Capability matrix

| capability | implemented | unit | integration | browser | **on real footage** |
| --- | :--: | :--: | :--: | :--: | --- |
| Detection (person) | ✅ | ✅ | ✅ | ✅ | ⭐ 0.919 peak, 34/40 real photographs |
| Detection (carriable objects) | ✅ | ✅ | ✅ | ✅ | ⚠️ **9/30** — see § 8.2 |
| Tracking / identity | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| Zone membership | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| `dwell` / `idle` / `linger` | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| `proximity` / `follow` / `approach` / `recede` | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| `group_merge` / `group_split` / `queue` | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| `observation_gaps` (occlusion) | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| **`cross_line`** — entry, exit, direction, repeat | ✅ | ✅ | ✅ | ✅ | ⭐ **1 crossing at 12.0 s; 2 in opposite directions; live webcam** |
| **`carried`** | ✅ | ✅ | ✅ | ✅ | ⭐ **3 spans on real detections** |
| **`picked`** | ✅ | ✅ | ✅ | ✅ | ⭐ **3 events on real detections** |
| `dropped` | ✅ | ✅ | ✅ | ✅ | ⛔ **PENDING FOOTAGE** |
| `object_missing` / `object_returned` | ✅ | ✅ | ✅ | ✅ | ⛔ **PENDING FOOTAGE** |
| `handover` | ✅ | ✅ | ✅ | ✅ | ⛔ **PENDING FOOTAGE** |
| Behaviour graph | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| Reasoning engine + WHY chains | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| Investigation console (6 surfaces) | ✅ | ✅ | ✅ | ✅ | ⭐ verified |
| Evidence ↔ video synchronisation | ✅ | ✅ | ✅ | ✅ | ⭐ verified against `video.currentTime` |

⚠️ **"Implemented + unit-tested" is not the same claim as "verified on real footage", and the
columns are kept apart for that reason.** Every object primitive was implemented, unit-tested and
deployed for three milestones while never once executing on a real object — because unit tests author
their own objects. The rightmost column is the only one that can tell the difference.

---

## 4. Production readiness

| dimension | state | evidence |
| --- | --- | --- |
| Repository gate | ⭐ **70/70 green** | `pnpm turbo lint typecheck test`, 1 m 0 s |
| Contract verification | ⭐ green | 70 generated schemas + perception boundary **§A–§K** |
| Deployment | ⭐ verified | built images via `prod.sh`, not `pnpm dev` |
| Browser certification | ⭐ green | 8 spec files, 4 engines (chromium · firefox · webkit · edge) |
| Multi-tenancy | ⭐ enforced | tenant-scoped reads, fail-closed; `security.spec.ts` |
| Backward compatibility | ⭐ held | every contract change additive; absent fields mean today's behaviour |
| Explainability | ⭐ held | every incident carries a traceable WHY chain |
| **Evidence durability** | ⛔ **BLOCKED** | § 8.1 |

### Test inventory at `a8d5095`

| suite | tests |
| --- | ---: |
| Python runtime (`ai/inference`) | **1 491** |
| `@vip/console` | **630** (45 files) |
| `@vip/contracts` | **529** |
| `services/media` | **366** |
| `services/rules` | **315** |
| `services/camera` | **278** |
| `services/events` | **82** |
| E2E spine (`@vip/e2e`) | **45** |
| Browser (Playwright × 4 engines) | 8 spec files |

---

## 5. Performance summary

⭐ Measured on the deployed stack, 10-core host, CPU only, no GPU.

| path | measured |
| --- | ---: |
| Detector inference, `yolox-nano` 416×416 | **41.2 ms** avg · 49.4 ms p95 |
| Full frame path (preprocess + infer + decode) | **46.1 ms** → **21.7 fps** single stream |
| Behaviour read, scoped by `streamId`, direct to runtime | **90 ms** |
| 24 s clip at 4 fps analysis rate, end to end | **8 s** |
| Event spine, 1 000 events | **1 030/s** · avg 0.97 ms · p95 1.01 ms |
| Event spine, 10 000 events | 235/s · avg 4.26 ms · p95 17.2 ms |
| Runtime resident memory, steady | **390–400 MiB** |
| Line zone created → in force at the behaviour read | **3.2 s** |
| Line zone disabled → out of force | **6.3 s** |

⚠️ **The 10 000-event figure is a known non-linearity**, not a regression: throughput falls from
1 030/s to 235/s. It is recorded rather than smoothed, and it sits well above any measured live rate.

⚠️ **RT-DETR is registered and disabled.** 944 ms/frame on CPU — **22.9× slower** than yolox-nano, at
1.05 fps against a live path that needs 4 fps inside an 87 ms budget. It detects strictly more people
(33 vs 26 over the same 40 frames, never fewer in any frame) and is a GPU/offline candidate. This is
the single largest input to the Phase 3 plan.

---

## 6. Verification summary

⭐ **Fourteen defects were found by running the platform, and none of them by a unit test.** They are
listed because the pattern is the finding: every one was a *correct-looking silence*.

| slice | defect | why no test caught it |
| --- | --- | --- |
| 2.8 | `streamId` accepted at every layer and applied at none — a scoped read returned **5 014 records / 73 MB** for a run that produced 2 / 30 KB | every layer declared it; only the handler ignored it |
| 2.8 | "membership undecided" is an **absent** `zoneIds`, not a `zonesSettled: false` that does not exist on the wire | the console's fixture invented the field it was looking for |
| 2.8 | `proximity` and `gap` rendered "not parameterised" though both have thresholds | nothing compared the console's table to the runtime's |
| 2.8 | a capped timeline could not be un-capped by filtering — 1 207 of 2 000 entries were `gap` | the list looked complete |
| 2.9 | ⭐ **a tripwire drawn 0.05→0.95 caught nobody, and the code was right** — crossings anchor at the foot point, feet sit at y ≈ 0.95, the walk went round the end | correct geometry, invisible outcome |
| 2.9 | `lineId` was on the line **node** and not on the `crossed` **edge**, so every line-scoped rule matched 0 | 315 evaluator tests use hand-built graphs carrying the attribute the producer never wrote |
| 2.9 | a WHY chain printed the line id three times and the operator's name nowhere | nobody read one aloud |
| 2.10 | ⛔ **`minConfidence: 0.5`, chosen for `person`, applied to 80 classes — four of five carriable classes had zero detections admitted, ever** | unit tests author their own objects |
| 2.10 | a parked **car** sat in the association layer's input, one proximity from "this person carried a car" | it never got close enough, so nothing failed |
| 2.10 | ⛔ **a subject still in shot when a run ends is never made durable** | reads pass immediately and fail an hour later |

### Negative controls, which is what makes any of the above evidence

| control | result |
| --- | --- |
| the same run with no line geometry | `lineGeometry: absent`, 0 crossings, every other kind byte-identical |
| a rule naming the **opposite** direction | 0 candidates |
| a rule naming a line that does not exist | 0 candidates |
| the same footage with the floors reverted | 0 objects, 0 spans, 0 carried — and `person` **unchanged** |
| authored footage with nothing to carry | 0 spans **and a stated reason** |
| malformed line geometry | `invalid` — ⛔ never folded into `absent` |
| mutation: postprocessor ignores per-label floors | **5 of 12 tests fail** |
| mutation: rename one diagnostic reason | **boundary §K fails** |

⛔ **Four states, not three.** `present · none · absent · invalid` all render downstream as "no
crossings". Three are fine; one means the platform is quietly broken. The same discipline produced
the six-valued `associationDiagnostic.reason`.

---

## 7. Browser and deployment certification

| | |
| --- | --- |
| Engines | chromium · firefox · webkit · edge |
| Spec files | `journey` · `surface` · `security` · `performance` · `livecam` · `behaviour` · `crossline` · `association` |
| Against | `https://localhost` — **built images**, `./infra/docker/prod.sh`, never `pnpm dev` |
| Live path | Chromium fake device fed a **real walking clip**; 141 frames accepted; crossings named by the operator's own line name |
| Evidence sync | a click on any primitive seeks the video; verified against `video.currentTime` |

⚠️ **Two console specs failed on first run in all four engines, because the console image had not
been rebuilt.** The source was correct and the deployment was stale — the P-5.8 lesson arriving
again. It is recorded because it is the failure mode most likely to recur.

⚠️ **A crossing in front of a physical camera remains a manual UAT step.** The automated live
verification substitutes the lens, not the pipeline.

---

## 8. Known limitations and blockers

### 8.1 ⛔ BLOCKER — a subject still in shot when a run ends is never stored

| | |
| --- | --- |
| Symptom | the same run answers `carried: 3, picked: 3` at one minute and `observed: 2` at ten |
| Measured | across **three** separate runs, the person identity was never in durable track history |
| Write failure? | ⛔ **no** — `inference_track_history_write_failures_total 0`. Nothing failed; nothing was attempted |
| Rescued by a later run? | ⛔ no |
| Hypothesis | retirement runs on the frame path (`"no timer, no thread"`), and a stream that has stopped sending frames is exactly the one nothing drives |
| Impact | **evidence integrity** — an investigation opened an hour later shows fewer facts, and nothing says anything was lost |
| Irony | the subject present to the last frame is the one most likely to vanish |

⭐ It is fixable inside the frozen architecture: `retire_stream` already exists and is already called
on the camera-idle path. What is missing is something to drive it when frames stop. **This should be
slice 3.0 — before any Phase 3 perception work.**

### 8.2 ⚠️ The detector is the ceiling on object behaviour

9 of 30 photographs chosen for a carried object have it admitted at the calibrated floor.
`yolox-nano` is 3.66 MB and 0.91 M parameters; it is a person detector that happens to emit 80
classes. Every object primitive above `carried`/`picked` is starved by this, not by its own logic.

### 8.3 ⚠️ Other recorded limitations

- **Timeline and graph read with different entry ceilings** (2 000 vs 20 000). On a busy camera the
  graph legitimately holds facts a capped timeline did not return — measured live: 434 crossings in
  `countsByKind`, 216 in `entries`, 434 in the graph. Comparing the two lengths would report a
  correct platform as duplicating events.
- **An unfiltered `/api/track-history` read returns ~73 MB.** Scoped reads are 90 ms; the unscoped
  one is a footgun.
- **`lineGeometry: none` is only reachable for a camera media is enforcing.** A camera the assignment
  gate does not hold answers `absent`, correctly.
- **`path` and `direction` zone shapes remain storable and not evaluable.** `line` was promoted by an
  evaluator being written, not by a flag being flipped.
- **Event spine non-linearity** at 10 000 events (§ 5).
- **RT-DETR unusable on CPU** (§ 5).
- **The object corpus is 30 images and one detector.** The floors are a property of *this* deployment.
- **`handover`, `dropped`, `object_missing`, `object_returned` are PENDING FOOTAGE** — one 30–60 s
  recording of two people and one object closes all four.

---

## 9. Roadmap to Phase 3

| # | work | why it is in this order |
| --- | --- | --- |
| **3.0** | ⛔ **Fix the durability blocker (§ 8.1)** | Phase 3 multiplies the facts a run produces. Multiplying facts that are not durably stored multiplies the loss |
| 3.1 | Detector abstraction + benchmark lab | every later item is a model swap; the seam and the measuring instrument come first |
| 3.2 | YOLO11 migration behind that seam | the cheapest large gain: better small-object recall lifts § 8.2 directly |
| 3.3 | RT-DETR on GPU / offline batch | already registered and disabled; the plan is a deployment target, not an integration |
| 3.4 | Re-identification | the prerequisite for anything spanning cameras or re-entry |
| 3.5 | Pose · segmentation · object permanence | pose makes hand–object interaction possible; permanence lifts `object_missing` off `observation_gaps` |
| 3.6 | Open-vocabulary (Grounding DINO / Florence-2), SAM2 | removes the 80-class ceiling entirely |
| 3.7 | Shelf interaction · checkout correlation · retail reasoning | the first genuinely retail-specific layer, and it is last on purpose |

⚠️ **One acquisition task blocks nothing and unblocks four capabilities:** a single 30–60 s recording
of two people and one carried object. It costs a phone and five minutes, and it closes every
PENDING FOOTAGE row in § 3.

The design is in [PROFESSIONAL_PERCEPTION_ARCHITECTURE.md](PROFESSIONAL_PERCEPTION_ARCHITECTURE.md).
⛔ **No Phase 3 implementation has begun.**

---

## 10. Standing guarantees, re-asserted at close

| | |
| --- | --- |
| One production pipeline | ⭐ held — `perception-boundary.mjs` **§A** proves the runtime has exactly one caller |
| No duplicate logic | ⭐ held — the console computes nothing; every number comes from a read |
| No demo implementations | ⭐ held |
| Every incident explainable | ⭐ held — WHY chains, clickable and traceable |
| Backward compatibility | ⭐ held — every contract change additive |
| Gate green throughout | ⭐ held — 70/70 at every slice commit |
| Each slice committed independently | ⭐ held — `bab97e8 · e6885a0 · 4caacfc · c83697e · 4e1630a · a8d5095` |
| Simulation never certifies | ⭐ held — and where footage was missing, the report says PENDING FOOTAGE |
