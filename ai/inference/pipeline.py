"""The runtime pipeline (#8) as small, replaceable stages — never one monolithic detector:

    FrameContext → [preprocess] → [infer] → [postprocess] → [track] → [translate] → DetectionResult

Pre-processing + inference are backend-specific and live behind the `ModelAdapter` seam (#2) so the
runtime never imports onnxruntime directly. Post-processing, tracking, and translation are GENERIC
(model-independent) and shared across backends. Each stage is a Protocol with a stdlib default, so a
capability can swap any one (e.g. a real tracker) without touching the others. Event publishing is
the final stage, wired in P1-5; here it is a no-op sink seam.

Prefer interfaces over inheritance: stages are duck-typed Protocols, injected into the capability.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime
from typing import Any, List, Optional, Protocol, Sequence, Tuple

from contracts import Detection, DetectionResult, FrameContext, ModelBinding, detection_id


class RawDetection:
    """Backend-neutral raw output of the inference stage (before generic post-processing)."""

    __slots__ = ("bbox", "score", "class_id", "label")

    def __init__(
        self,
        bbox: Tuple[float, float, float, float],
        score: float,
        class_id: Optional[int] = None,
        label: Optional[str] = None,
    ) -> None:
        self.bbox = bbox
        self.score = score
        self.class_id = class_id
        self.label = label


# --- backend seam (#2): preprocessing + inference are the only model-specific stages -------------


class ModelAdapter(Protocol):
    """The ONLY interface the runtime uses to talk to a model backend (ONNX/TensorRT/OpenVINO/…).
    `preprocess` and `infer` are separate methods so either can be replaced independently (#8)."""

    execution_provider: str

    def load(self, ref: dict) -> None: ...

    def preprocess(self, ctx: FrameContext) -> Any: ...

    def infer(self, prepared: Any) -> List[RawDetection]: ...

    def unload(self) -> None: ...


# --- generic, model-independent stages -----------------------------------------------------------


class Postprocessor(Protocol):
    def run(self, raw: Sequence[RawDetection], ctx: FrameContext, min_confidence: float) -> List[Detection]: ...


class Tracker(Protocol):
    def run(self, detections: List[Detection], ctx: FrameContext) -> List[Detection]: ...


class StageChain:
    """Several `Tracker`-shaped stages in the one slot the pipeline already has (P-11 slice 2.2).

    ⭐ **This is how a stage is added without adding a stage.** `Tracker` is a structural Protocol —
    detections in, detections out — so anything with that shape composes into the same position.
    `CapabilityRuntime` still sees exactly one tracker, the frozen runtime architecture gains no
    layer, and the standing guardrail *"no new pipeline stages"* is held literally.

    ⚠️ Order is the caller's and it matters: a stage that reads identity must run after the one that
    assigns it. The chain does not reorder, retry, or swallow — a stage that raises fails the frame,
    because a pipeline that silently continued past a broken stage would report a clean run.
    """

    def __init__(self, *stages: Tracker) -> None:
        self._stages = [s for s in stages if s is not None]

    @property
    def stages(self) -> List[Tracker]:
        return list(self._stages)

    def run(self, detections: List[Detection], ctx: FrameContext) -> List[Detection]:
        for stage in self._stages:
            detections = stage.run(detections, ctx)
        return detections

    def find(self, attribute: str):  # noqa: ANN201 - returns the first stage exposing `attribute`
        """The first stage carrying a named attribute, or `None`.

        ⚠️ Used by the composition root to reach a stage's own reads (tracking stats, behaviour
        stats) without the chain having to know what kinds of stage exist.
        """
        for stage in self._stages:
            if hasattr(stage, attribute):
                return stage
        return None


class ResultTranslator(Protocol):
    def run(
        self,
        detections: List[Detection],
        ctx: FrameContext,
        model: ModelBinding,
        *,
        capability_id: str,
        capability_version: str,
        runtime_version: str,
        execution_provider: str,
        inference_ms: float,
        at: str,
        preprocessing_version: Optional[str] = None,
        confidence_threshold: Optional[float] = None,
    ) -> DetectionResult: ...


class ConfidencePostprocessor:
    """Default post-processing: normalize raw outputs to `Detection`, dropping sub-threshold scores
    and mapping class ids to labels. No model/vendor specifics."""

    def __init__(self, labels: Optional[Sequence[str]] = None) -> None:
        self._labels = list(labels) if labels else []

    def run(self, raw: Sequence[RawDetection], ctx: FrameContext, min_confidence: float) -> List[Detection]:
        out: List[Detection] = []
        for r in raw:
            if r.score < min_confidence:
                continue
            label = r.label
            if label is None and r.class_id is not None and 0 <= r.class_id < len(self._labels):
                label = self._labels[r.class_id]
            out.append(
                Detection(
                    label=label or (str(r.class_id) if r.class_id is not None else "object"),
                    confidence=float(r.score),
                    bbox=r.bbox,
                    class_id=r.class_id,
                )
            )
        return out


class NoopTracker:
    """Default tracker: assigns no ids (single-frame Phase 1). A real re-ID/tracker plugs in here."""

    def run(self, detections: List[Detection], ctx: FrameContext) -> List[Detection]:
        return detections


class DefaultResultTranslator:
    """Assemble the tenant-tagged, fully version-stamped DetectionResult.

    Also the one place a detection acquires its **identity** and the result acquires its **frame
    latency** (P-8 Phase 3) — both derived from the frame that is already in hand, so no stage below
    has to carry a clock or an id generator.
    """

    def run(
        self,
        detections: List[Detection],
        ctx: FrameContext,
        model: ModelBinding,
        *,
        capability_id: str,
        capability_version: str,
        runtime_version: str,
        execution_provider: str,
        inference_ms: float,
        at: str,
        preprocessing_version: Optional[str] = None,
        confidence_threshold: Optional[float] = None,
    ) -> DetectionResult:
        captured_at = ctx.timestamp or at
        model_key = model.id or model.name
        identified = [
            _with_id(detection, ctx, captured_at, model_key, index)
            for index, detection in enumerate(detections)
        ]
        return DetectionResult(
            tenant_id=ctx.tenant_id,
            camera_id=ctx.camera_id,
            capability_id=capability_id,
            capability_version=capability_version,
            runtime_version=runtime_version,
            execution_provider=execution_provider,
            model=model,
            frame_seq=ctx.frame_number,
            frame_captured_at=captured_at,
            inference_ms=inference_ms,
            at=at,
            detections=identified,
            # ⭐ The frame-level statements a stage appended on the way past (ADR-0054). Read off the
            # context rather than passed as an argument: `ResultTranslator` is a Protocol with three
            # implementations, and widening its signature would have made a carrier out of a stage
            # boundary. The context already reaches everything.
            scene=list(ctx.scene),
            correlation_id=ctx.correlation_id,
            frame_latency_ms=frame_latency_ms(captured_at, at),
            preprocessing_version=preprocessing_version,
            confidence_threshold=confidence_threshold,
        )


def _with_id(
    detection: Detection, ctx: FrameContext, captured_at: str, model: str, index: int
) -> Detection:
    if detection.detection_id is not None:
        return detection
    return replace(
        detection,
        detection_id=detection_id(
            ctx.tenant_id, ctx.camera_id, captured_at, ctx.frame_number, model, index
        ),
    )


def frame_latency_ms(captured_at: str, at: str) -> Optional[float]:
    """Capture → result, in milliseconds, or `None` when it cannot be measured.

    ⚠️ Returns `None` — never `0` — for an unparseable timestamp or a **negative** interval. A
    negative one means the two clocks disagree, and reporting that as "0 ms, instant" would turn a
    clock-skew problem into a performance claim.
    """
    start = _epoch_ms(captured_at)
    end = _epoch_ms(at)
    if start is None or end is None:
        return None
    delta = end - start
    return None if delta < 0 else round(delta, 3)


def _epoch_ms(value: str) -> Optional[float]:
    try:
        text = value.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp() * 1000.0
    except (AttributeError, TypeError, ValueError):
        return None


class EventSink(Protocol):
    """Final pipeline stage — publish the result as events. No-op in P1-6; wired to NATS in P1-5."""

    def publish(self, result: DetectionResult) -> None: ...


class NullEventSink:
    def publish(self, result: DetectionResult) -> None:  # noqa: D401
        return None
