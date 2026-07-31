"""Frame Decoder stage (AI-1) — turn a video source into a stream of `Frame`s.

A `FrameDecoder` is a Protocol so the stage is swappable and independently testable (Architect rec 1),
and the pipeline stays unaware of the underlying implementation (rec 7):

  - `StubFrameDecoder` — dependency-free, deterministic. Yields frames from in-memory byte payloads
    (or a synthetic count). The DEFAULT for unit tests + the `/playground/analyze` HTTP endpoint, so
    CI needs no OpenCV, no model files, and no real video (the platform's deterministic standard).
  - `OpenCvFrameDecoder` — real MP4/RTSP decode via OpenCV. `cv2` is imported LAZILY inside `decode()`,
    so importing this module never pulls the heavy dep; it is used by the CLI on real footage
    (integration-only). Encodes each frame to JPEG bytes so downstream stays type-neutral.

Stdlib-only at import time.
"""

from __future__ import annotations

from typing import Iterator, List, Optional, Protocol, Sequence

from video_frame import Frame


class FrameDecoder(Protocol):
    """Decode a source into `Frame`s. `source_fps` lets the sampler compute a stride."""

    source_video: str
    source_fps: float

    def decode(self) -> Iterator[Frame]: ...


class StubFrameDecoder:
    """Deterministic, dependency-free decoder over in-memory frame payloads (tests + HTTP endpoint)."""

    def __init__(
        self,
        images: Sequence[bytes],
        *,
        source_video: str = "stub://memory",
        width: int = 1920,
        height: int = 1080,
        source_fps: float = 30.0,
    ) -> None:
        self._images: List[bytes] = list(images)
        self.source_video = source_video
        self._width = width
        self._height = height
        self.source_fps = source_fps

    @staticmethod
    def synthetic(count: int, *, seed: int = 7, **kwargs) -> "StubFrameDecoder":
        """Build `count` deterministic synthetic frames (distinct, non-empty byte payloads)."""
        images = [bytes(((seed + i * 31 + j) % 251 for j in range(64))) for i in range(count)]
        return StubFrameDecoder(images, **kwargs)

    def decode(self) -> Iterator[Frame]:
        for i, image in enumerate(self._images):
            yield Frame(
                index=i,
                timestamp=f"{round(i / self.source_fps, 6)}s",
                source_video=self.source_video,
                original_width=self._width,
                original_height=self._height,
                processed_width=self._width,
                processed_height=self._height,
                sampling_rate=1.0,
                image=image,
            )


class IterableFrameDecoder:
    """Yields pre-decoded `Frame`s as-is — lets the CLI decode/sample once and reuse the same frames
    for both analysis and annotation (no double decode)."""

    def __init__(self, frames: Sequence[Frame], *, source_video: str = "memory", source_fps: float = 30.0) -> None:
        self._frames = list(frames)
        self.source_video = source_video
        self.source_fps = source_fps

    def decode(self) -> Iterator[Frame]:
        yield from self._frames


class OpenCvFrameDecoder:
    """Real video decode via OpenCV — integration/CLI only. Lazy `cv2` import; JPEG-encodes frames."""

    def __init__(
        self,
        path: str,
        *,
        resize_long_side: Optional[int] = None,
        jpeg_quality: int = 85,
    ) -> None:
        self.source_video = path
        self._resize_long_side = resize_long_side
        self._jpeg_quality = jpeg_quality
        self.source_fps = 0.0  # filled on decode()

    def decode(self) -> Iterator[Frame]:
        import cv2  # noqa: WPS433 - HEAVY, integration-only

        cap = cv2.VideoCapture(self.source_video)
        if not cap.isOpened():
            raise FileNotFoundError(f"cannot open video: {self.source_video}")
        self.source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0) or 30.0
        try:
            index = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                oh, ow = int(frame.shape[0]), int(frame.shape[1])
                pw, ph = ow, oh
                if self._resize_long_side and max(ow, oh) > self._resize_long_side:
                    scale = self._resize_long_side / float(max(ow, oh))
                    pw, ph = int(ow * scale), int(oh * scale)
                    frame = cv2.resize(frame, (pw, ph))
                ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, self._jpeg_quality])
                if not ok:
                    continue
                yield Frame(
                    index=index,
                    timestamp=f"{round(index / self.source_fps, 6)}s",
                    source_video=self.source_video,
                    original_width=ow,
                    original_height=oh,
                    processed_width=pw,
                    processed_height=ph,
                    sampling_rate=1.0,
                    image=bytes(buf.tobytes()),
                )
                index += 1
        finally:
            cap.release()
