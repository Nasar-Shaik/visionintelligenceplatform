"""OnnxModelAdapter — the real ONNX Runtime backend behind the ModelAdapter seam. **Integration-only**
(imports onnxruntime + numpy + pillow). Never imported by the unit suite or the `stub` backend; only
the `onnx` backend loads it. Pre-processing (decode + letterbox → NCHW tensor) and inference are the
two backend-specific stages; generic post-processing turns the raw output into `Detection`s.

Assumes a common detection head (boxes+scores+labels). A model's exact I/O is bound by the MLflow
resolver's metadata; per-model pre/post variants and FP/FN model-CI gates are future work
(AI_PIPELINE §Future). Validated against a registered model on the dev-stack MLflow.
"""

from __future__ import annotations

import io
from typing import Any, List

import numpy as np  # type: ignore
import onnxruntime as ort  # type: ignore
from PIL import Image  # type: ignore

from contracts import FrameContext
from pipeline import RawDetection


class OnnxModelAdapter:
    def __init__(self, providers: List[str] | None = None) -> None:
        self._providers = providers or ["CPUExecutionProvider"]
        self.execution_provider = self._providers[0]
        self._session: Any = None
        self._input_name = ""
        self._size = 640

    def load(self, ref: dict) -> None:
        self._size = int(ref.get("input_size", 640))
        self._session = ort.InferenceSession(str(ref["onnx_path"]), providers=self._providers)
        self._input_name = self._session.get_inputs()[0].name
        self.execution_provider = self._session.get_providers()[0]

    def preprocess(self, ctx: FrameContext) -> Any:
        if not ctx.image:
            return None
        img = Image.open(io.BytesIO(ctx.image)).convert("RGB").resize((self._size, self._size))
        arr = np.asarray(img, dtype=np.float32) / 255.0
        return np.transpose(arr, (2, 0, 1))[np.newaxis, ...]  # NCHW

    def infer(self, prepared: Any) -> List[RawDetection]:
        if prepared is None or self._session is None:
            return []
        outputs = self._session.run(None, {self._input_name: prepared})
        primary = np.asarray(outputs[0])
        rows = primary.reshape(-1, primary.shape[-1]) if primary.ndim > 1 else primary
        dets: List[RawDetection] = []
        for row in rows:
            if len(row) < 5:
                continue
            x1, y1, x2, y2, score = (float(row[i]) for i in range(5))
            class_id = int(row[5]) if len(row) > 5 else 0
            dets.append(
                RawDetection(
                    bbox=(
                        max(0.0, x1 / self._size),
                        max(0.0, y1 / self._size),
                        min(1.0, (x2 - x1) / self._size),
                        min(1.0, (y2 - y1) / self._size),
                    ),
                    score=min(1.0, score),
                    class_id=class_id,
                )
            )
        return dets

    def unload(self) -> None:
        self._session = None
