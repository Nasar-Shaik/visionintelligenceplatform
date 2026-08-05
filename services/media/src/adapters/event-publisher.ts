/**
 * Adapter: the **Event Publisher** — the bridge from perception to the event platform (P-8 Phase 5).
 *
 * ### ⚠️ What was missing, and why nothing looked broken
 *
 * Everything downstream of a published `DetectionResult` has worked since P1-5: `services/events`
 * normalizes one into `EventEnvelope`s, deduplicates, persists and republishes; `services/rules`
 * evaluates those and emits `IncidentCandidate`s. **Nobody published.** Media received the result
 * from `/infer`, counted labels for its own metrics, and dropped it — so a platform with a working
 * rule engine could not raise an incident from a camera, and no test failed, because every part in
 * isolation was correct.
 *
 * This is that one publish, built as a subsystem rather than a line of code, because everything it
 * touches is load-bearing.
 *
 * ### ⚠️ Recording outranks publishing, always
 *
 * `publish()` is reached from the decoder's response handler, on the process writing MP4 segments.
 * The frame sink's rule applies unchanged and is the reason this class exists at all:
 *
 * - it **enqueues and returns** — never awaits, never throws, never applies back-pressure upward;
 * - the queue is **bounded per camera**, so one busy or stalled camera cannot consume the slots that
 *   belong to another;
 * - under pressure **events are dropped and counted**. Events are the thing that may be lost.
 *   Recording is not.
 *
 * ### ⚠️ Ordering is enforced here, and it has to be
 *
 * The frame sink keeps up to four requests in flight, so responses arrive **out of order** — this is
 * measured, not theoretical. A result older than one already published for that camera is dropped
 * and counted, exactly as `RuntimeTracker` already drops out-of-order frames. Two reasons:
 *
 *   1. per-camera ordering downstream must be deterministic, and a stale result would break it;
 *   2. the tracker **already skipped** that frame, so its detections carry no track ids at all —
 *      publishing it would emit identity-less events that look like a tracking failure.
 *
 * ### ⚠️ Retry, unlike the frame sink
 *
 * The frame sink deliberately never retries: a frame is perishable, and by the time a retry lands a
 * newer frame has been dropped to make room for it. **An event is not perishable in that way** — it
 * is a record of something that happened, and it may become an incident. So a publish gets a small,
 * bounded number of attempts. Bounded, because an unbounded retry against a down broker converts a
 * broker outage into a memory leak on the one process that must not run out of memory.
 *
 * ### What this does NOT do
 *
 * No rules, no zones, no incidents, no business meaning. It publishes what perception observed, in
 * the platform's one transport envelope's input form (ADR-0040), and stops.
 */
import { DetectionResult } from '@vip/contracts';
import {
  capabilityOutputSubject,
  CAPABILITY_OUTPUT_STREAM,
  ALL_CAPABILITY_OUTPUTS,
} from '@vip/messaging';
import type { EventBus } from '@vip/messaging';

/**
 * ⚠️ The publisher's own version, distinct from the service version and from any schema version.
 * When an operator asks "why did events change shape last Tuesday?", the answer is one of three
 * different version numbers and they must be separately readable.
 */
export const PUBLISHER_VERSION = '1.0.0';

/** Attempts per result, including the first. ⚠️ Bounded — see the header. */
const DEFAULT_MAX_ATTEMPTS = 2;

/** Per-camera queue depth. Bounded per camera, never globally — see the header. */
const DEFAULT_PER_CAMERA = 16;

/** Publishes in flight at once. */
const DEFAULT_MAX_INFLIGHT = 4;

/** A queued publish that waited longer than this is counted as `delayed`. */
const DELAY_BUDGET_MS = 1_000;

export interface EventPublisherStats {
  enabled: boolean;
  /** Results handed to `publish()`. */
  offered: number;
  /** Results published to the bus, acknowledged by the broker. */
  published: number;
  /**
   * Results that failed `DetectionResult` validation and were **never published**.
   *
   * ⚠️ Fail-closed, and this is the number that says so. A malformed result reaching the bus would
   * be dead-lettered by `services/events` — after a broker round trip, in another service's log,
   * where nobody looking at media would find it.
   */
  rejected: number;
  /**
   * Results deliberately not published because they carry **no detections**.
   *
   * ⚠️ Named `suppressed`, not `deduplicated`. The normalizer emits one event per detection, so a
   * result with none produces nothing — publishing it costs a broker round trip for a guaranteed
   * empty outcome. True content deduplication happens downstream in `services/events` and is
   * **that service's metric**; reporting it here under a similar name would be two series with one
   * meaning, which is how a dashboard starts lying.
   */
  suppressed: number;
  /** Results dropped because this camera's queue was full — deliberate policy, not loss. */
  droppedQueueFull: number;
  /**
   * Results dropped because a newer frame from that camera had already been published.
   *
   * ⚠️ Not an error. The runtime answers up to four frames concurrently, so responses genuinely
   * arrive out of order; the tracker already skipped these, so they carry no identity.
   */
  droppedOutOfOrder: number;
  /** Publishes that waited longer than the delay budget before going out. */
  delayed: number;
  /** Retry attempts made (excludes first attempts). */
  retries: number;
  /** Results that exhausted every attempt and were lost. */
  failed: number;
  /** Results waiting, summed across cameras. */
  queueDepth: number;
  /** Cameras with at least one result queued. */
  activeCameras: number;
  /** Publishes in flight right now. */
  inflight: number;
  /** Mean broker publish time (ms) over the recent window. */
  publishMsAvg: number | null;
  /** Events per second over the recent window — ⚠️ null until a window has elapsed. */
  throughputPerSecond: number | null;
  /** Detections published, i.e. how many events the normalizer will produce. */
  detectionsPublished: number;
  /**
   * Whether the last publish attempt reached the broker.
   *
   * ⚠️ `'unknown'` until something has been attempted, never `'up'`. A publisher that has published
   * nothing has not demonstrated a working broker, and rendering that as healthy is the failure the
   * whole metrics discipline exists to prevent (ADR-0039).
   */
  brokerStatus: 'unknown' | 'up' | 'down';
  lastPublishedAt?: string;
  lastPublishedCamera?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** The `DetectionResult` schema version last seen on the wire — reported, never assumed. */
  payloadSchemaVersion?: string;
  publisherVersion: string;
}

interface Queued {
  tenantId: string;
  cameraId: string;
  capabilityId: string;
  seq: number;
  result: unknown;
  detections: number;
  queuedAt: number;
}

/** A small mean over a sliding window — the same shape the frame sink uses. */
class Window {
  #values: number[] = [];
  readonly #size: number;
  constructor(size = 64) {
    this.#size = size;
  }
  add(value: number): void {
    this.#values.push(value);
    if (this.#values.length > this.#size) this.#values.shift();
  }
  /** ⚠️ `null`, not 0, when nothing has been measured (ADR-0039). */
  get avg(): number | null {
    if (this.#values.length === 0) return null;
    return this.#values.reduce((a, b) => a + b, 0) / this.#values.length;
  }
}

export interface EventPublisherOptions {
  bus: EventBus;
  /** Off unless explicitly enabled, so a deployment opts in rather than discovers this. */
  enabled?: boolean;
  perCamera?: number;
  maxInflight?: number;
  maxAttempts?: number;
  onLog?: (level: 'warn' | 'error' | 'info', msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
}

export class BufferedEventPublisher {
  readonly #bus: EventBus;
  readonly #enabled: boolean;
  readonly #perCamera: number;
  readonly #maxInflight: number;
  readonly #maxAttempts: number;
  readonly #onLog: EventPublisherOptions['onLog'];
  readonly #now: () => number;

  readonly #queues = new Map<string, Queued[]>();
  /** ⚠️ Per (tenant, camera). The highest frame seq already published — the ordering gate. */
  readonly #lastSeq = new Map<string, number>();
  #lastKey: string | undefined;
  #pumping = false;
  #inflight = 0;
  #streamReady: Promise<void> | undefined;

  #offered = 0;
  #published = 0;
  #rejected = 0;
  #suppressed = 0;
  #droppedQueueFull = 0;
  #droppedOutOfOrder = 0;
  #delayed = 0;
  #retries = 0;
  #failed = 0;
  #detectionsPublished = 0;
  #brokerStatus: 'unknown' | 'up' | 'down' = 'unknown';
  #lastPublishedAt: string | undefined;
  #lastPublishedCamera: string | undefined;
  #lastError: string | undefined;
  #lastErrorAt: string | undefined;
  #lastLoggedAt = 0;
  #payloadSchemaVersion: string | undefined;
  readonly #publishMs = new Window();
  readonly #throughput: number[] = [];

  constructor(opts: EventPublisherOptions) {
    this.#bus = opts.bus;
    this.#enabled = opts.enabled ?? false;
    this.#perCamera = opts.perCamera ?? DEFAULT_PER_CAMERA;
    this.#maxInflight = opts.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#onLog = opts.onLog;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * Offer one inference result for publication.
   *
   * ⚠️ **Synchronous, never throws, never awaits.** It is called from the frame-response path on the
   * process that writes recordings. Everything expensive happens on the pump.
   */
  publish(raw: unknown): void {
    if (!this.#enabled) return;
    this.#offered += 1;

    /*
     * ⚠️ Validated HERE, against the frozen contract, and rejected rather than published.
     * `services/events` would dead-letter a malformed body — but only after a broker round trip, and
     * the evidence would land in a different service's log. Fail-closed at the producer means the
     * count is visible where the fault is.
     */
    const parsed = DetectionResult.safeParse(raw);
    if (!parsed.success) {
      this.#rejected += 1;
      this.#note('warn', 'refusing to publish an invalid DetectionResult', {
        issue: parsed.error.issues[0]?.message,
      });
      return;
    }
    const result = parsed.data;
    if (result.schemaVersion !== undefined) this.#payloadSchemaVersion = result.schemaVersion;

    /*
     * ⚠️ A result with no detections produces no events, because the normalizer emits one per
     * detection. Publishing it buys a guaranteed-empty outcome at the cost of a broker round trip —
     * and at 2 fps × 16 cameras on a quiet site that is most of the traffic.
     */
    if (result.detections.length === 0) {
      this.#suppressed += 1;
      return;
    }

    /*
     * ⚠️ **The frame's correlation id, stamped here because nothing else can.**
     *
     * The normalizer falls back to `envelope.correlationId = envelope.id` when the result carries
     * none — so every detection in one frame got its OWN correlation chain, and two people walking
     * past a camera together produced two unrelated traces. "Follow this frame through the pipeline"
     * was therefore unanswerable, which is the one thing a correlation id is for.
     *
     * ⚠️ **Deterministic, not a uuid**, and that buys two things: it doubles as the frame's identity
     * (tenant + camera + sequence names one observation exactly), and republishing the same frame
     * produces the same id — so a retry cannot fork the trace.
     */
    const frameId = `${result.tenantId}:${result.cameraId}:${result.frame.seq}`;
    const correlated =
      result.correlationId === undefined ? { ...result, correlationId: frameId } : result;

    const key = `${result.tenantId} ${result.cameraId}`;

    /*
     * ⚠️ The ordering gate. Responses arrive out of order because the sink runs four in flight; a
     * result older than one already published would break per-camera ordering downstream. It is also
     * one the tracker already skipped, so its detections carry no identity — see the header.
     */
    const last = this.#lastSeq.get(key);
    if (last !== undefined && result.frame.seq <= last) {
      this.#droppedOutOfOrder += 1;
      return;
    }
    this.#lastSeq.set(key, result.frame.seq);

    let q = this.#queues.get(key);
    if (q === undefined) {
      q = [];
      this.#queues.set(key, q);
    }
    q.push({
      tenantId: result.tenantId,
      cameraId: result.cameraId,
      capabilityId: result.capabilityId,
      seq: result.frame.seq,
      result: correlated,
      detections: result.detections.length,
      queuedAt: this.#now(),
    });
    /*
     * ⚠️ Drop the OLDEST here, unlike the frame sink which also drops oldest — but for a different
     * reason. A frame is superseded by a newer frame; an event is not superseded by anything. We
     * drop the oldest because holding it would delay every newer event behind it, and a late event
     * is worth less than a timely one to a rule that is watching for something happening now.
     */
    while (q.length > this.#perCamera) {
      q.shift();
      this.#droppedQueueFull += 1;
    }
    void this.#pump();
  }

  /** Cameras this publisher is holding state for. Used by the camera-assignment verification. */
  cameras(tenantId: string): string[] {
    const prefix = `${tenantId} `;
    return [...this.#lastSeq.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .sort();
  }

  /**
   * Release a camera's publisher state.
   *
   * ⚠️ Exists for Camera Processing Assignment (C-14c), which is **not built**. When a camera's AI
   * is switched off, its ordering gate and queue must go with it — otherwise re-enabling the camera
   * later finds a stale `lastSeq` from a previous session and silently drops every event until the
   * new sequence overtakes the old one. Nothing calls this today; the frame path simply stops
   * offering, and the queue drains. It is here so assignment plugs in without a redesign.
   */
  release(tenantId: string, cameraId: string): void {
    const key = `${tenantId} ${cameraId}`;
    this.#queues.delete(key);
    this.#lastSeq.delete(key);
  }

  stats(): EventPublisherStats {
    let depth = 0;
    let active = 0;
    for (const q of this.#queues.values()) {
      depth += q.length;
      if (q.length > 0) active += 1;
    }
    const cutoff = this.#now() - 10_000;
    const recent = this.#throughput.filter((t) => t >= cutoff);
    return {
      enabled: this.#enabled,
      offered: this.#offered,
      published: this.#published,
      rejected: this.#rejected,
      suppressed: this.#suppressed,
      droppedQueueFull: this.#droppedQueueFull,
      droppedOutOfOrder: this.#droppedOutOfOrder,
      delayed: this.#delayed,
      retries: this.#retries,
      failed: this.#failed,
      queueDepth: depth,
      activeCameras: active,
      inflight: this.#inflight,
      publishMsAvg: this.#publishMs.avg,
      /* ⚠️ null until something has been published — 0/s and "nothing yet" mean opposite things. */
      throughputPerSecond: recent.length === 0 ? null : recent.length / 10,
      detectionsPublished: this.#detectionsPublished,
      brokerStatus: this.#brokerStatus,
      publisherVersion: PUBLISHER_VERSION,
      ...(this.#lastPublishedAt !== undefined ? { lastPublishedAt: this.#lastPublishedAt } : {}),
      ...(this.#lastPublishedCamera !== undefined
        ? { lastPublishedCamera: this.#lastPublishedCamera }
        : {}),
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
      ...(this.#lastErrorAt !== undefined ? { lastErrorAt: this.#lastErrorAt } : {}),
      ...(this.#payloadSchemaVersion !== undefined
        ? { payloadSchemaVersion: this.#payloadSchemaVersion }
        : {}),
    };
  }

  /** Take one, fairly: resume scanning after whichever camera was served last. */
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

  /** Ensure the stream exists once, not per publish. Failure is retried on the next attempt. */
  async #ensureStream(): Promise<void> {
    this.#streamReady ??= this.#bus
      .ensureStream(CAPABILITY_OUTPUT_STREAM, [ALL_CAPABILITY_OUTPUTS])
      .catch((err) => {
        this.#streamReady = undefined;
        throw err;
      });
    return this.#streamReady;
  }

  async #send(item: Queued): Promise<void> {
    const waited = this.#now() - item.queuedAt;
    if (waited > DELAY_BUDGET_MS) this.#delayed += 1;

    const subject = capabilityOutputSubject(item.tenantId, item.capabilityId);
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (attempt > 1) this.#retries += 1;
      const started = this.#now();
      try {
        await this.#ensureStream();
        /*
         * ⚠️ `msgId` makes a redelivery idempotent at the broker. Tenant, camera and frame sequence
         * identify one observation exactly — a retry after an ambiguous failure republishes the same
         * id and JetStream collapses it, so a retry cannot become a duplicate event.
         */
        await this.#bus.publish(subject, item.result, {
          msgId: `${item.tenantId}:${item.cameraId}:${item.seq}`,
        });
        this.#published += 1;
        this.#detectionsPublished += item.detections;
        this.#publishMs.add(this.#now() - started);
        this.#throughput.push(this.#now());
        if (this.#throughput.length > 512) this.#throughput.shift();
        this.#brokerStatus = 'up';
        this.#lastPublishedAt = new Date(this.#now()).toISOString();
        this.#lastPublishedCamera = item.cameraId;
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= this.#maxAttempts) {
          this.#failed += 1;
          this.#brokerStatus = 'down';
          this.#lastError = message.slice(0, 300);
          this.#lastErrorAt = new Date(this.#now()).toISOString();
          this.#note('error', 'event publish failed after every attempt', {
            attempts: this.#maxAttempts,
            failed: this.#failed,
            error: this.#lastError,
          });
        }
      }
    }
  }

  /**
   * ⚠️ Rate-limited to one line a minute, for the same reason the frame sink is: a broker that is
   * down fails once per frame per camera, and at 2 fps across 16 cameras that is ~1 900 lines a
   * minute — which buries the line that says why.
   */
  #note(level: 'warn' | 'error' | 'info', msg: string, fields?: Record<string, unknown>): void {
    const now = this.#now();
    if (now - this.#lastLoggedAt < 60_000) return;
    this.#lastLoggedAt = now;
    this.#onLog?.(level, msg, fields);
  }
}
