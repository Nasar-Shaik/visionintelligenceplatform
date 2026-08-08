# CCTV Benchmark Dataset

**Status: DESIGN ONLY.** The dataset does not exist. The *machinery* to hold it does
(`ai/inference/dataset.py`, `ai/datasets/`), and this document specifies what must go into it.

> ⛔ **Every future AI model must be evaluated against this dataset before adoption**
> ([MODEL_EVALUATION_PLAN.md](MODEL_EVALUATION_PLAN.md)). A permanent benchmark is only permanent if
> it is frozen, versioned, and never quietly extended to make a failing model pass.

---

## 1. Why the current fixtures are not this dataset

The repository ships 37 validation clips with ground truth
(`infra/docker/fixtures/media/validation/manifest.json`). They are genuinely useful and they are
**not** a CCTV benchmark:

| | Fixture library | What a benchmark needs |
| --- | --- | --- |
| Content | real people **composited** over backgrounds (`person-1.png`, `person-2.png` from one CC0 photo) | real footage from real installed cameras |
| Optics | ffmpeg-clean | lens distortion, IR cut-over, auto-exposure hunting, compression artefacts, condensation |
| Ground truth | written by the same team that authored the clip | annotated independently of whoever built the pipeline |
| Diversity | two people, both from one photograph | many people, many builds, many clothing types, many demographics |
| Failure realism | filters approximate degradation | ⛔ a gamma curve is not a dark room — real low light adds gain noise, motion blur and colour cast |

⭐ **The fixtures remain valuable as a regression suite.** They are deterministic, small, licensable
and in the repository. They answer "did this change break something?" They cannot answer "does this
work on CCTV?" — and conflating the two is the mistake this document exists to prevent.

---

## 2. Composition

Target ≥ 400 clips, 20–120 s each, ≥ 12 distinct physical sites.

### 2.1 Viewpoint (the axis that matters most, and the one models are worst at)

| Category | Clips | Note |
| --- | --- | --- |
| Front view, eye level | 30 | closest to the training distribution of most public models |
| Side / oblique | 30 | |
| **Top-down CCTV** (60–90° depression) | **60** | ⛔ over-weighted deliberately. The dominant real CCTV geometry and the one where COCO-trained detectors degrade hardest — a person from directly above is a shape the model has barely seen. |
| Wide-angle / fisheye | 30 | corner distortion; a person at the edge is not the same shape as one in the middle |
| Far field (subject < 8 % of frame height) | 30 | |

### 2.2 Environment

| Category | Clips |
| --- | --- |
| Retail shelves / aisle | 40 |
| Checkout / POS | 30 |
| Entrance / doorway | 30 |
| Warehouse | 30 |
| Office / corridor | 30 |
| Car park / outdoor | 20 |

### 2.3 Conditions

| Category | Clips | Note |
| --- | --- | --- |
| Bright / daylight | 30 | |
| Low light / night / IR | 40 | ⚠️ IR is monochrome — a colour-dependent model behaves differently, and it is half the day |
| Backlight / doorway glare | 25 | |
| Mixed / changing light | 20 | |
| Occlusion (fixture, shelf, person) | 40 | |
| Crowd (≥ 6 simultaneous) | 30 | |
| **Empty scene** | **40** | ⭐ negative controls. A model's false-positive rate is measured here and nowhere else. |

### 2.4 Capture parameters

| Axis | Values |
| --- | --- |
| Resolution | 320×180, 640×360, 1280×720, 1920×1080, 2560×1440 |
| Orientation | landscape **and portrait** (corridor-mount cameras are portrait) |
| Codec | H.264, H.265 (`hvc1` **and** `hev1` — see TD-29), MJPEG |
| Frame rate | 1, 5, 12, 15, 25, 30 fps |
| Bitrate | including a deliberately starved tier — real estates run cameras at bitrates that visibly hurt |

⚠️ Resolution and codec belong here rather than in a transport suite because they change **accuracy**,
not only playback. A 320×180 person is fewer pixels than the detector's stride.

---

## 3. Annotation

| Level | Required for | Content |
| --- | --- | --- |
| **L0 — scenario** | every clip | what happens, when, in words |
| **L1 — presence** | every clip | per second: how many people are present |
| **L2 — boxes** | ≥ 150 clips | per frame (or every Nth), person boxes |
| **L3 — identity** | ≥ 80 clips | stable person id across occlusion and re-entry — the only thing that can score identity switches |
| **L4 — behaviour** | ≥ 60 clips | dwell spans, zone entry/exit, interaction moments |

⛔ **Annotation must be independent of the pipeline.** Bootstrapping labels from the current model's
output and correcting them produces a corpus biased toward that model's failure modes: the errors it
makes consistently get corrected consistently, and the errors it makes *silently* get baked in as
truth. Label from raw footage.

⭐ **Every clip carries at least one negative assertion** — a thing that must **not** be reported.
`evaluation.py` already scores absence as directly as presence; the corpus must give it something to
score.

---

## 4. Provenance, licence and consent

⛔ **This is the part that stops the project if it is left late.** Surveillance footage of identifiable
people is exactly the category of data that must not be casually acquired, and
`ai/datasets/README.md` already states the storage rule: footage bytes live in DVC/object storage and
are **never committed to git**.

Every clip records:

| Field | Why |
| --- | --- |
| Source | who filmed it, where, when |
| Legal basis | consent, licence, or synthetic |
| Consent scope | ⚠️ "may be used to evaluate models" is narrower than "may be redistributed". Both must be recorded, because a corpus that cannot be shared with a customer's auditor is a corpus that cannot support a claim to them. |
| Retention | when it must be deleted |
| Redaction | faces blurred? — ⛔ note that blurring **changes detection accuracy**, so a redacted corpus measures a different thing |
| Jurisdiction | GDPR/CCTV codes differ; the corpus travels |

**Acquisition routes, in order of preference:**

1. **Consented capture at partner sites** — real optics, real geometry, clean legal basis. Slowest, best.
2. **Licensed public CCTV research datasets** — ⚠️ many forbid commercial use; each licence read individually.
3. **Staged capture with paid, consented participants** on real installed cameras — controllable, covers rare events (theft, falls) that cannot be waited for, real optics.
4. **Synthetic / rendered** — ⛔ **regression only, never accuracy claims.** Recorded as `kind: synthetic` and excluded from headline metrics.

---

## 5. Freezing and versioning

- Versioned `cctv-core-v1`, `v2`… Content is **append-only within a version**; a clip is never edited
  or removed once frozen.
- Each version records a **frame-sequence hash** per clip
  ([BENCHMARK_FRAMEWORK.md](BENCHMARK_FRAMEWORK.md) §2) so two evaluations can be proved to have seen
  the same pixels.
- A **held-out split** (~20 %) is never used for tuning. ⚠️ Without it, the corpus becomes the
  training target and every later number is optimistic.
- ⛔ **A model is never evaluated against a version created after it was proposed.** Extending the
  corpus until a candidate passes is the failure mode; the rule makes it visible.

---

## 6. Reporting

Results are always published per category, never only in aggregate — an aggregate over a corpus
whose composition is a design choice is a weighted average of that choice.

⚠️ Every report states **coverage**: which categories have fewer clips than target, and therefore
which conclusions the corpus cannot yet support. `footage-missing` is its own status in
`dataset.py` and is **never** a pass, for exactly this reason.

---

## 7. Related

- [MODEL_EVALUATION_PLAN.md](MODEL_EVALUATION_PLAN.md) — the process this feeds
- [BENCHMARK_FRAMEWORK.md](BENCHMARK_FRAMEWORK.md) — how two models are compared over it
- [AI_ROADMAP.md](AI_ROADMAP.md) — AI-6 is acquiring this
- `ai/datasets/README.md` — the storage and DVC rules already in force
