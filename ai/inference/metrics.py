"""Runtime metrics, collected from day one (#6). Stdlib-only: latencies (inference/decode), frame
counts (processed/dropped), detection count + average confidence, derived FPS, and a process
resource snapshot (RSS + CPU time). GPU utilisation is a future addition. Exposed as Prometheus
text by the transport. Thread-safe enough for the threaded stdlib server (GIL-guarded increments).
"""

from __future__ import annotations

import resource
import time
from collections import deque
from typing import Deque, Dict, List, Optional

_CONF_BUCKETS = 10  # [0,0.1) … [0.9,1.0]

# The authoritative operational/AI partition (AI-5c; mirrors `METRIC_GROUPS` in @vip/contracts).
# Operational = is the system healthy (ops owns it). AI = is the system seeing correctly (AI owns it).
OPERATIONAL_METRICS = frozenset(
    {
        "fps", "framesProcessed", "framesSkipped", "droppedFrames", "frameDropPercent",
        "avgLatencyMs", "latencyP50Ms", "latencyP95Ms", "avgDecodeMs", "avgInferenceMs",
        "queueDepth", "queueHighWatermark", "queueUtilization", "averageQueueDepth",
        "processingDelayMs", "uptimeSeconds", "memoryMb", "cpuPercent", "gpuPercent",
        "modelLoadMs", "maxRssKb", "cpuUserSeconds", "cpuSystemSeconds",
        "sessionCount", "activeSessions", "reconnectCount", "restartCount",
        "streamAvailability", "averageRecoveryTime", "eventLatencyMs", "benchmarkRunCount",
    }
)

AI_METRICS = frozenset(
    {
        "detectionFps", "detectionsTotal", "detectionsByLabel", "avgConfidence",
        "confidenceDistribution",
        "activeTracks", "confirmedTracks", "tentativeTracks", "lostTracks", "removedTracks",
        "averageTrackAgeFrames", "averageTrackLifetime", "averageTrackLength",
        "averageTrackVelocity", "zoneCrossings", "countingRate",
        "activeBehaviors", "compositeBehaviorCount", "behaviorCorrelationCount",
        "behaviorRelationshipCount", "compositeEvaluations", "compositeMatches",
        "compositeMisses", "averageCompositeLatency", "averageCompositeConfidence",
        "compositeExecutionTime", "activeTemporalWindows", "averageWindowDuration",
        "profileLoads", "profileValidationFailures", "activeProfiles", "eventThroughput",
    }
)


def _percentile(sorted_values: List[float], pct: float) -> float:
    """Nearest-rank percentile over a pre-sorted list (deterministic; no numpy)."""
    if not sorted_values:
        return 0.0
    rank = max(1, min(len(sorted_values), int(round(pct / 100.0 * len(sorted_values) + 0.5))))
    return sorted_values[rank - 1]


class Metrics:
    """Runtime metrics (P2-2 G-3, #6). Deterministic + unit-testable: everything is derived from
    counters + a windowed latency/timestamp sample. `clock`/`monotonic` are injected so FPS, uptime,
    and percentiles are reproducible in tests (no wall-clock, no hardware). GPU is best-effort (None
    unless a probe is supplied)."""

    def __init__(
        self,
        fps_window: int = 30,
        latency_window: int = 256,
        *,
        monotonic: Optional[callable] = None,
        gpu_probe: Optional[callable] = None,
    ) -> None:
        self.frames_processed = 0
        self.frames_dropped = 0
        self.frames_skipped = 0
        self.detections_total = 0
        self.queue_depth = 0
        self.model_load_ms: Optional[float] = None
        #: label → count. ⚠️ Bounded by the model's label space (≤ 90), so it cannot grow without
        #: limit — and it is what distinguishes "the runtime answered" from "the runtime SAW a
        #: person", which is the only claim this phase is allowed to make.
        self.detections_by_label: Dict[str, int] = {}
        self._confidence_sum = 0.0
        self._inference_ms_sum = 0.0
        self._decode_ms_sum = 0.0
        self._frame_latency_ms_sum = 0.0
        self._frame_latency_count = 0
        self._recent_ts: Deque[float] = deque(maxlen=fps_window)
        self._latencies: Deque[float] = deque(maxlen=latency_window)
        self._conf_hist: List[int] = [0] * _CONF_BUCKETS
        self._monotonic = monotonic or time.monotonic
        self._gpu_probe = gpu_probe
        self._started = self._monotonic()

    def record_processed(
        self,
        decode_ms: float,
        inference_ms: float,
        confidences: List[float],
        labels: Optional[List[str]] = None,
        frame_latency_ms: Optional[float] = None,
    ) -> None:
        self.frames_processed += 1
        self._decode_ms_sum += decode_ms
        self._inference_ms_sum += inference_ms
        self._latencies.append(inference_ms)
        self.detections_total += len(confidences)
        self._confidence_sum += sum(confidences)
        for c in confidences:
            idx = min(_CONF_BUCKETS - 1, max(0, int(c * _CONF_BUCKETS)))
            self._conf_hist[idx] += 1
        for label in labels or []:
            self.detections_by_label[label] = self.detections_by_label.get(label, 0) + 1
        if frame_latency_ms is not None:
            self._frame_latency_ms_sum += frame_latency_ms
            self._frame_latency_count += 1
        self._recent_ts.append(self._monotonic())

    def record_dropped(self) -> None:
        self.frames_dropped += 1

    def record_skipped(self, count: int = 1) -> None:
        self.frames_skipped += count

    def set_queue_depth(self, depth: int) -> None:
        self.queue_depth = max(0, int(depth))

    def set_model_load_ms(self, ms: float) -> None:
        self.model_load_ms = float(ms)

    @property
    def avg_confidence(self) -> float:
        return self._confidence_sum / self.detections_total if self.detections_total else 0.0

    @property
    def avg_inference_ms(self) -> float:
        return self._inference_ms_sum / self.frames_processed if self.frames_processed else 0.0

    @property
    def avg_decode_ms(self) -> float:
        return self._decode_ms_sum / self.frames_processed if self.frames_processed else 0.0

    @property
    def avg_frame_latency_ms(self) -> Optional[float]:
        """Capture → result. ⚠️ `None`, not 0, when nothing measurable has arrived — averaged over
        the frames that carried a usable capture time rather than over all frames, so a stream with
        no timestamps cannot drag the number down towards a flattering zero."""
        if self._frame_latency_count == 0:
            return None
        return self._frame_latency_ms_sum / self._frame_latency_count

    @property
    def latency_p50_ms(self) -> float:
        return _percentile(sorted(self._latencies), 50)

    @property
    def latency_p95_ms(self) -> float:
        return _percentile(sorted(self._latencies), 95)

    @property
    def uptime_seconds(self) -> float:
        return max(0.0, self._monotonic() - self._started)

    @property
    def fps(self) -> float:
        if len(self._recent_ts) < 2:
            return 0.0
        span = self._recent_ts[-1] - self._recent_ts[0]
        return (len(self._recent_ts) - 1) / span if span > 0 else 0.0

    def _gpu_percent(self) -> Optional[float]:
        if self._gpu_probe is None:
            return None
        try:
            return float(self._gpu_probe())
        except Exception:  # noqa: BLE001 - a GPU probe must never break metrics
            return None

    def runtime_metrics(self) -> dict:
        """A snapshot matching the @vip/contracts `runtime-metrics` shape (camelCase)."""
        usage = resource.getrusage(resource.RUSAGE_SELF)
        out: dict = {
            "fps": round(self.fps, 3),
            "framesProcessed": self.frames_processed,
            "framesSkipped": self.frames_skipped,
            "droppedFrames": self.frames_dropped,
            "avgLatencyMs": round(self.avg_inference_ms, 3),
            "latencyP50Ms": round(self.latency_p50_ms, 3),
            "latencyP95Ms": round(self.latency_p95_ms, 3),
            "queueDepth": self.queue_depth,
            "confidenceDistribution": list(self._conf_hist),
            "memoryMb": round(usage.ru_maxrss / 1024.0, 2),
            "uptimeSeconds": round(self.uptime_seconds, 3),
        }
        if self.model_load_ms is not None:
            out["modelLoadMs"] = round(self.model_load_ms, 3)
        frame_latency = self.avg_frame_latency_ms
        if frame_latency is not None:
            out["avgFrameLatencyMs"] = round(frame_latency, 3)
        gpu = self._gpu_percent()
        if gpu is not None:
            out["gpuPercent"] = round(gpu, 2)
        return out

    def snapshot(self) -> dict:
        """Back-compat detailed snapshot (superset of runtime_metrics) used by /status + /metrics."""
        usage = resource.getrusage(resource.RUSAGE_SELF)
        out = self.runtime_metrics()
        out.update(
            {
                "detectionsTotal": self.detections_total,
                "detectionsByLabel": dict(self.detections_by_label),
                "avgConfidence": round(self.avg_confidence, 4),
                "avgInferenceMs": round(self.avg_inference_ms, 3),
                "avgDecodeMs": round(self.avg_decode_ms, 3),
                "maxRssKb": usage.ru_maxrss,
                "cpuUserSeconds": round(usage.ru_utime, 3),
                "cpuSystemSeconds": round(usage.ru_stime, 3),
            }
        )
        return out

    def grouped(self) -> dict:
        """Split a metrics snapshot into the two audiences (AI-5c, Architect AI-5b rec 2).

        `operational` answers "is the system HEALTHY?" (availability, queues, latency, resources) and
        pages an operator. `ai` answers "is the system SEEING correctly?" (detections, tracks,
        behaviors, confidence) and belongs to the AI team. One producer, two audiences — mixing them
        is why production dashboards end up unreadable.

        Mirrors `METRIC_GROUPS` in @vip/contracts; a field absent from the snapshot is simply omitted.
        """
        snapshot = self.snapshot()
        return {
            "operational": {k: v for k, v in snapshot.items() if k in OPERATIONAL_METRICS},
            "ai": {k: v for k, v in snapshot.items() if k in AI_METRICS},
        }

    def prometheus(self) -> str:
        s = self.snapshot()
        rows = [
            ("inference_frames_processed_total", "counter", s["framesProcessed"]),
            ("inference_frames_skipped_total", "counter", s["framesSkipped"]),
            ("inference_frames_dropped_total", "counter", s["droppedFrames"]),
            ("inference_detections_total", "counter", s["detectionsTotal"]),
            ("inference_avg_confidence", "gauge", s["avgConfidence"]),
            ("inference_latency_ms_avg", "gauge", s["avgLatencyMs"]),
            ("inference_latency_ms_p50", "gauge", s["latencyP50Ms"]),
            ("inference_latency_ms_p95", "gauge", s["latencyP95Ms"]),
            ("inference_decode_ms_avg", "gauge", s["avgDecodeMs"]),
            # ⚠️ Capture → result, a different question from inference time: inference can be fast
            # while the answer is old because the frame queued. Absent when nothing measurable has
            # arrived, rather than reported as a flattering zero.
            ("inference_frame_latency_ms_avg", "gauge", s.get("avgFrameLatencyMs")),
            ("inference_queue_depth", "gauge", s["queueDepth"]),
            ("inference_fps", "gauge", s["fps"]),
            ("inference_uptime_seconds", "gauge", s["uptimeSeconds"]),
            ("inference_process_max_rss_kb", "gauge", s["maxRssKb"]),
            ("inference_process_cpu_user_seconds", "counter", s["cpuUserSeconds"]),
            ("inference_process_cpu_system_seconds", "counter", s["cpuSystemSeconds"]),
        ]
        lines: List[str] = []
        for name, kind, value in rows:
            if value is None:
                continue  # not measured yet — a missing series, never a fabricated zero
            lines.append(f"# TYPE {name} {kind}")
            lines.append(f"{name} {value}")
        if self.detections_by_label:
            lines.append("# TYPE inference_detections_by_label_total counter")
            for label, count in sorted(self.detections_by_label.items()):
                lines.append(f'inference_detections_by_label_total{{label="{_escape(label)}"}} {count}')
        return "\n".join(lines) + "\n"


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
