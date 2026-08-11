"""Runs the catalogued pose model over the detector's person boxes — P3.3b.

    Detection[label="person"] ──▶ crop ──▶ [rtmpose ONNX] ──▶ pose.decode ──▶ attributes["pose"]

⭐ **Not a second pipeline, and not a second `ModelAdapter`.** It resolves through the same
`ModelStore`, verifies the same checksum, and builds an `onnxruntime` session with the same options
the detector adapter uses. What it deliberately does not do is pretend to be a `ModelAdapter`: that
contract is `frame → RawDetection[]`, and a top-down pose model is `person box → keypoints`. Forcing
the wrong shape would mean either a fake frame-level detector or a second meaning for `infer()`.

⛔ **The detector gate is the whole safety argument, and it is structural.** RTMPose is top-down: it
is *told* a person is in the crop and answers regardless. Measured in P3.3a on an empty room, it
returned all 17 joints at 0.21–0.57 — its hallucinated left shoulder (0.489) beating a real person's
(0.383) — and 12 of 17 passed the visibility threshold. So presence is never this module's answer.
`estimate()` iterates the detector's output and skips anything that is not a person; an empty frame
produces an empty list of detections and therefore zero pose observations, with no threshold involved.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional, Sequence

import pose
from contracts import Detection
from perception import ATTR_POSE

#: The catalogued model this estimator loads. ⚠️ By id, so the checksum and provenance stay the
#: catalogue's job — this module never names a file or a URL.
MODEL_ID = "rtmpose-tiny"

#: Only these detector labels are posed. ⛔ Not configurable to "all": running a body-keypoint model
#: over a bottle produces 17 confident joints on a bottle.
PERSON_LABELS = ("person",)


class PoseEstimator:
    """Loads once, runs per person box. ⚠️ Not thread-safe; the runtime analyses one frame at a time."""

    def __init__(self, *, model_id: str = MODEL_ID, threshold: float = pose.VISIBILITY_THRESHOLD) -> None:
        self._model_id = model_id
        self._threshold = threshold
        self._session: Any = None
        self._input_name = ""
        self._sha256 = ""
        self.execution_provider = "unloaded"
        self._last_ms: Optional[float] = None
        self._inferences = 0
        self._skipped_not_person = 0
        self._failures = 0

    # --- lifecycle ----------------------------------------------------------------------------

    def load(self, *, artifact_dir: str = "", catalogue: str = "") -> None:
        """Resolve the catalogue entry, verify the artifact, open a session.

        ⛔ Verification is the store's, not ours — the same check the detector gets. An artifact that
        does not match its registered digest must fail here rather than produce keypoints nobody can
        attribute to a known model.
        """
        import onnxruntime as ort  # noqa: WPS433 - heavy, and absent in the stub backend
        from model_store import DEFAULT_ARTIFACT_DIR, DEFAULT_CATALOGUE, ModelStore  # noqa: WPS433

        store = ModelStore.load(catalogue or DEFAULT_CATALOGUE,
                                artifact_dir=artifact_dir or os.environ.get("INFERENCE_MODEL_DIR")
                                or DEFAULT_ARTIFACT_DIR)
        model = next((m for m in store.all() if m.id == self._model_id), None)
        if model is None:
            raise LookupError(f"pose model '{self._model_id}' is not in the catalogue")
        path = store.verify(model)
        self._sha256 = model.sha256

        # ⚠️ Widths checked against the catalogue BEFORE any frame is analysed. A graph whose SimCC
        # width differs decodes every joint proportionally wrong — a skeleton that looks like a
        # skeleton, slightly wrong, everywhere, which reads as a bad model rather than a bad load.
        params = dict(model.output_params or {})
        pose.check_outputs(int(params.get("simccX", 0)), int(params.get("simccY", 0)))

        options = ort.SessionOptions()
        options.intra_op_num_threads = 0
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(str(path), sess_options=options,
                                             providers=["CPUExecutionProvider"])
        self._input_name = self._session.get_inputs()[0].name
        self.execution_provider = self._session.get_providers()[0]

    @property
    def loaded(self) -> bool:
        return self._session is not None

    # --- the work -----------------------------------------------------------------------------

    def estimate(self, image: bytes, detections: Sequence[Detection]) -> List[Detection]:
        """Attach `attributes["pose"]` to every person detection. Returns the same list.

        ⚠️ Detections that are not people are returned untouched — not annotated with an empty pose,
        which would be a claim that the model looked and found nothing.
        """
        if not self.loaded or not detections:
            return list(detections)
        # ⛔ **The gate decides BEFORE the frame is decoded, not per detection afterwards.** Measured
        # on real footage: a `tie`-only frame cost 25 ms more with pose enabled than without it —
        # a full 1080×1920 decode performed so that every detection on it could then be skipped.
        # A stage that must not run on this frame must not do the frame's work either.
        if not any(det.label in PERSON_LABELS for det in detections):
            self._skipped_not_person += len(detections)
            return list(detections)
        frame = self._decode(image)
        if frame is None:
            return list(detections)
        fh, fw = frame.shape[:2]

        out: List[Detection] = []
        for det in detections:
            if det.label not in PERSON_LABELS:
                self._skipped_not_person += 1
                out.append(det)
                continue
            attrs = self._pose_for(frame, det, fw, fh)
            if attrs is None:
                out.append(det)
                continue
            merged = dict(det.attributes)
            merged[ATTR_POSE] = attrs
            out.append(
                Detection(
                    label=det.label, confidence=det.confidence, bbox=det.bbox,
                    class_id=det.class_id, attributes=merged, embedding=det.embedding,
                    metadata=dict(det.metadata), tracking_id=det.tracking_id,
                    detection_id=det.detection_id, identity_id=det.identity_id,
                    preceded_by=det.preceded_by,
                )
            )
        return out

    def _pose_for(self, frame, det: Detection, fw: int, fh: int) -> Optional[dict]:
        # ⚠️ No numpy import here on purpose: everything below is gating, slicing and `pose.decode`,
        # which take plain sequences. Keeping this function dependency-free is what lets the detector
        # gate be tested outside the built image.
        try:
            crop = pose.crop_for(det.bbox, fw, fh)
        except pose.PoseError:
            # ⚠️ A degenerate box is the detector's problem, not a reason to fail the frame.
            self._failures += 1
            return None
        sub = frame[crop.y:crop.y + crop.h, crop.x:crop.x + crop.w]
        if sub.size == 0:
            self._failures += 1
            return None

        blob = self._preprocess(sub, crop)
        started = time.perf_counter()
        simcc_x, simcc_y = self._session.run(None, {self._input_name: blob})
        self._last_ms = (time.perf_counter() - started) * 1000.0
        self._inferences += 1

        keypoints = pose.decode(simcc_x[0], simcc_y[0], crop, fw, fh, threshold=self._threshold)
        return pose.to_attribute(keypoints, model_id=self._model_id, artifact_sha256=self._sha256)

    def _preprocess(self, sub, crop: pose.CropBox):
        """⚠️ Must reproduce `crop_for`'s letterbox exactly — `decode` reverses *this* transform."""
        import cv2  # noqa: WPS433
        import numpy as np  # noqa: WPS433

        canvas = np.full((pose.INPUT_H, pose.INPUT_W, 3), pose.PAD_VALUE, np.uint8)
        nw = max(1, int(round(crop.w * crop.scale)))
        nh = max(1, int(round(crop.h * crop.scale)))
        ox, oy = int(crop.pad_x), int(crop.pad_y)
        canvas[oy:oy + nh, ox:ox + nw] = cv2.resize(sub, (nw, nh))
        blob = canvas.astype(np.float32)[:, :, ::-1]  # BGR→RGB
        blob = (blob - np.array(pose.MEAN, np.float32)) / np.array(pose.STD, np.float32)
        return np.ascontiguousarray(blob.transpose(2, 0, 1)[None])

    def _decode(self, image: bytes):
        """Bytes → frame. ⭐ An instance method, not a static one, so a test can substitute it.

        ⚠️ That seam is why the detector gate — the safety property — is testable with the standard
        library alone. cv2, numpy and onnxruntime are integration-only dependencies here; a gate
        whose tests could not run outside the built image would be verified least often exactly where
        it matters most.
        """
        import cv2  # noqa: WPS433
        import numpy as np  # noqa: WPS433

        buf = np.frombuffer(image, np.uint8)
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)

    # --- observability ------------------------------------------------------------------------

    def stats(self) -> Dict[str, object]:
        """⛔ Counts and timings only. No accuracy figure is computable without human keypoints."""
        return {
            "model": self._model_id,
            "artifactSha256": self._sha256,
            "executionProvider": self.execution_provider,
            "poseInferences": self._inferences,
            "skippedNotPerson": self._skipped_not_person,
            "failures": self._failures,
            "lastInferenceMs": round(self._last_ms, 3) if self._last_ms is not None else None,
        }
