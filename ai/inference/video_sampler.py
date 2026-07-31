"""Frame Sampler stage (AI-1) — down-sample a frame stream to a target FPS (or an every-Nth stride).

Single responsibility, independently testable (Architect rec 1): admit one frame every `stride`,
re-stamp each admitted frame's `sampling_rate`, and **count dropped frames** (a first-class backpressure
signal, mirrored later into runtime observability, rec 6/rec-3). Stateless w.r.t. detection; stdlib-only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Iterator, Optional

from video_frame import Frame


@dataclass
class FrameSampler:
    """Keep every `stride`-th frame, or derive the stride from `source_fps`/`target_fps`."""

    source_fps: float = 30.0
    target_fps: Optional[float] = None
    stride: Optional[int] = None
    dropped: int = field(default=0, init=False)
    kept: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        if self.stride is None:
            if self.target_fps and self.target_fps > 0 and self.source_fps > 0:
                self.stride = max(1, round(self.source_fps / self.target_fps))
            else:
                self.stride = 1
        self.stride = max(1, int(self.stride))

    @property
    def effective_rate(self) -> float:
        return 1.0 / float(self.stride)

    def sample(self, frames: Iterable[Frame]) -> Iterator[Frame]:
        """Yield admitted frames (re-stamped with the effective sampling rate); tally drops."""
        self.dropped = 0
        self.kept = 0
        for i, frame in enumerate(frames):
            if i % self.stride == 0:
                self.kept += 1
                yield frame if frame.sampling_rate == self.effective_rate else _restamp(frame, self.effective_rate)
            else:
                self.dropped += 1


def _restamp(frame: Frame, rate: float) -> Frame:
    from dataclasses import replace

    return replace(frame, sampling_rate=rate)
