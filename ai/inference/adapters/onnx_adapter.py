"""OnnxModelAdapter — the real ONNX Runtime backend behind the `ModelAdapter` seam (P-8 Phase 3).

**Integration-only** (onnxruntime + numpy + pillow). The `stub` backend and the stdlib unit suite
never import it.

### ⚠️ What this file is NOT allowed to know

The model's family. Input size, layout, colour order, resize policy and output tensor layout all
arrive in `ref` from the catalogue (`model_store.LocalModelResolver`), and decoding is looked up by
`outputFormat` in the decoder registry. Swapping YOLOX for RT-DETR, or CPU for TensorRT, must not
touch this file — that is the whole point of ADR-0002, and the earlier version of this adapter broke
it: it hard-coded a 640×640 stretch, `/255` normalisation and one assumed row layout, which was
wrong for **both** models this platform actually registers.

### ⚠️ Execution provider is reported, never assumed

`self.execution_provider` is what the session says it got, not what was requested. A build that
silently fell back from CUDA to CPU is a capacity incident, and a runtime that reports the request
instead of the result hides it.

### ⚠️ Warm-up is part of loading

The first `run()` on a fresh session allocates arenas and JITs kernels — measured at roughly an order
of magnitude slower than the second. Without a warm-up the first frame after every deploy is an
outlier that lands in the operator's latency graph and in our own measurements.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Sequence

import numpy as np  # type: ignore
import onnxruntime as ort  # type: ignore

from adapters import model_formats
from contracts import FrameContext
from model_store import InputSpec
from pipeline import RawDetection

#: Requested in order; the session reports which one it actually got.
DEFAULT_PROVIDERS = ("CPUExecutionProvider",)


class OnnxModelAdapter:
    def __init__(
        self,
        providers: Optional[Sequence[str]] = None,
        *,
        intra_op_threads: int = 0,
        inter_op_threads: int = 1,
        warmup: bool = True,
    ) -> None:
        self._requested = list(providers or DEFAULT_PROVIDERS)
        self._intra_op_threads = max(0, int(intra_op_threads))
        self._inter_op_threads = max(0, int(inter_op_threads))
        self._warmup = warmup
        #: Until a session exists this is the honest answer, and `/status` prints it.
        self.execution_provider = "unloaded"
        self._session: Any = None
        self._input_name = ""
        self._spec: Optional[InputSpec] = None
        self._decoder: Optional[model_formats.Decoder] = None
        self._params: Dict[str, object] = {}
        self._model_id = ""
        self._output_format = ""
        self._preprocessing = ""
        self._loaded_at: Optional[float] = None
        self._warmup_ms: Optional[float] = None
        self._last_inference_ms: Optional[float] = None

    # --- lifecycle ------------------------------------------------------------------

    def load(self, ref: dict) -> None:
        spec = ref.get("input")
        if not isinstance(spec, InputSpec):
            raise ValueError(
                "onnx adapter requires a resolved catalogue entry: ref['input'] must be an InputSpec "
                f"(got {type(spec).__name__}). The `onnx` backend resolves through the model store."
            )
        path = str(ref.get("onnx_path", ""))
        if path == "":
            raise ValueError("onnx adapter requires ref['onnx_path']")
        self._output_format = str(ref.get("outputFormat", ""))
        # ⚠️ Resolved BEFORE the session is created. An unknown output format is a catalogue error,
        # and finding it after a 3-second model load — or worse, on the first frame — turns a
        # configuration mistake into a runtime incident.
        self._decoder = model_formats.get_decoder(self._output_format)
        self._params = dict(ref.get("outputParams") or {})
        self._spec = spec
        self._model_id = str(ref.get("modelId", ""))
        self._preprocessing = str(ref.get("preprocessing", ""))

        options = ort.SessionOptions()
        options.intra_op_num_threads = self._intra_op_threads
        options.inter_op_num_threads = self._inter_op_threads
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(path, sess_options=options, providers=self._requested)

        self._session = session
        self._input_name = session.get_inputs()[0].name
        self.execution_provider = session.get_providers()[0]
        self._loaded_at = time.time()
        if self._warmup:
            self._run_warmup()

    def _run_warmup(self) -> None:
        assert self._spec is not None  # noqa: S101 - guarded by load()
        dtype = np.uint8 if self._spec.dtype == "uint8" else np.float32
        shape = (
            (1, 3, self._spec.height, self._spec.width)
            if self._spec.layout == "NCHW"
            else (1, self._spec.height, self._spec.width, 3)
        )
        blank = np.zeros(shape, dtype=dtype)
        started = time.perf_counter()
        try:
            self._session.run(None, {self._input_name: blank})
        except Exception:  # noqa: BLE001 - a warm-up failure is a load failure; the caller decides
            raise
        self._warmup_ms = (time.perf_counter() - started) * 1000.0

    def unload(self) -> None:
        self._session = None
        self.execution_provider = "unloaded"

    # --- pipeline stages --------------------------------------------------------------

    def preprocess(self, ctx: FrameContext) -> Any:
        if not ctx.image or self._spec is None:
            return None
        return model_formats.preprocess(ctx.image, self._spec)

    def infer(self, prepared: Any) -> List[RawDetection]:
        if prepared is None or self._session is None or self._decoder is None or self._spec is None:
            return []
        tensor, geometry = prepared
        started = time.perf_counter()
        outputs = self._session.run(None, {self._input_name: tensor})
        self._last_inference_ms = (time.perf_counter() - started) * 1000.0
        return self._decoder(outputs, self._spec, geometry, self._params)

    # --- self-description (the runtime dashboard reads this) ---------------------------

    def describe(self) -> dict:
        """What is loaded, as measured. ⚠️ No artifact path: a status page is not a filesystem map."""
        return {
            "modelId": self._model_id,
            "outputFormat": self._output_format,
            "preprocessingVersion": self._preprocessing,
            "executionProvider": self.execution_provider,
            "requestedProviders": list(self._requested),
            "availableProviders": list(ort.get_available_providers()) if self._session else [],
            "inputName": self._input_name,
            "inputSize": None if self._spec is None else [self._spec.width, self._spec.height],
            "inputLayout": None if self._spec is None else self._spec.layout,
            "intraOpThreads": self._intra_op_threads,
            "interOpThreads": self._inter_op_threads,
            "loaded": self._session is not None,
            "loadedAt": self._loaded_at,
            "warmupMs": None if self._warmup_ms is None else round(self._warmup_ms, 2),
            "lastInferenceMs": None
            if self._last_inference_ms is None
            else round(self._last_inference_ms, 3),
        }
