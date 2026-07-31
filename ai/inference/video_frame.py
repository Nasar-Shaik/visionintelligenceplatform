"""Immutable per-frame value object (AI-1, stage output of the Frame Decoder).

Each decoded frame carries its own **immutable metadata** (Architect AI-1 rec 3) so detections,
events, evidence, and future replay can be correlated and debugged without re-deriving anything:
frame index, timestamp, the original + processed dimensions, the sampling rate that admitted it, and
the source video. The pixel payload is opaque `bytes` (encoded JPEG/PNG from the decoder) — the
runtime already treats frames as bytes behind the `ModelAdapter` seam, so no numpy/OpenCV type leaks
into the pipeline. Stdlib-only.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Frame:
    """One decoded video frame + its immutable metadata."""

    index: int
    timestamp: str  # ISO-8601 or "<seconds>s" offset from the video start
    source_video: str
    original_width: int
    original_height: int
    processed_width: int
    processed_height: int
    sampling_rate: float  # kept-frames / source-frames for the sampler that admitted this frame
    image: bytes  # opaque encoded pixels (never a vendor tensor)

    def meta(self) -> dict:
        """Metadata only (no pixels) — the shape written to detections.json / evidence / replay."""
        return {
            "frameIndex": self.index,
            "timestamp": self.timestamp,
            "sourceVideo": self.source_video,
            "originalWidth": self.original_width,
            "originalHeight": self.original_height,
            "processedWidth": self.processed_width,
            "processedHeight": self.processed_height,
            "samplingRate": round(float(self.sampling_rate), 6),
        }
