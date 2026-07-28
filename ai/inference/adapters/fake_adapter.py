"""FakeModelAdapter — a dependency-free inference backend (execution provider "stub") behind the
ModelAdapter seam. Deterministic: pre-processing passes the raw frame bytes through, and inference
derives one raw detection whose score is a stable function of the bytes. It exercises the full
pipeline (preprocess → infer → postprocess → track → translate) without onnxruntime or a model
artifact, so the runtime is validated end-to-end while the real ONNX backend is validated separately.
"""

from __future__ import annotations

from typing import Any, List

from contracts import FrameContext
from pipeline import RawDetection


class FakeModelAdapter:
    execution_provider = "stub"

    def __init__(self) -> None:
        self._loaded = False

    def load(self, ref: dict) -> None:
        # Nothing to load for the stub backend; the label space is applied by post-processing.
        self._loaded = True

    def preprocess(self, ctx: FrameContext) -> Any:
        # The "prepared input" for the stub is simply the frame bytes.
        return ctx.image

    def infer(self, prepared: Any) -> List[RawDetection]:
        image: bytes = prepared or b""
        if not image:
            return []
        score = 0.50 + (sum(image) % 50) / 100.0  # deterministic in [0.50, 0.99]
        return [RawDetection(bbox=(0.25, 0.25, 0.5, 0.5), score=round(score, 4), class_id=0)]

    def unload(self) -> None:
        self._loaded = False
