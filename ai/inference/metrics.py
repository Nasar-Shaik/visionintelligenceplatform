"""Runtime metrics, collected from day one (#6). Stdlib-only: latencies (inference/decode), frame
counts (processed/dropped), detection count + average confidence, derived FPS, and a process
resource snapshot (RSS + CPU time). GPU utilisation is a future addition. Exposed as Prometheus
text by the transport. Thread-safe enough for the threaded stdlib server (GIL-guarded increments).
"""

from __future__ import annotations

import resource
import time
from collections import deque
from typing import Deque, List


class Metrics:
    def __init__(self, fps_window: int = 30) -> None:
        self.frames_processed = 0
        self.frames_dropped = 0
        self.detections_total = 0
        self._confidence_sum = 0.0
        self._inference_ms_sum = 0.0
        self._decode_ms_sum = 0.0
        self._recent_ts: Deque[float] = deque(maxlen=fps_window)

    def record_processed(self, decode_ms: float, inference_ms: float, confidences: List[float]) -> None:
        self.frames_processed += 1
        self._decode_ms_sum += decode_ms
        self._inference_ms_sum += inference_ms
        self.detections_total += len(confidences)
        self._confidence_sum += sum(confidences)
        self._recent_ts.append(time.monotonic())

    def record_dropped(self) -> None:
        self.frames_dropped += 1

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
    def fps(self) -> float:
        if len(self._recent_ts) < 2:
            return 0.0
        span = self._recent_ts[-1] - self._recent_ts[0]
        return (len(self._recent_ts) - 1) / span if span > 0 else 0.0

    def snapshot(self) -> dict:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        return {
            "framesProcessed": self.frames_processed,
            "framesDropped": self.frames_dropped,
            "detectionsTotal": self.detections_total,
            "avgConfidence": round(self.avg_confidence, 4),
            "avgInferenceMs": round(self.avg_inference_ms, 3),
            "avgDecodeMs": round(self.avg_decode_ms, 3),
            "fps": round(self.fps, 3),
            "maxRssKb": usage.ru_maxrss,
            "cpuUserSeconds": round(usage.ru_utime, 3),
            "cpuSystemSeconds": round(usage.ru_stime, 3),
        }

    def prometheus(self) -> str:
        s = self.snapshot()
        rows = [
            ("inference_frames_processed_total", "counter", s["framesProcessed"]),
            ("inference_frames_dropped_total", "counter", s["framesDropped"]),
            ("inference_detections_total", "counter", s["detectionsTotal"]),
            ("inference_avg_confidence", "gauge", s["avgConfidence"]),
            ("inference_latency_ms_avg", "gauge", s["avgInferenceMs"]),
            ("inference_decode_ms_avg", "gauge", s["avgDecodeMs"]),
            ("inference_fps", "gauge", s["fps"]),
            ("inference_process_max_rss_kb", "gauge", s["maxRssKb"]),
            ("inference_process_cpu_user_seconds", "counter", s["cpuUserSeconds"]),
            ("inference_process_cpu_system_seconds", "counter", s["cpuSystemSeconds"]),
        ]
        lines: list[str] = []
        for name, kind, value in rows:
            lines.append(f"# TYPE {name} {kind}")
            lines.append(f"{name} {value}")
        return "\n".join(lines) + "\n"
