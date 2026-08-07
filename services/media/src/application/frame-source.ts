/**
 * The **general frame source port** (P-8 Phase 8, slice 2).
 *
 * ### Why this exists, and why it is not a second decoder
 *
 * The media service already decodes: `Decoder.open(conn: StreamConnection, …)` drives ffmpeg for a
 * live camera. It cannot serve offline analysis unchanged, for one reason that is worth stating
 * precisely rather than working around:
 *
 * ⛔ **`StreamConnection.protocol` is `CameraProtocol`, which is `['rtsp','rtmp']` and frozen.** A
 * stored recording is not either. Widening that enum would give a *camera* the protocol `"file"` —
 * a Camera-context concept bent to serve the Media context, breaking every exhaustive switch over it
 * for the benefit of one caller. So the frozen contract stays exactly as it is.
 *
 * ⭐ **`FrameSource` is the generalisation `Decoder` was one step away from**: something that yields
 * frames and can be stopped. `Decoder` remains the live implementation, unchanged and still driving
 * every camera; a stored-media implementation joins it. The two share the ffmpeg invocation where it
 * matters and differ only in what they open and whether they write recording segments.
 *
 * ⚠️ **It is an application port, not a contract.** Nothing crosses a service boundary here, so
 * adding a source is a class in this directory rather than a negotiation — which is the whole point
 * of the seam. Future sources this shape already holds: NVR and DVR exports (a stored object with a
 * vendor container), a camera's own recorded segments (a key range this service already owns), USB
 * and ONVIF (a live descriptor the existing decoder already understands).
 */
import type { Frame } from './ports.js';

/** What a source is asked to produce. All times are **footage** time, never wall clock. */
export interface FrameRequest {
  /** Where in the recording to start. `0` is the first frame. */
  fromOffsetSeconds: number;
  /**
   * How much footage to produce before stopping.
   *
   * ⭐ Chunking is what buys progress that moves, cancellation that lands within a second, and a
   * checkpoint to resume from. A source that ignores it and runs to the end is correct but gives an
   * operator a four-hour progress bar with two positions.
   */
  durationSeconds: number;
  /** Frames of footage per second to emit. */
  frameRate: number;
}

/** What one chunk produced. ⚠️ Counts, never pixels — the frames went to the sink as they came. */
export interface FrameChunkResult {
  /** Frames emitted in this chunk. */
  framesEmitted: number;
  /** Footage offset reached. ⭐ The next chunk's `fromOffsetSeconds`, and the resume checkpoint. */
  reachedOffsetSeconds: number;
  /**
   * Whether the source ran out of footage inside this chunk.
   *
   * ⚠️ **The only reliable end-of-file signal.** A container's declared duration and the frames it
   * actually yields disagree often enough — truncated recordings, fragmented mp4, a stream copy that
   * lost its last GOP — that trusting the duration would end an analysis early or spin it forever.
   */
  reachedEnd: boolean;
}

/**
 * A source of frames from one piece of media, for one session.
 *
 * ⚠️ **`read` is called repeatedly, once per chunk**, and must be safe to call again after a
 * cancellation or a process restart — that is what makes a session resumable. Implementations must
 * therefore hold no cross-chunk state that changes the answer; the offset in the request is the
 * whole of the position.
 */
export interface FrameSource {
  /** Produce one chunk, handing each frame to `onFrame` as it is decoded. */
  read(
    request: FrameRequest,
    onFrame: (frame: Frame) => void,
    signal: AbortSignal,
  ): Promise<FrameChunkResult>;
  /** Release anything held. Safe to call more than once. */
  close(): Promise<void>;
}

/** Opens a `FrameSource` for a session's media. One implementation per `AnalysisSourceKind`. */
export interface FrameSourceFactory {
  open(input: { tenantId: string; assetKey: string; contentType: string }): Promise<FrameSource>;
}
