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

from typing import Any, List, Optional, Protocol, Sequence, Tuple

from contracts import Detection, DetectionResult, FrameContext, ModelBinding


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
    """Assemble the tenant-tagged, fully version-stamped DetectionResult."""

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
    ) -> DetectionResult:
        return DetectionResult(
            tenant_id=ctx.tenant_id,
            camera_id=ctx.camera_id,
            capability_id=capability_id,
            capability_version=capability_version,
            runtime_version=runtime_version,
            execution_provider=execution_provider,
            model=model,
            frame_seq=ctx.frame_number,
            frame_captured_at=ctx.timestamp or at,
            inference_ms=inference_ms,
            at=at,
            detections=detections,
            correlation_id=ctx.correlation_id,
        )


class EventSink(Protocol):
    """Final pipeline stage — publish the result as events. No-op in P1-6; wired to NATS in P1-5."""

    def publish(self, result: DetectionResult) -> None: ...


class NullEventSink:
    def publish(self, result: DetectionResult) -> None:  # noqa: D401
        return None
