"""Stream Pipeline (AI-5b) — the live counterpart of batch analysis.

Batch analysis can materialize a video into a list. A live camera cannot: it is unbounded, it runs
faster or slower than inference, and it must degrade *gracefully* rather than grow without bound. This
module owns exactly that boundary — the queue between acquisition and analysis, the lifetime of a
frame while it sits there, and the policy for what to throw away under pressure.

**Ownership** (Architect AI-5b refinement 2 — no overlap between tiers):

    StreamSource     owns  connection · reconnect · frame acquisition
    StreamPipeline   owns  queue · frame lifecycle · drop policy      ← THIS MODULE
    VideoAnalyzer    owns  AI processing only
    SessionRunner    owns  orchestration only

So this module never connects, never reconnects, and never performs inference. It hands each admitted
frame to `VideoAnalyzer.analyze_frame` and owns everything around that call.

**Two kinds of frame loss, never conflated** (the distinction the Architect endorsed in AI-5a):

  - `framesSkipped` — the sampler deliberately down-sampled to the target FPS. An **execution policy**.
    Perfect health. A 30 fps camera analyzed at 5 fps skips 83% of frames by design.
  - `framesDropped` — the bounded queue overflowed because analysis could not keep up. **Real
    degradation**, and the number that belongs in an SLO.

**Frame lifecycle** (refinement 1): `Frame` is a frozen dataclass, so a frame is immutable once
decoded. The pipeline owns its *lifetime* — it holds a reference only from enqueue to the end of
analysis, then releases it, so a stopped session leaves nothing behind (refinement 8).

**Backpressure observability** (refinement 3): depth alone hides both peaks and sustained pressure, so
the queue also reports a high-water mark, utilization, average depth, and enqueue→analysis delay.

Deterministic + stdlib-only: clock injected; producer/consumer are separate methods, so tests drive
overflow exactly without threads or timing luck.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Deque, Optional, Tuple

from errors import ConfigurationFailure, failure_category
from operational_log import OperationalLog, SessionIdentity, null_log
from video_analyzer import FlushResult, FrameAnalysis, VideoAnalyzer
from video_frame import Frame
from video_sampler import FrameSampler

# Drop policy under saturation.
DROP_OLDEST = "drop-oldest"  # discard the stalest frame — live video wants recency
DROP_NEWEST = "drop-newest"  # discard the arriving frame — preserves temporal continuity
DROP_POLICIES = (DROP_OLDEST, DROP_NEWEST)


class BoundedFrameQueue:
    """A bounded queue of `(frame, enqueued_at)` with an explicit drop policy and the tuning metrics
    an operator sizes a deployment with.

    `drop-oldest` is the default because for live perception the freshest frame is the most valuable:
    when inference falls behind, analyzing a 3-second-old frame serves nobody. `drop-newest` is
    offered for workloads where temporal continuity matters more than recency (e.g. tracking through a
    brief stall).
    """

    def __init__(
        self,
        capacity: int = 32,
        *,
        policy: str = DROP_OLDEST,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if capacity < 1:
            raise ConfigurationFailure(f"queue capacity must be >= 1, got {capacity}")
        if policy not in DROP_POLICIES:
            raise ConfigurationFailure(f"unknown drop policy '{policy}' (expected one of {DROP_POLICIES})")
        self.capacity = int(capacity)
        self.policy = policy
        self._clock = clock
        self._items: Deque[Tuple[Frame, float]] = deque()
        self.dropped = 0
        self.high_watermark = 0
        self._depth_observations = 0
        self._depth_total = 0

    def __len__(self) -> int:
        return len(self._items)

    @property
    def depth(self) -> int:
        return len(self._items)

    @property
    def utilization(self) -> float:
        """Current depth as a percentage of capacity."""
        return 100.0 * len(self._items) / self.capacity

    @property
    def average_depth(self) -> float:
        return self._depth_total / self._depth_observations if self._depth_observations else 0.0

    def offer(self, frame: Frame) -> bool:
        """Enqueue a frame. Returns False when the frame (or one already queued) had to be dropped —
        i.e. genuine backpressure loss, which the caller reports as degradation."""
        dropped = False
        if len(self._items) >= self.capacity:
            self.dropped += 1
            dropped = True
            if self.policy == DROP_OLDEST:
                self._items.popleft()  # release the stalest frame
                self._items.append((frame, self._clock()))
            # DROP_NEWEST: the arriving frame is simply not enqueued.
        else:
            self._items.append((frame, self._clock()))
        self._observe()
        return not dropped

    def poll(self) -> Optional[Tuple[Frame, float]]:
        """Dequeue the next `(frame, enqueued_at)`, or None when empty."""
        if not self._items:
            return None
        item = self._items.popleft()
        self._observe()
        return item

    def clear(self) -> int:
        """Release every queued frame (shutdown path — refinement 8). Returns how many were released."""
        count = len(self._items)
        self._items.clear()
        self._observe()
        return count

    def _observe(self) -> None:
        depth = len(self._items)
        self.high_watermark = max(self.high_watermark, depth)
        self._depth_observations += 1
        self._depth_total += depth


@dataclass
class PipelineOptions:
    """Live-pipeline knobs. All have production-safe defaults; none change perception behavior."""

    queue_capacity: int = 32
    drop_policy: str = DROP_OLDEST
    target_fps: Optional[float] = None
    source_fps: float = 30.0
    # Stop after this many analyzed frames (None = run until the source ends or the session stops).
    max_frames: Optional[int] = None


class StreamPipeline:
    """Owns the queue, the frame lifecycle, and the drop policy between a live source and the analyzer.

    Producer (`offer`) and consumer (`process_next`) are separate operations, so a real deployment can
    run them on different threads while tests drive them by hand and assert overflow behavior exactly —
    no sleeps, no races, no flakes.
    """

    def __init__(
        self,
        analyzer: VideoAnalyzer,
        *,
        options: Optional[PipelineOptions] = None,
        sampler: Optional[FrameSampler] = None,
        clock: Callable[[], float] = time.monotonic,
        log: Optional[OperationalLog] = None,
    ) -> None:
        self._analyzer = analyzer
        self._options = options or PipelineOptions()
        self._clock = clock
        self._log = log or null_log(SessionIdentity("unknown", "unknown", "unattached"))
        # Sampling policy has ONE owner (the sampler); the pipeline only records its tallies.
        self._sampler = sampler or FrameSampler(
            source_fps=self._options.source_fps, target_fps=self._options.target_fps
        )
        self._queue = BoundedFrameQueue(
            self._options.queue_capacity, policy=self._options.drop_policy, clock=clock
        )
        self.frames_processed = 0
        self._delay_total_ms = 0.0
        self._delay_max_ms = 0.0
        self._closed = False
        self._failures: dict = {}

    # --- producer side -----------------------------------------------------------

    def offer(self, frame: Frame) -> bool:
        """Admit a frame from the source: sample (policy) → enqueue (backpressure). Returns True when
        the frame is queued for analysis; False when it was skipped by policy OR dropped under load —
        the two are counted separately and never conflated."""
        admitted = self._sampler.admit(frame)
        if admitted is None:
            return False  # deliberate down-sampling; healthy
        queued = self._queue.offer(admitted)
        if not queued:
            # Genuine degradation: log once per drop with the full session identity (refinement 7).
            self._log.emit(
                "stream.frame_dropped",
                level="warn",
                frameIndex=admitted.index,
                queueDepth=self._queue.depth,
                queueCapacity=self._queue.capacity,
                policy=self._queue.policy,
            )
        return queued

    # --- consumer side -----------------------------------------------------------

    def process_next(self) -> Optional[FrameAnalysis]:
        """Analyze the next queued frame, or return None when the queue is empty.

        A per-frame failure is categorized (`inference` vs `pipeline`) and counted, and the session
        keeps running — one bad frame must never take down a camera (refinement 4).
        """
        item = self._queue.poll()
        if item is None:
            return None
        frame, enqueued_at = item
        delay_ms = max(0.0, (self._clock() - enqueued_at) * 1000.0)
        self._delay_total_ms += delay_ms
        self._delay_max_ms = max(self._delay_max_ms, delay_ms)
        try:
            analysis = self._analyzer.analyze_frame(frame)
        except Exception as exc:  # noqa: BLE001 - classify, count, keep the session alive
            category = failure_category(exc)
            self._failures[category] = self._failures.get(category, 0) + 1
            self._log.failure(exc, event="pipeline.frame_failed", frameIndex=frame.index)
            return None
        finally:
            # The pipeline's reference to the frame ends here; the frame itself was never mutated
            # (`Frame` is frozen), so releasing it cannot affect anything downstream.
            frame = None  # noqa: F841 - explicit release, not a leftover
        self.frames_processed += 1
        return analysis

    def drain(self, on_result: Optional[Callable[[FrameAnalysis], None]] = None) -> int:
        """Analyze everything currently queued. Returns how many frames were analyzed."""
        count = 0
        while True:
            analysis = self.process_next()
            if analysis is None and self._queue.depth == 0:
                return count
            if analysis is not None:
                count += 1
                if on_result is not None:
                    on_result(analysis)

    def run(
        self,
        frames,  # noqa: ANN001 - any iterable/iterator of Frame (a live source is unbounded)
        *,
        on_result: Optional[Callable[[FrameAnalysis], None]] = None,
        should_continue: Optional[Callable[[], bool]] = None,
    ) -> int:
        """Pump an (unbounded) frame iterable through the pipeline until it ends, `max_frames` is
        reached, or `should_continue()` goes False. Returns the number of frames analyzed.

        This is the single-threaded pump: it interleaves offer/process so a slow analyzer applies
        natural backpressure to the source. `SessionRunner` supplies `should_continue` from the session
        lifecycle, which is how pause/stop actually reach the data plane.
        """
        analyzed = 0
        for frame in frames:
            if should_continue is not None and not should_continue():
                break
            self.offer(frame)
            analysis = self.process_next()
            if analysis is not None:
                analyzed += 1
                if on_result is not None:
                    on_result(analysis)
            if self._options.max_frames is not None and self.frames_processed >= self._options.max_frames:
                break
        # Anything still queued when the source ends is still worth analyzing.
        analyzed += self.drain(on_result)
        return analyzed

    # --- lifecycle + observability -----------------------------------------------

    def flush(self) -> FlushResult:
        """Close out behaviors that were still active when the stream ended (delegates to the analyzer;
        the pipeline does not know what a behavior is)."""
        return self._analyzer.flush()

    def close(self) -> int:
        """Release every pipeline-owned resource (refinement 8): queued frames are dropped and the
        queue emptied. Idempotent — a second close is a no-op, so stop/restart/fail all converge on the
        same clean state. Returns the number of frames released."""
        if self._closed:
            return 0
        released = self._queue.clear()
        self._closed = True
        if released:
            self._log.emit("pipeline.closed", releasedFrames=released)
        return released

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def queue(self) -> BoundedFrameQueue:
        return self._queue

    @property
    def average_processing_delay_ms(self) -> float:
        return self._delay_total_ms / self.frames_processed if self.frames_processed else 0.0

    def stats(self) -> dict:
        """A `StreamBackpressureStats`-shaped snapshot (camelCase; mirrors @vip/contracts)."""
        return {
            "framesSkipped": self._sampler.dropped,  # deliberate down-sampling (policy)
            "framesDropped": self._queue.dropped,  # backpressure loss (degradation)
            "framesProcessed": self.frames_processed,
            "queueCapacity": self._queue.capacity,
            "queueDepth": self._queue.depth,
            "queueHighWatermark": self._queue.high_watermark,
            "queueUtilization": round(self._queue.utilization, 3),
            "averageQueueDepth": round(self._queue.average_depth, 3),
            "processingDelayMs": round(self.average_processing_delay_ms, 3),
            "maxProcessingDelayMs": round(self._delay_max_ms, 3),
        }

    def failure_counts(self) -> dict:
        """Per-category failure tallies raised inside the pipeline tier (never ingestion's)."""
        return dict(self._failures)
