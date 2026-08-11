"""The capability runtime — the model-agnostic building block (docs/architecture/05). It is built
from a MANIFEST (#1), exposes a LIFECYCLE STATE (#5, not a boolean), and orchestrates the staged
PIPELINE (#8): preprocess → infer (both behind the ModelAdapter seam #2) → postprocess → track →
translate → publish. It records METRICS (#6) and stamps every result with full VERSION metadata
(#7). Frames arrive as a FrameContext (#3); one without a tenant is dropped fail-closed (Law 5).
The capability persists NO tenant data. Stdlib-only; stages are injected Protocols (interfaces over
inheritance), each replaceable.
"""

from __future__ import annotations

import time
from typing import Optional

import obslog
from contracts import CapabilityState, DetectionResult, FrameContext, ModelBinding
from errors import CapabilityLoadError, InferenceError
from manifest import CapabilityManifest
from metrics import Metrics
from pipeline import (
    ConfidencePostprocessor,
    DefaultResultTranslator,
    EventSink,
    ModelAdapter,
    NoopTracker,
    NullEventSink,
    Postprocessor,
    ResultTranslator,
    Tracker,
)
from resolver import ModelResolver


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


class Capability:
    def __init__(
        self,
        manifest: CapabilityManifest,
        resolver: ModelResolver,
        adapter: ModelAdapter,
        runtime_version: str,
        *,
        metrics: Optional[Metrics] = None,
        clock=time.time,
        postprocessor: Optional[Postprocessor] = None,
        pose_estimator=None,  # noqa: ANN001 - pose_estimator.PoseEstimator; None = pose off
        tracker: Optional[Tracker] = None,
        translator: Optional[ResultTranslator] = None,
        event_sink: Optional[EventSink] = None,
    ) -> None:
        self.manifest = manifest
        self._resolver = resolver
        self._adapter = adapter
        self._runtime_version = runtime_version
        self.metrics = metrics or Metrics()
        self._clock = clock
        self._postprocessor = postprocessor  # built from resolved labels at init if None
        self._tracker = tracker or NoopTracker()
        # Optional and off by default: a runtime with no pose model behaves exactly as before.
        self._pose = pose_estimator
        self._pose_ms: float = 0.0
        self._pose_failures = 0
        self._translator = translator or DefaultResultTranslator()
        self._event_sink = event_sink or NullEventSink()
        self._binding: Optional[ModelBinding] = None
        #: How the frame was turned into a tensor, from the resolved model. Stamped on every result
        #: so an archived detection can be reproduced — see `InputSpec.fingerprint`.
        self._preprocessing: Optional[str] = None
        self._state = CapabilityState.LOADING if manifest.enabled else CapabilityState.DISABLED

    # --- lifecycle -----------------------------------------------------------------

    def init(self) -> None:
        """Resolve the model by selector and load the backend. Sets state READY, or FAILED (raise)."""
        if not self.manifest.enabled:
            self._state = CapabilityState.DISABLED
            return
        self._state = CapabilityState.LOADING
        try:
            binding, ref = self._resolver.resolve(self.manifest.required_model)
            self._adapter.load(ref)
            if self._postprocessor is None:
                self._postprocessor = ConfidencePostprocessor(
                    labels=ref.get("labels"),
                    # ⚠️ The manifest's per-label floors, not a second copy of them. The capability
                    # is the only thing that has read the manifest, and a floor decided anywhere
                    # else would be a second answer to "what does this deployment report".
                    floors=self.manifest.min_confidence_by_label,
                )
            preprocessing = ref.get("preprocessing")
            self._preprocessing = preprocessing if isinstance(preprocessing, str) else None
            self._binding = binding
            self._state = CapabilityState.READY
        except Exception as exc:  # noqa: BLE001 - any load failure → FAILED (no partial output)
            self._state = CapabilityState.FAILED
            raise CapabilityLoadError(f"capability '{self.manifest.capability_id}' failed to load: {exc}") from exc

    def dispose(self) -> None:
        self._adapter.unload()
        self._state = CapabilityState.DISABLED

    @property
    def state(self) -> CapabilityState:
        return self._state

    @property
    def ready(self) -> bool:
        return self._state == CapabilityState.READY

    def record_dropped(self) -> None:
        self.metrics.record_dropped()

    # --- self-description + health -------------------------------------------------

    def descriptor(self) -> dict:
        return self.manifest.descriptor()

    def health(self) -> dict:
        out = {
            "capabilityId": self.manifest.capability_id,
            "state": self._state.value,
            "executionProvider": getattr(self._adapter, "execution_provider", "unknown"),
            "model": self._binding.to_dict() if self._binding else None,
            "metrics": self.metrics.snapshot(),
        }
        # ⚠️ Optional by design: `describe()` is not part of the `ModelAdapter` Protocol, so a backend
        # that does not implement it stays a valid backend and simply reports nothing extra. Adding
        # it to the Protocol would make self-description mandatory for a seam whose whole purpose is
        # to stay small.
        describe = getattr(self._adapter, "describe", None)
        if callable(describe):
            try:
                out["adapter"] = describe()
            except Exception as exc:  # noqa: BLE001 - a status call must never break the runtime
                out["adapter"] = {"error": str(exc)[:200]}
        # ⛔ **The counter that was missing, and its absence cost a whole diagnosis cycle.** Until
        # here, the only number pose ever published was `stats()` printed at LOAD — a constant zero
        # by construction, since nothing had been inferred yet. Re-reading it after a run and
        # concluding "pose never executed" is not a stretch; it is the only reading available. A
        # counter that cannot move is not evidence, so pose now reports where it is running.
        stats = getattr(self._pose, "stats", None)
        if callable(stats):
            try:
                pose = dict(self._pose.stats())
                pose["frameFailures"] = self._pose_failures
                pose["lastFrameMs"] = round(self._pose_ms, 3)
                out["pose"] = pose
            except Exception as exc:  # noqa: BLE001
                out["pose"] = {"error": str(exc)[:200]}
        return out

    # --- pipeline ------------------------------------------------------------------

    def process(self, ctx: FrameContext) -> dict:
        """Run the pipeline over one frame → a DetectionResult dict. Assumes ctx already carries a
        tenant (FrameContext.from_request enforces it fail-closed before we get here)."""
        if self._state != CapabilityState.READY or self._binding is None or self._postprocessor is None:
            raise InferenceError(f"capability not ready (state={self._state.value})")

        t0 = self._clock()
        prepared = self._adapter.preprocess(ctx)
        t1 = self._clock()
        try:
            raw = self._adapter.infer(prepared)
        except Exception as exc:  # noqa: BLE001 - never crash the stream; count + surface
            self.metrics.record_dropped()
            raise InferenceError(f"inference failed: {exc}") from exc
        t2 = self._clock()

        detections = self._postprocessor.run(raw, ctx, self.manifest.min_confidence)
        # ⭐ **After detection, before tracking** — the same order the batch analyser uses, and the
        # order is the integration. Pose reads the detector's person boxes, so presence is never its
        # answer; and it must precede the tracker, because the tracker copies a detection's
        # attributes onto the track and the live console overlay reads TRACKS. Posing after tracking
        # would produce keypoints nothing carried to the browser.
        if self._pose is not None:
            pose_started = time.perf_counter()
            try:
                detections = self._pose.estimate(ctx.image, detections)
            except Exception as exc:  # noqa: BLE001 - an enrichment must never delete a detection
                # ⛔ Counted and logged, never silent. A swallowed enrichment failure that reports
                # nothing is indistinguishable from a frame with nobody in it — which is how three
                # milestones of this project have lost time.
                self._pose_failures += 1
                obslog.warn("pose failed for a frame; detection continues",
                            cameraId=ctx.camera_id, error=str(exc)[:200])
            self._pose_ms = (time.perf_counter() - pose_started) * 1000.0
        detections = self._tracker.run(detections, ctx)
        result: DetectionResult = self._translator.run(
            detections,
            ctx,
            self._binding,
            capability_id=self.manifest.capability_id,
            capability_version=self.manifest.version,
            runtime_version=self._runtime_version,
            execution_provider=getattr(self._adapter, "execution_provider", "unknown"),
            inference_ms=(t2 - t1) * 1000.0,
            at=_iso(self._clock()),
            # Reproducibility metadata: the pixel path and the floor that shaped this result.
            preprocessing_version=self._preprocessing,
            confidence_threshold=self.manifest.min_confidence,
        )
        self._event_sink.publish(result)
        self.metrics.record_processed(
            decode_ms=(t1 - t0) * 1000.0,
            inference_ms=(t2 - t1) * 1000.0,
            confidences=[d.confidence for d in detections],
            # ⚠️ What was seen, not just how many: "42 detections" and "42 people" are different
            # claims, and only the second one is evidence that the model is doing its job.
            labels=[d.label for d in detections],
            frame_latency_ms=result.frame_latency_ms,
        )
        return result.to_dict()
