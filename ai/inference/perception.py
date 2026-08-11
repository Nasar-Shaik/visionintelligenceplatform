"""The perception output contract (P-10) — what a model is allowed to *say*.

⭐ **This is the one seam the platform was missing, and it is not a new pipeline stage.** The runtime
has been model-agnostic since P2-2: `EngineRegistry` maps an engine name to an adapter factory,
`ModelAdapter` is the only interface to a backend, and `register_decoder()` maps an output layout to
a decoder. Three plugin points, all real, all exercised.

But every one of them terminates in `List[RawDetection]`, and a `RawDetection` is four slots —
`bbox`, `score`, `class_id`, `label`. ⛔ **So the architecture could swap detectors and nothing
else.** A pose model has nowhere to put a skeleton. A segmentation model has nowhere to put a mask.
Re-identification has nowhere to put an embedding, OCR has nowhere to put text, and a
vision-language model has nothing to describe at all, because every output had to be a box with a
class. The plugin architecture was real and the *vocabulary* was the constraint.

This module widens the vocabulary without widening the pipeline:

    FrameContext → [preprocess] → [infer] → [postprocess] → [track] → [translate] → DetectionResult
                                     │
                                     └── PerceptionOutput ── instances (box? mask? skeleton?
                                                          │              embedding? text?)
                                                          └── frame labels (action, caption, scene)

### ⭐ The five frozen platform contracts do not change

`Detection` already carries `attributes: Dict[str, object]` and `embedding`, both frozen, both
serialised, both additive-safe. So a skeleton travels to the platform inside `attributes["pose"]`
and a mask inside `attributes["mask"]` — no new top-level field, no schema version bump, and
`tools/contracts/perception-boundary.mjs` §D stays satisfied because no consumer reads a field that
does not exist in the frozen schema.

⚠️ **That is a deliberate trade, not a free win.** Attributes are untyped at the contract boundary,
so the *names* inside them become the real interface. They are declared once here as
`ATTR_*` constants and nowhere else; a module that spells `"keypoints"` inline has forked the
contract silently. When a modality earns first-class status — pose almost certainly will, once a
rule engine needs to reason about posture — it is promoted to a real field additively, and this
module is the single place that mapping lives.

### Conventions, stated because two conventions is a silent defect

- **Coordinates are normalized `[0,1]`**, origin top-left, exactly like `Detection.bbox`
  (`[x, y, w, h]`). Keypoints and mask geometry follow the same rule. A model that emits pixels
  converts in its decoder, where the frame's dimensions are known — never above it.
- **`bbox` is optional.** A frame-level caption has no box, an action spanning three seconds has no
  box, and a scene classification has no box. ⭐ This is what makes the contract more than a wider
  detection: it can express a statement about the *frame*, not only about a rectangle in it.
- **Masks are run-length encoded strings, never arrays.** This module is stdlib-only, and it stays
  importable by the dependency-free stub path that the unit tests and the `stub` backend use. A
  numpy array in the contract would drag the whole numeric stack into every import of it.

Stdlib-only. Deterministic. No I/O.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

# --- the task vocabulary -------------------------------------------------------------------------

#: The ten perception tasks the foundation is designed to carry.
#:
#: ⚠️ **Deliberately plain strings behind a mutable registry, not an `Enum`.** An enum is a closed
#: set, and a closed set is exactly the rigidity this milestone exists to remove — `CANONICAL_ENGINES`
#: in `engines.py` is a closed tuple, which is why adding an engine name today means editing a
#: constant in a module every capability imports. A task nobody has thought of yet must be
#: registrable by the plugin that brings it, without a change here.
TASK_DETECTION = "detection"
TASK_POSE = "pose"
TASK_SEGMENTATION = "segmentation"
TASK_TRACKING = "tracking"
TASK_REID = "reid"
TASK_OCR = "ocr"
TASK_ACTION = "action"
TASK_TEMPORAL = "temporal"
TASK_VISION_LANGUAGE = "vision-language"
TASK_DEPTH = "depth"

_KNOWN_TASKS: Dict[str, str] = {
    TASK_DETECTION: "Objects present in a frame, as boxes with classes",
    TASK_POSE: "Body keypoints and orientation per person",
    TASK_SEGMENTATION: "Per-instance pixel masks",
    TASK_TRACKING: "Identity of an object across frames",
    TASK_REID: "An appearance embedding that survives a camera change",
    TASK_OCR: "Text read out of a region",
    TASK_ACTION: "What a subject is doing, over a span of frames",
    TASK_TEMPORAL: "A statement about a window of time rather than a frame",
    TASK_VISION_LANGUAGE: "Open-vocabulary description or grounding",
    TASK_DEPTH: "Distance from the camera, per pixel or per instance",
}


class UnknownTask(ValueError):
    """A task nobody registered. Fail closed: a typo must never silently create a new task."""


def register_task(task: str, description: str) -> None:
    """Declare a perception task. Idempotent for an identical description.

    ⭐ The extension point that makes "Future Perception Modules" a configuration change rather than
    an architectural one. A plugin bringing gaze estimation registers `"gaze"` at import time and
    every registry, benchmark and report below handles it without modification.
    """
    if not isinstance(task, str) or task.strip() == "":
        raise ValueError("task must be a non-empty string")
    existing = _KNOWN_TASKS.get(task)
    if existing is not None and existing != description:
        raise ValueError(f"task '{task}' is already registered with a different description")
    _KNOWN_TASKS[task] = description


def known_tasks() -> List[str]:
    return sorted(_KNOWN_TASKS)


def describe_task(task: str) -> str:
    description = _KNOWN_TASKS.get(task)
    if description is None:
        raise UnknownTask(f"unknown perception task '{task}' (known: {', '.join(known_tasks())})")
    return description


# --- skeleton topologies -------------------------------------------------------------------------

#: The joints of `skeleton="coco-17"`, in the order the convention numbers them.
#:
#: ⭐ **Declared once, here, because `skeleton` is a property of the *convention* rather than of any
#: one producer.** A pose decoder and a human annotator must agree on the spelling of a joint or
#: their outputs cannot be compared at all — and "left_wrist" versus "leftWrist" is exactly the kind
#: of disagreement that surfaces as a plausible, terrible accuracy score rather than as an error.
#:
#: ⚠️ There is no `hand` joint. COCO annotates the **wrist**, and a model trained on it cannot report
#: something the labels never contained.
COCO_17: Tuple[str, ...] = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)

#: Every topology this platform recognises, by the name that travels in `RawInstance.skeleton`.
SKELETONS: Mapping[str, Tuple[str, ...]] = {"coco-17": COCO_17}

DEFAULT_SKELETON = "coco-17"


# --- reserved attribute names --------------------------------------------------------------------

#: Where each modality rides inside the frozen `Detection.attributes` map. ⚠️ Declared once; a module
#: that spells one of these inline has forked the contract in a way no test will notice.
ATTR_POSE = "pose"
ATTR_MASK = "mask"
ATTR_TEXT = "text"
ATTR_ACTION = "action"
ATTR_TASK = "perceptionTask"


# --- value objects -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Keypoint:
    """One labelled joint. Coordinates normalized `[0,1]`, like every other coordinate here.

    ⚠️ `confidence` and `visible` answer different questions and are both needed. A joint the model
    is sure is *hidden* (occluded by a shelf) is high-confidence and not visible; a joint it merely
    guessed at is low-confidence. Collapsing them loses the distinction that occlusion reasoning —
    and therefore shelf-interaction detection — is built on.
    """

    name: str
    x: float
    y: float
    confidence: float = 1.0
    visible: bool = True

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "x": round(float(self.x), 6),
            "y": round(float(self.y), 6),
            "confidence": round(float(self.confidence), 6),
            "visible": bool(self.visible),
        }


@dataclass(frozen=True)
class Mask:
    """An instance mask as run-length encoding over a `width × height` grid.

    ⚠️ Carries its own dimensions because the grid is usually *not* the frame's resolution — masks
    are commonly emitted at the model's input size or a fixed 160×160 prototype grid. A mask without
    its dimensions is uninterpretable, and the failure is silent: it renders, just in the wrong place.
    """

    encoding: str
    data: str
    width: int
    height: int

    def to_dict(self) -> dict:
        return {
            "encoding": self.encoding,
            "data": self.data,
            "width": int(self.width),
            "height": int(self.height),
        }


@dataclass(frozen=True)
class TextSpan:
    """Text read from a region, with the confidence of that reading."""

    text: str
    confidence: float = 1.0
    bbox: Optional[Tuple[float, float, float, float]] = None

    def to_dict(self) -> dict:
        out: dict = {"text": self.text, "confidence": round(float(self.confidence), 6)}
        if self.bbox is not None:
            out["bbox"] = [round(float(v), 6) for v in self.bbox]
        return out


# --- the outputs ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class RawInstance:
    """One thing a model has to say about a region — or about nothing in particular.

    Every field beyond `score` is optional, and that is the point: a detector fills `bbox` and
    `class_id`, a pose model adds `keypoints`, a segmentation model adds `mask`, a re-identification
    model fills only `embedding`, and an OCR model fills only `text`. ⭐ **No module knows which of
    its peers filled which field**, which is the requirement that "no module should know about
    another module's implementation" reduces to in practice.
    """

    score: float
    bbox: Optional[Tuple[float, float, float, float]] = None
    class_id: Optional[int] = None
    label: Optional[str] = None
    keypoints: Sequence[Keypoint] = ()
    #: The topology the keypoints belong to, e.g. `"coco-17"`. ⭐ Named once per instance rather than
    #: repeating an edge list on every one: the edges are a property of the *convention*, and two
    #: instances in a frame cannot disagree about it.
    skeleton: Optional[str] = None
    mask: Optional[Mask] = None
    embedding: Optional[Sequence[float]] = None
    text: Sequence[TextSpan] = ()
    attributes: Mapping[str, object] = field(default_factory=dict)

    def to_attributes(self) -> Dict[str, object]:
        """The modality payload as it travels inside the frozen `Detection.attributes`.

        Returns only what this instance actually carries — an empty dict for a plain detection, so
        the existing detector's output is byte-identical to what it produced before this module
        existed.
        """
        out: Dict[str, object] = dict(self.attributes)
        if self.keypoints:
            pose: Dict[str, object] = {"keypoints": [k.to_dict() for k in self.keypoints]}
            if self.skeleton is not None:
                pose["skeleton"] = self.skeleton
            out[ATTR_POSE] = pose
        if self.mask is not None:
            out[ATTR_MASK] = self.mask.to_dict()
        if self.text:
            out[ATTR_TEXT] = [t.to_dict() for t in self.text]
        return out


@dataclass(frozen=True)
class FrameLabel:
    """A statement about the whole frame, or a span of them — not about a rectangle.

    ⛔ **The reason `PerceptionOutput` is not just `List[RawInstance]`.** "The queue is six people
    long", "this is a checkout area", "a person fell" are all outputs no per-object record can hold,
    and every one of them is on the roadmap. A contract that cannot express them forces the first
    such model to invent a side-channel.
    """

    label: str
    confidence: float = 1.0
    #: Frame numbers this label spans, inclusive. `None` means "this frame only".
    span: Optional[Tuple[int, int]] = None
    attributes: Mapping[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict:
        out: dict = {
            "label": self.label,
            "confidence": round(float(self.confidence), 6),
            "attributes": dict(self.attributes),
        }
        if self.span is not None:
            out["span"] = [int(self.span[0]), int(self.span[1])]
        return out

    def to_scene_observation(self) -> dict:
        """The wire form for `DetectionResult.scene` (ADR-0054).

        ⚠️ `label` becomes `kind`, and the rename is the point rather than a slip. Inside the runtime
        this *labels a frame*, alongside the labels a model puts on boxes; on the wire it *observes a
        scene*, and a consumer holding a document with `label` at two nesting depths meaning two
        different things would have to learn which is which. One shape, spelled once, here — the
        alternative is each producer inventing its own mapping.
        """
        out: dict = {
            "kind": self.label,
            "confidence": round(float(self.confidence), 6),
            "attributes": dict(self.attributes),
        }
        if self.span is not None:
            out["span"] = [int(self.span[0]), int(self.span[1])]
        return out


@dataclass(frozen=True)
class PerceptionOutput:
    """Everything one model said about one frame, for one task."""

    task: str
    instances: Sequence[RawInstance] = ()
    frame_labels: Sequence[FrameLabel] = ()
    attributes: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        describe_task(self.task)  # fail closed on an unregistered task

    def to_dict(self) -> dict:
        return {
            "task": self.task,
            "instances": [
                {
                    "score": round(float(i.score), 6),
                    **({"bbox": [round(float(v), 6) for v in i.bbox]} if i.bbox is not None else {}),
                    **({"classId": int(i.class_id)} if i.class_id is not None else {}),
                    **({"label": i.label} if i.label is not None else {}),
                    **({"embedding": [float(v) for v in i.embedding]} if i.embedding is not None else {}),
                    "attributes": i.to_attributes(),
                }
                for i in self.instances
            ],
            "frameLabels": [f.to_dict() for f in self.frame_labels],
            "attributes": dict(self.attributes),
        }


# --- bridges to the existing pipeline -------------------------------------------------------------


def from_raw_detections(raws: Sequence[object]) -> PerceptionOutput:
    """Lift the shipped detector's `List[RawDetection]` into a `PerceptionOutput`.

    ⭐ **The backward-compatibility guarantee, in one function.** Every existing adapter — the ONNX
    path, the fake adapter, every registered decoder — keeps returning `RawDetection` and keeps
    working unchanged. Nothing has to be rewritten to adopt this contract; a plugin that wants the
    wider vocabulary opts in by returning `PerceptionOutput` instead.

    Duck-typed on purpose: importing `pipeline.RawDetection` here would make this module depend on
    the stage definitions that depend on the contracts, and the cycle buys nothing.
    """
    instances = [
        RawInstance(
            score=float(getattr(r, "score")),
            bbox=tuple(getattr(r, "bbox")),  # type: ignore[arg-type]
            class_id=getattr(r, "class_id", None),
            label=getattr(r, "label", None),
        )
        for r in raws
    ]
    return PerceptionOutput(task=TASK_DETECTION, instances=instances)


def to_raw_detections(output: PerceptionOutput, factory: object) -> List[object]:
    """Narrow a `PerceptionOutput` back to `RawDetection`s for the existing post-processing stage.

    ⚠️ **Lossy, and loudly so.** Keypoints, masks, text and frame labels have nowhere to go in a
    four-slot record; they survive only because `to_attributes()` puts them on the `Detection` after
    post-processing. An instance with no `bbox` is dropped entirely — it is not a detection and
    pretending otherwise would put a box at the origin, which reads as a real observation.

    `factory` is the `RawDetection` class, injected rather than imported for the reason above.
    """
    out: List[object] = []
    for instance in output.instances:
        if instance.bbox is None:
            continue
        out.append(
            factory(  # type: ignore[operator]
                bbox=instance.bbox,
                score=instance.score,
                class_id=instance.class_id,
                label=instance.label,
            )
        )
    return out
