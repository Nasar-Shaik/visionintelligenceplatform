/**
 * Application: **live frame ingest** — a frame producer that is not a decoder (P-9, slice 1).
 *
 * ### ⭐ Why this is not a second pipeline, stated precisely
 *
 * Everything a live camera's frames go through already exists and is reached through exactly one
 * door: `FrameSink.push()`. The assignment gate says so in its own header — *"It is consulted from
 * `FrameSink.push()`, which is downstream of the decoder"* — and so do the runtime call, the zone
 * capture, the tracker, the event publisher and every rule after it.
 *
 * This module produces frames and hands them to that same door, one line below where
 * `StreamSupervisor` hands off the decoder's. **Nothing downstream can tell the two apart**, which
 * is the whole design: adding a source must never mean adding a pipeline.
 *
 * ### ⛔ Why it is not a `FrameSource`, which is what a reader will expect
 *
 * `FrameSource` is the **offline** port. Its input demands `assetKey`, `contentType` and
 * `footageStartedAt`; its `read()` takes `fromOffsetSeconds` + `durationSeconds` and must be
 * resumable from a checkpoint after a restart. Every one of those is a statement about *footage
 * time in a file that already exists*. A live camera has no asset, no offset, no end and nothing to
 * resume — implementing one against that interface means inventing four values that have no meaning
 * and then keeping them true forever.
 *
 * ⚠️ The live port is `Decoder`, and this is deliberately not one of those either: `Decoder.open`
 * takes a `StreamConnection`, whose `protocol` is `CameraProtocol` — frozen at `['rtsp','rtmp']`.
 * `frame-source.ts` already argued why widening that enum for a non-network source is the wrong
 * trade. So this producer resolves no connection and touches no contract.
 *
 * ### ⛔ The clock, and why the client does not own it
 *
 * A frame carries `at`, and `at` becomes an event's `occurredAt`, which becomes an incident's time,
 * which is what a customer takes to an insurer. The capture agent sends `capturedAt` and **it is
 * never used as `at`** — it is kept only to measure end-to-end latency. `at` is this service's own
 * clock, the same clock every other camera's frames are stamped with.
 *
 * A client-supplied evidentiary timestamp would let anything holding a token place a person
 * somewhere at a time of its choosing. That is not a clock-skew concern; it is a forgery surface.
 */
import type { Frame, FrameSink } from './ports.js';
import { badRequest, notFound } from './errors.js';

/** A frame held for evidence. ⚠️ Bounded — see `RING_FRAMES`. */
interface HeldFrame {
  seq: number;
  atMs: number;
  data: Uint8Array;
}

export interface LiveIngestSessionInput {
  tenantId: string;
  cameraId: string;
  /** What the agent intends to send. Recorded for the report; not enforced. */
  frameRate: number;
  width?: number | undefined;
  height?: number | undefined;
  /** Free text naming the capture agent, e.g. `browser-webcam`. Provenance for the validation. */
  agent?: string | undefined;
}

export interface LiveIngestSessionView {
  sessionId: string;
  tenantId: string;
  cameraId: string;
  agent: string;
  frameRate: number;
  width: number | null;
  height: number | null;
  startedAt: string;
  lastFrameAt: string | null;
  framesAccepted: number;
  /** ⚠️ Frames refused before the sink — a wrong content type, an empty body, a closed session. */
  framesRejected: number;
  /** Mean transport age (ms) from the agent's `capturedAt` to arrival here. `null` until measured. */
  arrivalLagMsAvg: number | null;
}

export interface LiveIngestAcceptance {
  seq: number;
  /** ⭐ The platform's clock, which is the only one that counts. */
  at: string;
  /** How long the frame spent getting here, when the agent said when it was captured. */
  arrivalLagMs: number | null;
}

/**
 * How many recent frames to hold per camera for evidence.
 *
 * ⚠️ **Bounded on purpose and small.** At 4 fps this is ten seconds of history, ~2.5 MB of JPEG for
 * one camera. An incident is raised within a frame or two of the detection that caused it, so ten
 * seconds is generous; an unbounded buffer would trade a real memory leak for history nobody reads.
 */
const RING_FRAMES = 40;

/** Sessions idle longer than this are reaped — a browser tab that closed without saying so. */
const IDLE_TIMEOUT_MS = 60_000;

interface Session extends LiveIngestSessionView {
  seq: number;
  ring: HeldFrame[];
  lagSamples: number[];
  /** Set by `close()`. A closed session refuses frames and keeps its ring until reaped. */
  closedAt?: string;
}

const keyOf = (tenantId: string, cameraId: string): string => `${tenantId}:${cameraId}`;

/**
 * Accepts frames from a capture agent and pushes them into the live perception path.
 *
 * ⚠️ **One session per camera.** A second agent claiming a camera that already has one replaces it
 * and restarts the sequence, which is exactly what the assignment gate's session-epoch handling
 * expects of a restarted stream — see its header on the re-enabled camera that published 0 events.
 */
export class LiveIngest {
  readonly #sink: FrameSink;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #sessions = new Map<string, Session>();

  constructor(deps: { sink: FrameSink; now?: () => Date; newId?: () => string }) {
    this.#sink = deps.sink;
    this.#now = deps.now ?? (() => new Date());
    this.#newId =
      deps.newId ?? (() => `lis_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`);
  }

  open(input: LiveIngestSessionInput): LiveIngestSessionView {
    if (!Number.isFinite(input.frameRate) || input.frameRate <= 0 || input.frameRate > 60) {
      throw badRequest('frameRate must be between 0 and 60');
    }
    const startedAt = this.#now();
    const session: Session = {
      sessionId: this.#newId(),
      tenantId: input.tenantId,
      cameraId: input.cameraId,
      agent: input.agent ?? 'unknown',
      frameRate: input.frameRate,
      width: input.width ?? null,
      height: input.height ?? null,
      startedAt: startedAt.toISOString(),
      lastFrameAt: null,
      framesAccepted: 0,
      framesRejected: 0,
      arrivalLagMsAvg: null,
      seq: 0,
      ring: [],
      lagSamples: [],
    };
    this.#sessions.set(keyOf(input.tenantId, input.cameraId), session);
    return view(session);
  }

  /**
   * Accept one frame and push it at the live sink.
   *
   * ⚠️ **Returns as soon as the sink has it.** `push()` is fire-and-forget by contract — it never
   * awaits and never applies back-pressure, absorbing a slow runtime by dropping frames instead. So
   * a `200` here means *accepted for perception*, not *analysed*, and the agent is told the sequence
   * number rather than a result. Anything stronger would be a promise this path cannot keep.
   */
  frame(
    tenantId: string,
    cameraId: string,
    data: Uint8Array,
    capturedAtMs?: number,
  ): LiveIngestAcceptance {
    const session = this.#require(tenantId, cameraId);
    if (session.closedAt !== undefined) {
      session.framesRejected += 1;
      throw badRequest('this live ingest session has been closed — open a new one');
    }
    if (data.byteLength === 0) {
      session.framesRejected += 1;
      throw badRequest('the frame carried no bytes');
    }
    const at = this.#now();
    session.seq += 1;
    session.framesAccepted += 1;
    session.lastFrameAt = at.toISOString();

    let arrivalLagMs: number | null = null;
    /* ⚠️ Only believed when it is not in the future and not absurdly old — a wrong client clock
     * must not poison the latency figure the validation reports. */
    if (capturedAtMs !== undefined && Number.isFinite(capturedAtMs)) {
      const lag = at.getTime() - capturedAtMs;
      if (lag >= 0 && lag < 30_000) {
        arrivalLagMs = lag;
        session.lagSamples.push(lag);
        if (session.lagSamples.length > 200) session.lagSamples.shift();
        session.arrivalLagMsAvg =
          session.lagSamples.reduce((a, b) => a + b, 0) / session.lagSamples.length;
      }
    }

    session.ring.push({ seq: session.seq, atMs: at.getTime(), data });
    if (session.ring.length > RING_FRAMES) session.ring.shift();

    const frame: Frame = { seq: session.seq, at, data };
    this.#sink.push(tenantId, cameraId, frame);

    return { seq: session.seq, at: at.toISOString(), arrivalLagMs };
  }

  /**
   * The held frame nearest an instant — what an incident's evidence is cut from.
   *
   * ⭐ **This is why the ring exists.** An ingested stream writes no MP4 segments, so there is no
   * recording to extract a clip from later; if the frame is not kept at the moment it arrives, the
   * evidence for a live incident is gone. Returns `undefined` rather than the closest-at-any-distance
   * so a caller can never present a frame from a different minute as the moment in question.
   */
  nearestFrame(
    tenantId: string,
    cameraId: string,
    atMs: number,
    toleranceMs = 2_000,
  ): { data: Uint8Array; seq: number; at: string; deltaMs: number } | undefined {
    const session = this.#sessions.get(keyOf(tenantId, cameraId));
    if (session === undefined) return undefined;
    let best: HeldFrame | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const held of session.ring) {
      const delta = Math.abs(held.atMs - atMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = held;
      }
    }
    if (best === undefined || bestDelta > toleranceMs) return undefined;
    return {
      data: best.data,
      seq: best.seq,
      at: new Date(best.atMs).toISOString(),
      deltaMs: bestDelta,
    };
  }

  /**
   * Stop accepting frames — **and keep the held ones**.
   *
   * ⛔ **Found by using it.** The first version deleted the session outright, which threw the frame
   * ring away at the same instant. An agent that stops capturing and closes immediately does so
   * *microseconds* after its last frame, and the incident raised from that frame is created
   * asynchronously afterwards — so the evidence for the last thing the camera saw was reliably the
   * evidence that no longer existed. A closed session therefore lingers with its frames until the
   * idle reaper takes it, and only refuses new ones.
   */
  close(tenantId: string, cameraId: string): LiveIngestSessionView {
    const session = this.#require(tenantId, cameraId);
    session.closedAt = this.#now().toISOString();
    return view(session);
  }

  /**
   * Every OPEN live session for a tenant. ⚠️ Reaps the idle ones first, so the list is not fiction,
   * and excludes closed ones — they linger only so their frames stay reachable for evidence, and a
   * closed camera listed as live would be a worse lie than omitting it.
   */
  list(tenantId: string): LiveIngestSessionView[] {
    this.reapIdle();
    return [...this.#sessions.values()]
      .filter((s) => s.tenantId === tenantId && s.closedAt === undefined)
      .map((s) => view(s));
  }

  get(tenantId: string, cameraId: string): LiveIngestSessionView | undefined {
    const session = this.#sessions.get(keyOf(tenantId, cameraId));
    return session === undefined ? undefined : view(session);
  }

  /**
   * Drop sessions whose agent stopped sending.
   *
   * ⛔ A browser tab that is closed sends no `close`. Without this the session list grows for ever
   * and each dead entry keeps `RING_FRAMES` of JPEG alive — a leak whose size is set by how often
   * someone demonstrates the product.
   */
  reapIdle(nowMs = this.#now().getTime()): number {
    let reaped = 0;
    for (const [key, session] of this.#sessions) {
      const last = session.lastFrameAt ?? session.startedAt;
      if (nowMs - Date.parse(last) > IDLE_TIMEOUT_MS) {
        this.#sessions.delete(key);
        reaped += 1;
      }
    }
    return reaped;
  }

  #require(tenantId: string, cameraId: string): Session {
    const session = this.#sessions.get(keyOf(tenantId, cameraId));
    if (session === undefined) {
      throw notFound(`no live ingest session is open for camera ${cameraId}`);
    }
    return session;
  }
}

function view(s: Session): LiveIngestSessionView {
  return {
    sessionId: s.sessionId,
    tenantId: s.tenantId,
    cameraId: s.cameraId,
    agent: s.agent,
    frameRate: s.frameRate,
    width: s.width,
    height: s.height,
    startedAt: s.startedAt,
    lastFrameAt: s.lastFrameAt,
    framesAccepted: s.framesAccepted,
    framesRejected: s.framesRejected,
    arrivalLagMsAvg: s.arrivalLagMsAvg === null ? null : Math.round(s.arrivalLagMsAvg),
  };
}
