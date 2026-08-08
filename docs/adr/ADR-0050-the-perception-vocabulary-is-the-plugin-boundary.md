# ADR-0050 · The perception vocabulary is the plugin boundary

- **Status:** Accepted
- **Date:** 2026-08-08
- **Milestone:** P-10 Professional Perception Foundation
- **Supersedes / relates to:** [ADR-0002](ADR-0002-model-agnostic-inference.md) (model-agnostic inference), [ADR-0049](ADR-0049-per-frame-perception-data-is-not-persisted.md)

## Context

### The freeze is deliberately lifted, and that is recorded here rather than assumed

**AI Runtime Architecture v1.0 was formally accepted and CLOSED on 2026-08-01** at the AI-5e
acceptance review. The standing guardrail has been "no new architectural layers, no new pipeline
stages"; the runtime was to evolve only through better models, performance, hardware and benchmarks.

On **2026-08-08** the Principal Architect reopened it explicitly and in writing: *"The platform
engineering phase is considered complete… The next objective is to build the Professional Perception
Foundation that will support every future AI capability."* ⚠️ This ADR exists so that a future reader
finds a **decision** at the point where a freeze was lifted, rather than discovering that a document
saying "frozen" quietly stopped being true. The freeze held for seven days short of a month and was
lifted by the person who imposed it.

### What was actually missing

The runtime has been model-agnostic since P2-2, and not merely in claim — three real plugin points,
all exercised:

| Seam | Maps | Where |
| --- | --- | --- |
| `EngineRegistry` | engine name → adapter factory | `engines.py` |
| `ModelAdapter` | the only interface to a backend | `pipeline.py` |
| `register_decoder()` | output layout → decoder function | `adapters/model_formats.py` |

⛔ **All three terminate in `List[RawDetection]`, and `RawDetection` is four slots:** `bbox`,
`score`, `class_id`, `label`. So the architecture could swap one detector for another and nothing
else. A pose model has nowhere to put a skeleton; segmentation has nowhere to put a mask;
re-identification has nowhere to put an embedding; OCR has nowhere to put text; a vision-language
model has nothing to describe, because every output had to be a rectangle with a class.

**The plugin architecture was real. The vocabulary was the constraint.** That is a materially
different diagnosis from "VIP needs a plugin architecture", and it changes the size of the work from
a rebuild to an addition.

## Decision

**1. A perception module returns a `PerceptionOutput`, not a list of boxes.** `perception.py`
defines an open task vocabulary (`register_task`), per-instance records whose every field beyond
`score` is optional, and **frame-level labels that have no box at all** — because "a person fell",
"the queue is six long" and "this is a checkout area" are outputs no per-object record can hold, and
all three are on the roadmap.

**2. Rich modalities travel inside the frozen `Detection.attributes` map.** Pose goes to
`attributes["pose"]`, masks to `attributes["mask"]`, text to `attributes["text"]`. Embeddings use the
existing frozen `Detection.embedding` field.

⭐ **Consequence: none of the five frozen platform contracts change.** No new top-level field, no
schema version bump, and `tools/contracts/perception-boundary.mjs` §D — "every field a consumer reads
must exist in the frozen schema" — stays satisfied without modification.

**3. The task vocabulary is a registry, not an enum.** `CANONICAL_ENGINES` is a closed tuple, which
is why adding an engine name today means editing a constant that every capability imports. A task
nobody has thought of must be registrable by the plugin that brings it.

**4. Registering a module name twice raises.** `EngineRegistry` silently overwrites; two plugins
claiming `"yolo11"` is a packaging bug whose failure mode — whichever imported last wins — is
invisible in every benchmark that follows.

**5. The existing detector is not modified.** `adapt_model_adapter()` lifts any `ModelAdapter` into a
`PerceptionModule`. The shipped `yolox-nano` path reaches the new registry through the seam it has
always implemented, and a test asserts its output is unchanged.

## Consequences

**Good.** Pose, segmentation, re-id, OCR, action, temporal and vision-language modules can now be
written against a stable interface without a further architectural change — which is the entire
success criterion of this milestone. Backward compatibility is a test, not an intention.

⚠️ **The cost, stated plainly: attributes are untyped at the contract boundary**, so the *names*
inside them become the real interface. They are declared once as `ATTR_*` constants in
`perception.py`; a module that spells `"keypoints"` inline has forked the contract in a way no test
will catch. When a modality earns first-class status — pose almost certainly will, once a rule needs
to reason about posture — it is promoted to a real field additively, and `perception.py` is the single
place that mapping lives.

⚠️ **`to_raw_detections()` is lossy and says so.** Narrowing back to the existing post-processing
stage drops keypoints, masks and text (they survive on the `Detection` afterwards) and **discards any
instance without a box entirely** — a caption is not a detection, and a box at the origin would read
as a real observation of the top-left corner.

⛔ **What this ADR does not license.** No perception *model* is added by it. No theft detection, no
pose inference, no segmentation inference, no action recognition. The runtime remains
perception-only, still emits `EventEnvelope` and still creates no incidents. The guardrails other
than the v1.0 structural freeze are untouched and were held in full.
