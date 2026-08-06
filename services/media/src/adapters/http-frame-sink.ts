/**
 * Adapter: the **perception seam, connected** (P-8 Phase 2, ADR-A — media pushes frames).
 *
 * `NullFrameSink` discarded every frame the decoder produced. This one delivers them to the AI
 * runtime over HTTP and counts what happened to every single one.
 *
 * ### ⚠️ The hard requirement this file exists to honour
 *
 * **Recording must never be affected by perception.** `push()` is called from the decoder's stdout
 * handler, on the same process that is writing MP4 segments; if it ever blocked, awaited, or threw,
 * a slow runtime would turn into missing evidence. So:
 *
 * - `push()` enqueues and returns. It never awaits, never throws, and never applies back-pressure to
 *   the caller — back-pressure is absorbed **here**, by dropping frames, which is the one thing
 *   perception may lose and recording may not.
 * - The queue is **bounded per camera**, not globally. A single global queue lets one busy or one
 *   stalled camera consume every slot, and the frames that get dropped are then somebody else's.
 * - Delivery failures are counted and rate-limited into the log. A runtime that is down produces a
 *   number, not a log flood and not a stalled decoder.
 *
 * ### What is deliberately NOT here
 *
 * No retry. A frame is a perishable observation: by the time a retry lands, a newer frame has been
 * dropped to make room for it. Retrying frames trades fresh data for stale data and costs twice.
 */
import type { PlanZone, ZoneEvaluationStats } from '@vip/contracts';
import type { Frame, FrameSink } from '../application/ports.js';
import type { AssignmentGate } from '../application/assignment-gate.js';
import { ResolveTimer, resolveZones } from '../application/zone-resolver.js';

export interface FrameSinkStats {
  /** Frames handed over by the decoder. */
  offered: number;
  /** Frames the runtime accepted (2xx). */
  delivered: number;
  /** Frames dropped because this camera's queue was full — deliberate policy, not loss. */
  droppedQueueFull: number;
  /** Frames the runtime refused or could not be reached for. */
  failed: number;
  /** ⚠️ Frames that arrived with no pixels. Always zero in a working decoder — a finding if not. */
  droppedNoImage: number;
  /** Requests in flight right now. */
  inflight: number;
  /** Frames waiting, summed across cameras. */
  queueDepth: number;
  /** Cameras with at least one frame queued. */
  activeCameras: number;
  /** Mean transport time (ms) of the last window — request sent → response received. */
  deliverMsAvg: number;
  /** Mean age (ms) of a delivered frame at the moment it was accepted. Queue time is in here. */
  frameAgeMsAvg: number;
  /** Last transport error, redacted to its message. */
  lastError?: string;
  lastErrorAt?: string;

  /* --- what came back (P-8 Phase 3) ---------------------------------------------------------
   * ⚠️ Counts and labels only. Media records **that** a person was seen and never **which** one:
   * no boxes, no crops, no frames. The detections themselves are returned to nobody and stored
   * nowhere — this phase produces detection metadata, and turning it into incidents, alerts or
   * rules belongs to later phases that have somewhere lawful to put it.
   */
  /** Detections across every analysed frame. */
  detections: number;
  /** label → count. Bounded by the model's label space (≤ 90 entries). */
  detectionsByLabel: Record<string, number>;
  /** Analysed frames that produced at least one detection. */
  framesWithDetections: number;
  /** Mean inference time (ms) as reported by the runtime — its clock, not ours. */
  inferenceMsAvg: number;
  /** Mean capture → detection latency (ms) as reported by the runtime. */
  frameLatencyMsAvg: number;
  /** When a detection was last produced. Absent until one is. */
  lastDetectionAt?: string;
  /** What the runtime said it ran, last time it answered. Absent until it does. */
  modelId?: string;
  executionProvider?: string;

  /* --- Camera Processing Assignment (P-8 Phase 6) --------------------------------------------
   * ⚠️ Whether an assignment gate governs this sink at all. A deployment without one analyses every
   * camera, exactly as it did before this milestone; a reader must be able to tell which it is
   * looking at, because "0 skipped" means opposite things in the two cases.
   */
  assignmentEnabled: boolean;
  /**
   * Frames not sent because the camera has no assignment.
   *
   * ⚠️ Its own counter, and deliberately not folded into `droppedQueueFull`. A skipped frame is a
   * decision somebody made; a dropped frame is a symptom. One number for both would make a correctly
   * configured deployment and an overloaded one look identical.
   */
  skippedUnassigned: number;
  /** Frames not sent because an operator paused the camera. Also policy, also its own counter. */
  skippedHeld: number;

  /* --- Detection zones (P-8 Phase 7) ---------------------------------------------------------- */
  /**
   * Zone evaluation on the frame path.
   *
   * ⚠️ `zonesLoaded` is what the enforcement point currently HOLDS, from the plan — so an operator
   * can tell "no zones are configured" from "zones are configured and the plan has not reached this
   * process yet", which are the two explanations for a loitering rule that never fires and have
   * completely different fixes.
   */
  zones: ZoneEvaluationStats;
}

/** Per-camera measurements. ⚠️ Served over the tenant-scoped API — never as Prometheus labels. */
export interface CameraFrameStats {
  offered: number;
  delivered: number;
  failed: number;
  skippedUnassigned: number;
  skippedHeld: number;
  droppedQueueFull: number;
  queueDepth: number;
  /** Mean round trip to the runtime, ms. `null` until one completes — never 0. */
  deliverMsAvg: number | null;
  /** Delivered frames per second over the recent window. `null` until one is delivered. */
  fps: number | null;
  lastFrameAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** The mutable per-camera window behind `CameraFrameStats`. */
interface MutableCameraStats {
  offered: number;
  delivered: number;
  failed: number;
  skippedUnassigned: number;
  skippedHeld: number;
  droppedQueueFull: number;
  deliverMs: Rolling;
  /** Delivery timestamps, for a rolling fps. Trimmed on read. */
  recent: number[];
  lastFrameAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface Queued {
  tenantId: string;
  cameraId: string;
  frame: Frame;
  queuedAt: number;
  /**
   * ⚠️ Where this frame goes, decided at **push** time rather than at send time.
   *
   * A frame already queued when the plan changes goes to the runtime that was current when it was
   * captured. Re-resolving at send time would let a frame captured under one assignment be analysed
   * under another, and the counters would then describe a routing that never happened.
   */
  runtimeUrl: string;
  capabilityId: string;
  runtimeId: string | null;
  /**
   * The camera's detection zones at the moment this frame was admitted (P-8 Phase 7).
   *
   * ⚠️ Captured here for the same reason `runtimeUrl` is: a plan may land during the round trip, and
   * a frame must be scored against the geometry that was configured when it was taken. Otherwise an
   * operator who redraws a zone retroactively changes what happened in the frames already in flight.
   */
  zones: readonly PlanZone[];
}

export interface HttpFrameSinkOptions {
  /** Base URL of the runtime, e.g. `http://inference:8085`. */
  url: string;
  /** Shared service-to-service key (`x-internal-key`). */
  internalKey: string;
  /** Capability the runtime should run the frame through. */
  capabilityId: string;
  /** Frames held per camera before the oldest is dropped. */
  queuePerCamera?: number;
  /** Concurrent requests across all cameras. */
  maxInflight?: number;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  onLog?: (level: 'warn' | 'error' | 'info', msg: string, fields?: Record<string, unknown>) => void;
  /**
   * Where inference results go next (P-8 Phase 5). Absent ⇒ nothing is published, which is the
   * pre-Phase-5 behaviour and a valid deployment.
   *
   * ⚠️ The sink hands the result over and moves on. It never awaits the publisher and never lets a
   * publishing problem reach this path — recording outranks publishing, always.
   */
  publisher?: { publish(result: unknown): void };
  /**
   * The assignment gate (P-8 Phase 6). Absent ⇒ **every camera is analysed**, using the configured
   * URL and capability — the pre-Phase-6 behaviour, and a valid deployment.
   *
   * ⚠️ Absent must not mean "analyse nothing". An upgrade that silently switched AI off for a
   * customer's whole estate until somebody discovered a new control plane would be a worse failure
   * than the one the gate prevents. Turning the gate on is one environment variable, logged at boot.
   */
  gate?: AssignmentGate;
}

/** Mean of a fixed-size ring, so a long-running process cannot grow this unboundedly. */
class Rolling {
  readonly #buf: number[] = [];
  readonly #size: number;
  constructor(size: number) {
    this.#size = size;
  }
  add(v: number): void {
    this.#buf.push(v);
    if (this.#buf.length > this.#size) this.#buf.shift();
  }
  get avg(): number {
    if (this.#buf.length === 0) return 0;
    return this.#buf.reduce((a, b) => a + b, 0) / this.#buf.length;
  }
}

export class HttpFrameSink implements FrameSink {
  readonly #url: string;
  readonly #key: string;
  readonly #capabilityId: string;
  readonly #perCamera: number;
  readonly #maxInflight: number;
  readonly #timeoutMs: number;
  readonly #onLog: HttpFrameSinkOptions['onLog'];
  readonly #publisher: HttpFrameSinkOptions['publisher'];
  readonly #gate: AssignmentGate | undefined;

  /** cameraKey → pending frames (oldest first). */
  readonly #queues = new Map<string, Queued[]>();
  /**
   * The camera served last. ⚠️ Deliberately the **key**, not an index: an index into a key list whose
   * length changes as cameras start and stop points at a different camera the moment one is added,
   * and the first version of this served one camera twice while another waited. A test caught it.
   */
  #lastKey: string | undefined;
  #inflight = 0;
  #pumping = false;

  #offered = 0;
  #delivered = 0;
  #droppedNoImage = 0;
  #droppedQueueFull = 0;
  #failed = 0;
  #skippedUnassigned = 0;
  #skippedHeld = 0;
  /** Per-camera measurements for the tenant-scoped metrics view. */
  readonly #perCameraStats = new Map<string, MutableCameraStats>();
  /** Delivery failures per runtime since the last drain — the `busy` signal for health. */
  readonly #runtimeFailures = new Map<string, number>();
  readonly #deliverMs = new Rolling(200);
  readonly #frameAgeMs = new Rolling(200);
  #lastError: string | undefined;
  #lastErrorAt: string | undefined;
  #lastLoggedAt = 0;

  #detections = 0;
  #framesWithDetections = 0;
  /* --- P-8 Phase 7: zone evaluation ----------------------------------------------------------- */
  #zoneTested = 0;
  /** ⚠️ Memberships, not detections — a subject in two zones counts twice. See `ZoneEvaluationStats`. */
  #zoneInside = 0;
  readonly #zoneResolveMicros = new ResolveTimer();
  readonly #byLabel = new Map<string, number>();
  readonly #inferenceMs = new Rolling(200);
  readonly #frameLatencyMs = new Rolling(200);
  #lastDetectionAt: string | undefined;
  #modelId: string | undefined;
  #executionProvider: string | undefined;

  constructor(opts: HttpFrameSinkOptions) {
    this.#url = opts.url.replace(/\/+$/, '');
    this.#key = opts.internalKey;
    this.#capabilityId = opts.capabilityId;
    this.#perCamera = opts.queuePerCamera ?? 2;
    this.#maxInflight = opts.maxInflight ?? 4;
    this.#timeoutMs = opts.timeoutMs ?? 2000;
    this.#onLog = opts.onLog;
    this.#publisher = opts.publisher;
    this.#gate = opts.gate;
  }

  push(tenantId: string, cameraId: string, frame: Frame): void {
    this.#offered += 1;
    const key = `${tenantId} ${cameraId}`;
    const per = this.#camera(key);
    per.offered += 1;
    /*
     * ⚠️ A frame with no pixels is never sent and never counted as delivered. `Frame.data` is
     * optional in the port, so the alternative is posting an empty image the runtime would happily
     * accept — a delivered count that means nothing is worse than a dropped count that means
     * something.
     */
    if (frame.data === undefined || frame.data.byteLength === 0) {
      this.#droppedNoImage += 1;
      return;
    }

    /*
     * ⚠️ **The assignment gate — the one point where AI is switched on or off for a camera.**
     *
     * It sits here, downstream of the decoder and downstream of the segment writer. An unassigned
     * camera costs a map lookup and a counter; nothing on the recording path is reachable from this
     * branch, which is what makes "disabling AI never interrupts recording" structural rather than
     * a promise anybody has to keep.
     *
     * ⚠️ No gate ⇒ every camera is analysed, exactly as before P-8 Phase 6. An upgrade that
     * silently switched AI off across a customer estate until somebody found a new control plane
     * would be a worse failure than the one the gate prevents.
     */
    let runtimeUrl = this.#url;
    let capabilityId = this.#capabilityId;
    let runtimeId: string | null = null;
    /* ⚠️ No gate ⇒ no zones either. Zones arrive on the plan, and the plan arrives through the gate. */
    let zones: readonly PlanZone[] = [];
    if (this.#gate !== undefined) {
      const decision = this.#gate.decide(tenantId, cameraId);
      if (!decision.deliver) {
        if (decision.reason === 'unassigned') {
          this.#skippedUnassigned += 1;
          per.skippedUnassigned += 1;
        } else {
          this.#skippedHeld += 1;
          per.skippedHeld += 1;
        }
        return;
      }
      runtimeUrl = decision.runtimeUrl.replace(/\/+$/, '');
      capabilityId = decision.capabilityId;
      runtimeId = decision.runtimeId;
      zones = decision.zones;
    }

    let q = this.#queues.get(key);
    if (q === undefined) {
      q = [];
      this.#queues.set(key, q);
    }
    q.push({
      tenantId,
      cameraId,
      frame,
      queuedAt: Date.now(),
      runtimeUrl,
      capabilityId,
      runtimeId,
      zones,
    });
    /*
     * ⚠️ Drop the **oldest**, keep the newest. A perception pipeline that catches up by processing a
     * backlog is looking at what happened a minute ago; the freshest frame is the only one whose
     * answer can still matter.
     */
    while (q.length > this.#perCamera) {
      q.shift();
      this.#droppedQueueFull += 1;
      per.droppedQueueFull += 1;
    }
    void this.#pump();
  }

  /**
   * Drop everything held for a camera whose assignment was released.
   *
   * ⚠️ The queue AND the per-camera window, but **not** the lifetime counters: an operator asking
   * "how many frames has this camera ever had skipped" must not have the answer reset by a restart
   * of its assignment. Only the things that would be wrong to carry into a new session are cleared.
   */
  release(tenantId: string, cameraId: string): void {
    const key = `${tenantId} ${cameraId}`;
    this.#queues.delete(key);
    const per = this.#perCameraStats.get(key);
    if (per !== undefined) {
      per.recent.length = 0;
      per.deliverMs = new Rolling(100);
    }
  }

  /** Per-camera measurements. ⚠️ Tenant-scoped API only — never Prometheus labels. */
  cameraStats(tenantId: string, cameraId: string): CameraFrameStats | undefined {
    const key = `${tenantId} ${cameraId}`;
    const per = this.#perCameraStats.get(key);
    if (per === undefined) return undefined;
    const cutoff = Date.now() - 10_000;
    const recent = per.recent.filter((t) => t >= cutoff);
    return {
      offered: per.offered,
      delivered: per.delivered,
      failed: per.failed,
      skippedUnassigned: per.skippedUnassigned,
      skippedHeld: per.skippedHeld,
      droppedQueueFull: per.droppedQueueFull,
      queueDepth: this.#queues.get(key)?.length ?? 0,
      /* ⚠️ `null`, not 0 — "nothing has completed" and "instant" are different answers. */
      deliverMsAvg: per.delivered === 0 ? null : per.deliverMs.avg,
      fps: recent.length === 0 ? null : recent.length / 10,
      lastFrameAt: per.lastFrameAt,
      lastError: per.lastError,
      lastErrorAt: per.lastErrorAt,
    };
  }

  /** Cameras this sink holds any measurement for, within a tenant. */
  cameras(tenantId: string): string[] {
    const prefix = `${tenantId} `;
    return [...this.#perCameraStats.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  /**
   * Delivery failures per runtime since the last call, and reset.
   *
   * ⚠️ Draining is the point: this feeds the `busy` health signal, which means *failing right now*.
   * A cumulative count would mark a runtime busy for ever after one bad minute.
   */
  drainRuntimeFailures(): Map<string, number> {
    const snapshot = new Map(this.#runtimeFailures);
    this.#runtimeFailures.clear();
    return snapshot;
  }

  #camera(key: string): MutableCameraStats {
    let per = this.#perCameraStats.get(key);
    if (per === undefined) {
      per = {
        offered: 0,
        delivered: 0,
        failed: 0,
        skippedUnassigned: 0,
        skippedHeld: 0,
        droppedQueueFull: 0,
        deliverMs: new Rolling(100),
        recent: [],
        lastFrameAt: null,
        lastError: null,
        lastErrorAt: null,
      };
      this.#perCameraStats.set(key, per);
    }
    return per;
  }

  /** A point-in-time reading. Cheap enough to call from a Prometheus collector. */
  /**
   * What zone evaluation has cost and found (P-8 Phase 7 §Benchmark).
   *
   * ⚠️ `zonesLoaded` and `camerasWithZones` are read from the **gate**, not from a counter this class
   * keeps: they describe the configuration currently in force, and a counter would describe the
   * configuration at some past moment. A stale "12 zones loaded" beside a plan carrying none is
   * exactly the reading that would send somebody looking in the wrong service.
   */
  zoneStats(): ZoneEvaluationStats {
    let zonesLoaded = 0;
    let camerasWithZones = 0;
    for (const zones of this.#gate?.zonesByCamera() ?? []) {
      if (zones.length === 0) continue;
      camerasWithZones += 1;
      zonesLoaded += zones.length;
    }
    return {
      zonesLoaded,
      camerasWithZones,
      detectionsTested: this.#zoneTested,
      insideDetections: this.#zoneInside,
      /* ⚠️ `null` until something has been tested — never 0. See `ResolveTimer`. */
      averageResolveMicros: this.#zoneResolveMicros.average,
    };
  }

  stats(): FrameSinkStats {
    let depth = 0;
    let active = 0;
    for (const q of this.#queues.values()) {
      depth += q.length;
      if (q.length > 0) active += 1;
    }
    return {
      offered: this.#offered,
      delivered: this.#delivered,
      droppedNoImage: this.#droppedNoImage,
      droppedQueueFull: this.#droppedQueueFull,
      failed: this.#failed,
      inflight: this.#inflight,
      queueDepth: depth,
      activeCameras: active,
      deliverMsAvg: this.#deliverMs.avg,
      frameAgeMsAvg: this.#frameAgeMs.avg,
      assignmentEnabled: this.#gate !== undefined,
      skippedUnassigned: this.#skippedUnassigned,
      zones: this.zoneStats(),
      skippedHeld: this.#skippedHeld,
      detections: this.#detections,
      detectionsByLabel: Object.fromEntries(this.#byLabel),
      framesWithDetections: this.#framesWithDetections,
      inferenceMsAvg: this.#inferenceMs.avg,
      frameLatencyMsAvg: this.#frameLatencyMs.avg,
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
      ...(this.#lastErrorAt !== undefined ? { lastErrorAt: this.#lastErrorAt } : {}),
      ...(this.#lastDetectionAt !== undefined ? { lastDetectionAt: this.#lastDetectionAt } : {}),
      ...(this.#modelId !== undefined ? { modelId: this.#modelId } : {}),
      ...(this.#executionProvider !== undefined
        ? { executionProvider: this.#executionProvider }
        : {}),
    };
  }

  /** Take one frame, fairly: resume scanning after whichever camera was served last. */
  #take(): Queued | undefined {
    const keys = [...this.#queues.keys()];
    if (keys.length === 0) return undefined;
    const start = this.#lastKey === undefined ? 0 : keys.indexOf(this.#lastKey) + 1;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[(start + i) % keys.length] as string;
      const q = this.#queues.get(key);
      if (q !== undefined && q.length > 0) {
        this.#lastKey = key;
        return q.shift();
      }
    }
    return undefined;
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#inflight < this.#maxInflight) {
        const next = this.#take();
        if (next === undefined) break;
        this.#inflight += 1;
        void this.#send(next).finally(() => {
          this.#inflight -= 1;
          void this.#pump();
        });
      }
    } finally {
      this.#pumping = false;
    }
  }
  async #send(item: Queued): Promise<void> {
    const started = Date.now();
    const key = `${item.tenantId} ${item.cameraId}`;
    const per = this.#camera(key);
    try {
      /*
       * ⚠️ The URL and capability come off the QUEUED ITEM, not off the sink. That is what makes a
       * multi-runtime deployment work: two cameras in the same process, in the same pump, can be
       * analysed by different containers under different profiles.
       */
      const res = await fetch(`${item.runtimeUrl}/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': this.#key },
        body: JSON.stringify({
          capabilityId: item.capabilityId,
          context: { tenantId: item.tenantId },
          frame: {
            cameraId: item.cameraId,
            seq: item.frame.seq,
            capturedAt: item.frame.at.toISOString(),
            source: 'media',
          },
          imageBase64: Buffer.from(item.frame.data ?? new Uint8Array()).toString('base64'),
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        // Drain the body so the socket is reusable, then record why.
        const text = await res.text().catch(() => '');
        this.#fail(`runtime answered ${res.status}: ${text.slice(0, 200)}`, item, per);
        return;
      }
      const body = await res.text();
      const now = Date.now();
      this.#delivered += 1;
      this.#deliverMs.add(now - started);
      this.#frameAgeMs.add(now - item.frame.at.getTime());
      per.delivered += 1;
      per.deliverMs.add(now - started);
      per.lastFrameAt = new Date(now).toISOString();
      per.recent.push(now);
      /* Bounded: the fps window is 10 s, so anything older can never be counted again. */
      if (per.recent.length > 200) per.recent.splice(0, per.recent.length - 200);
      this.#gate?.delivered(item.tenantId, item.cameraId);
      this.#record(body, item.zones);
    } catch (err) {
      this.#fail(err instanceof Error ? err.message : String(err), item, per);
    }
  }

  /**
   * Account for what the runtime returned.
   *
   * ⚠️ **Never throws, and a body it cannot read is not a delivery failure.** The frame *was*
   * delivered; only our accounting of the answer failed. Counting that as `failed` would report a
   * transport problem that did not happen and hide the parsing one that did.
   */
  #record(body: string, zones: readonly PlanZone[] = []): void {
    let data: unknown;
    try {
      data = (JSON.parse(body) as { data?: unknown }).data;
    } catch {
      return;
    }
    if (typeof data !== 'object' || data === null) return;

    /*
     * ⚠️ **Zones are stamped BEFORE the publish**, and this ordering is load-bearing rather than
     * incidental. The publisher hands the result to the broker synchronously; a detection that left
     * here without its zone attribute produces an event with no `zoneId`, and a zone-scoped loitering
     * rule then declines it at the scope stage — silently, correctly, and for ever.
     *
     * ⚠️ The zones come from the **queued item**, captured when the frame was admitted, not from the
     * gate as it stands now. A plan may have landed during the round trip. See `GateDecision.zones`.
     */
    const detections = (data as { detections?: unknown }).detections;
    if (zones.length > 0 && Array.isArray(detections)) {
      const startedAt = performance.now();
      const resolved = resolveZones(
        detections as { bbox: [number, number, number, number] }[],
        zones,
      );
      this.#zoneResolveMicros.add((performance.now() - startedAt) * 1000);
      this.#zoneTested += resolved.tested;
      this.#zoneInside += resolved.inside;
    }

    /*
     * ⚠️ Handed over BEFORE this method's own accounting, and deliberately.
     *
     * The publisher is synchronous, never throws and never awaits, so ordering between these two is
     * a free choice — and publishing first means a change to the label-counting code below can never
     * silently stop events from flowing. The dependency that matters (recording is unaffected) is
     * enforced inside the publisher, not by where it is called.
     *
     * ⚠️ **The result is passed WHOLE.** The narrow view below exists for media's own metrics; the
     * publisher validates the full object against the frozen `DetectionResult` contract and refuses
     * anything that does not parse. Passing the narrow view would have quietly stripped the tracking
     * identity that ADR-0041 exists to carry.
     */
    this.#publisher?.publish(data);

    const result = data as {
      detections?: unknown;
      inferenceMs?: unknown;
      frameLatencyMs?: unknown;
      executionProvider?: unknown;
      model?: { id?: unknown; name?: unknown };
    };
    if (typeof result.inferenceMs === 'number') this.#inferenceMs.add(result.inferenceMs);
    if (typeof result.frameLatencyMs === 'number') this.#frameLatencyMs.add(result.frameLatencyMs);
    if (typeof result.executionProvider === 'string') {
      this.#executionProvider = result.executionProvider;
    }
    const modelId = result.model?.id ?? result.model?.name;
    if (typeof modelId === 'string') this.#modelId = modelId;

    if (!Array.isArray(result.detections) || result.detections.length === 0) return;
    this.#detections += result.detections.length;
    this.#framesWithDetections += 1;
    this.#lastDetectionAt = new Date().toISOString();
    for (const detection of result.detections) {
      const label = (detection as { label?: unknown }).label;
      if (typeof label !== 'string' || label === '') continue;
      /*
       * ⚠️ Bounded by the model's label space, which the catalogue caps at 90. The guard is here
       * anyway: an unbounded label map arriving from a future model would turn this counter into a
       * memory leak on the one process that must never run out of memory.
       */
      if (!this.#byLabel.has(label) && this.#byLabel.size >= 128) continue;
      this.#byLabel.set(label, (this.#byLabel.get(label) ?? 0) + 1);
    }
  }

  #fail(message: string, item?: Queued, per?: MutableCameraStats): void {
    this.#failed += 1;
    this.#lastError = message;
    this.#lastErrorAt = new Date().toISOString();
    if (per !== undefined) {
      per.failed += 1;
      per.lastError = message;
      per.lastErrorAt = this.#lastErrorAt;
    }
    if (item !== undefined) {
      /*
       * ⚠️ Attributed to the RUNTIME, which is what turns a delivery failure into a health signal.
       * A runtime that answers `/health` and cannot analyse a frame is `busy`, and that distinction
       * is only available here — the health poller never sends a frame.
       */
      if (item.runtimeId !== null) {
        this.#runtimeFailures.set(
          item.runtimeId,
          (this.#runtimeFailures.get(item.runtimeId) ?? 0) + 1,
        );
      }
      this.#gate?.failed(item.tenantId, item.cameraId, message, Date.now());
    }
    /*
     * ⚠️ Rate-limited to one line a minute. A runtime that is down fails once per frame per camera —
     * at 2 fps across 16 cameras that is ~1 900 lines a minute, which buries the line that says why.
     */
    const now = Date.now();
    if (now - this.#lastLoggedAt > 60_000) {
      this.#lastLoggedAt = now;
      this.#onLog?.('warn', 'perception delivery failing', {
        error: message,
        failed: this.#failed,
        delivered: this.#delivered,
      });
    }
  }
}
