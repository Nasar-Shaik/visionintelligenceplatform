/**
 * Transport plugin: Prometheus metrics (docs/architecture/16). Uses a per-instance registry
 * (not the global default) so multiple app instances — notably in tests — never collide on
 * "metric already registered". Records default process metrics plus an HTTP request-duration
 * histogram, and returns the registry for the /metrics route.
 */
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { FrameSinkStats } from '../../adapters/http-frame-sink.js';
import type { AssignmentClientStats } from '../../adapters/assignment-client.js';
import type { EventPublisherStats } from '../../adapters/event-publisher.js';

const METRICS_ROUTE = '/metrics';

export function registerMetrics(app: FastifyInstance, opts: { serviceName: string }): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: opts.serviceName });
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unknown';
    if (route !== METRICS_ROUTE) {
      httpDuration.observe(
        { method: request.method, route, status_code: reply.statusCode },
        reply.elapsedTime / 1000,
      );
    }
    done();
  });

  return registry;
}

/**
 * The perception seam, made measurable (P-8 Phase 2). ⚠️ Every series is read from the sink at scrape
 * time rather than incremented at the call site: the decode path must not pay for observability, and
 * a counter that is only correct when someone remembers to increment it is a counter that will drift.
 *
 * ⚠️ `frames_dropped` and `frames_failed` are **separate series**, deliberately. Dropping is policy —
 * the queue was full and the newest frame won — and failing is a fault. One number covering both
 * would make a healthy system under load look identical to a broken one.
 */
export function registerPerceptionMetrics(
  registry: Registry,
  provider: { stats(): FrameSinkStats },
): void {
  const series: Array<[string, string, (s: FrameSinkStats) => number]> = [
    [
      'media_perception_frames_offered_total',
      'Frames handed to the sink by the decoder',
      (s) => s.offered,
    ],
    ['media_perception_frames_delivered_total', 'Frames the runtime accepted', (s) => s.delivered],
    [
      'media_perception_frames_dropped_total',
      'Frames dropped because a camera queue was full (policy)',
      (s) => s.droppedQueueFull,
    ],
    [
      'media_perception_frames_no_image_total',
      'Frames that arrived with no pixels (should be zero)',
      (s) => s.droppedNoImage,
    ],
    [
      'media_perception_frames_failed_total',
      'Frames the runtime refused or could not be reached for',
      (s) => s.failed,
    ],
    ['media_perception_queue_depth', 'Frames waiting, summed across cameras', (s) => s.queueDepth],
    ['media_perception_inflight', 'Delivery requests in flight', (s) => s.inflight],
    [
      'media_perception_active_cameras',
      'Cameras with at least one frame queued',
      (s) => s.activeCameras,
    ],
    [
      'media_perception_deliver_ms_avg',
      'Mean transport time per delivered frame (ms)',
      (s) => s.deliverMsAvg,
    ],
    [
      'media_perception_frame_age_ms_avg',
      'Mean age of a frame when the runtime accepted it (ms)',
      (s) => s.frameAgeMsAvg,
    ],
    // --- what the runtime answered (P-8 Phase 3) --------------------------------------------
    [
      'media_perception_detections_total',
      'Detections across every analysed frame',
      (s) => s.detections,
    ],
    [
      'media_perception_frames_with_detections_total',
      'Analysed frames that produced at least one detection',
      (s) => s.framesWithDetections,
    ],
    [
      'media_perception_inference_ms_avg',
      'Mean inference time reported by the runtime (ms)',
      (s) => s.inferenceMsAvg,
    ],
    [
      'media_perception_frame_latency_ms_avg',
      'Mean capture-to-detection latency reported by the runtime (ms)',
      (s) => s.frameLatencyMsAvg,
    ],
  ];
  for (const [name, help, read] of series) {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read(provider.stats()));
      },
    });
  }

  /*
   * ⚠️ A labelled series, and the only one in this file. `person` and `car` are the two words that
   * distinguish "the runtime answered" from "the runtime SAW something", and no unlabelled counter
   * can carry that. Cardinality is bounded by the model's label space (≤ 90) and by the sink's own
   * 128-entry cap, so this cannot become the metric that fills a time-series database.
   */
  new Gauge({
    name: 'media_perception_detections_by_label_total',
    help: 'Detections by label, as reported by the runtime',
    labelNames: ['label'],
    registers: [registry],
    collect() {
      for (const [label, count] of Object.entries(provider.stats().detectionsByLabel)) {
        this.set({ label }, count);
      }
    },
  });
}

/**
 * The Event Publisher bridge, made measurable (P-8 Phase 5).
 *
 * Same discipline as the perception series above: read from the publisher at scrape time, never
 * incremented at the call site, so the publish path pays nothing for observability.
 *
 * ### ⚠️ Four different reasons a result does not become an event, kept as four series
 *
 * `rejected` (failed contract validation), `suppressed` (no detections, so no events exist to
 * produce), `dropped` (queue full — policy) and `out_of_order` (a newer frame was already
 * published) are **not the same event** and collapsing them would make a healthy busy system
 * indistinguishable from a broken one. Only `failed` is a fault.
 *
 * ### ⚠️ What is deliberately NOT here
 *
 * There is no `deduplicated` series. Content deduplication happens downstream in `services/events`,
 * which owns that number; publishing a similarly-named series here would be two series with one
 * meaning, read off one dashboard, disagreeing. The publisher's `suppressed` is a different thing
 * and is named for what it actually is.
 */
export function registerEventPublisherMetrics(
  registry: Registry,
  provider: { stats(): EventPublisherStats },
): void {
  const series: Array<[string, string, (s: EventPublisherStats) => number | null]> = [
    ['media_event_publisher_enabled', 'Whether the bridge is on', (s) => (s.enabled ? 1 : 0)],
    ['media_event_publisher_offered_total', 'Inference results offered', (s) => s.offered],
    ['media_event_publisher_published_total', 'Results published to the bus', (s) => s.published],
    [
      'media_event_publisher_detections_published_total',
      'Detections published — the events the normalizer will produce',
      (s) => s.detectionsPublished,
    ],
    [
      'media_event_publisher_rejected_total',
      'Results that failed contract validation and were never published (fail-closed)',
      (s) => s.rejected,
    ],
    [
      'media_event_publisher_suppressed_total',
      'Results with no detections, which would produce no events',
      (s) => s.suppressed,
    ],
    [
      'media_event_publisher_dropped_total',
      'Results dropped because a camera queue was full (policy)',
      (s) => s.droppedQueueFull,
    ],
    [
      'media_event_publisher_out_of_order_total',
      'Results dropped because a newer frame was already published for that camera',
      (s) => s.droppedOutOfOrder,
    ],
    [
      'media_event_publisher_session_resets_total',
      'Times a camera restarted its frame sequence and the ordering gate was reset',
      (s) => s.sessionResets,
    ],
    [
      'media_event_publisher_delayed_total',
      'Publishes that waited beyond the delay budget',
      (s) => s.delayed,
    ],
    ['media_event_publisher_retries_total', 'Retry attempts made', (s) => s.retries],
    [
      'media_event_publisher_failed_total',
      'Results that exhausted every attempt and were lost',
      (s) => s.failed,
    ],
    ['media_event_publisher_queue_depth', 'Results waiting, across cameras', (s) => s.queueDepth],
    [
      /* ⚠️ The bound, beside the depth. A depth alert is meaningless without what it is bounded by. */
      'media_event_publisher_queue_per_camera',
      'Configured per-camera queue bound — the depth at which the oldest result is dropped',
      (s) => s.queuePerCamera,
    ],
    ['media_event_publisher_inflight', 'Publishes in flight', (s) => s.inflight],
    [
      'media_event_publisher_active_cameras',
      'Cameras with at least one result queued',
      (s) => s.activeCameras,
    ],
    [
      'media_event_publisher_publish_ms_avg',
      'Mean broker publish time (ms)',
      (s) => s.publishMsAvg,
    ],
    [
      'media_event_publisher_throughput_per_second',
      'Events published per second over the recent window',
      (s) => s.throughputPerSecond,
    ],
    [
      /*
       * ⚠️ `unknown` is 0 and is NOT the same as `down` (-1). A publisher that has published nothing
       * has not demonstrated a working broker, and reporting that as healthy is exactly the failure
       * ADR-0039 forbids. An alert must be able to distinguish "not yet tried" from "tried and
       * failed", so the two states are different values rather than one falsy one.
       */
      'media_event_publisher_broker_status',
      'Broker reachability: 1 up, -1 down, 0 not yet attempted',
      (s) => (s.brokerStatus === 'up' ? 1 : s.brokerStatus === 'down' ? -1 : 0),
    ],
  ];
  for (const [name, help, read] of series) {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        const value = read(provider.stats());
        /*
         * ⚠️ A `null` reading is OMITTED, not written as 0 (ADR-0039). "No publish has been timed
         * yet" and "publishes take no time" are opposite statements that render identically as a
         * zero on a graph, and only one of them is good news.
         *
         * ⚠️ **`remove()`, not "skip the set()".** The first version simply did not call `set()` —
         * and prom-client initialises an unlabelled gauge to 0 at construction, so the series was
         * published as `0` regardless. It was caught by scraping the deployment and seeing
         * `media_event_publisher_publish_ms_avg 0` on a publisher that had never published. Removing
         * the entry is what actually omits the sample; not setting it only omits the update.
         */
        if (value === null) this.remove();
        else this.set(value);
      },
    });
  }

  /*
   * ⚠️ Versions as a labelled info series, which is the Prometheus idiom for "what is running".
   * Three DIFFERENT version numbers answer three different questions, and an operator asking "why
   * did events change shape?" needs to tell them apart: the publisher's own logic, the payload
   * contract it saw on the wire, and (elsewhere) the service build.
   */
  new Gauge({
    name: 'media_event_publisher_build_info',
    help: 'Publisher version and the payload schema version last seen on the wire',
    labelNames: ['publisher_version', 'payload_schema_version'],
    registers: [registry],
    collect() {
      const s = provider.stats();
      this.set(
        {
          publisher_version: s.publisherVersion,
          // ⚠️ "unknown", not a guessed default — nothing has been observed yet.
          payload_schema_version: s.payloadSchemaVersion ?? 'unknown',
        },
        1,
      );
    },
  });
}

/**
 * Camera Processing Assignment, made measurable (P-8 Phase 6 §9).
 *
 * ### ⚠️ Aggregate only — no tenant label, no camera label
 *
 * Prometheus has no tenant isolation, so a `camera_id` label here would publish one customer's
 * inventory to anything that can reach the scrape endpoint, and its cardinality would grow with the
 * estate. Per-camera figures are served by `GET /perception/assignment/cameras`, behind
 * `assignment:read` and a verified tenant. The two are different surfaces on purpose.
 *
 * ### ⚠️ Runtime health is a labelled series, and it is the exception that earns it
 *
 * `media_assignment_runtime_health{runtime_id}` names infrastructure, not a customer — a runtime is
 * a container the operator deployed. Cardinality is bounded by the number of registered runtimes,
 * which is single digits. Without the label, "one of the runtimes is offline" is unactionable.
 *
 * ⚠️ The encoding distinguishes every state rather than collapsing to healthy/unhealthy, because
 * `busy` (answers a probe, cannot do work) and `offline` (does not answer) need different responses,
 * and `recovering` must not page anybody at all.
 */
export function registerAssignmentMetrics(
  registry: Registry,
  provider: { stats(): AssignmentClientStats },
): void {
  const series: Array<[string, string, (s: AssignmentClientStats) => number | null]> = [
    [
      'media_assignment_enabled',
      'Whether the assignment gate governs this deployment',
      (s) => (s.enabled ? 1 : 0),
    ],
    [
      /* ⚠️ `null` before the first successful poll — omitted, never 0. Plan version 0 is a real
       * version (a deployment where nothing has ever been assigned), so a 0 here would be a lie
       * that is indistinguishable from the truth. */
      'media_assignment_plan_version',
      'Plan version currently applied by the enforcement point',
      (s) => s.planVersion,
    ],
    [
      'media_assignment_planned_cameras',
      'Cameras the plan authorises for processing or holding',
      (s) => s.plannedCameras,
    ],
    ['media_assignment_cycles_total', 'Completed poll-and-report cycles', (s) => s.cycles],
    [
      'media_assignment_cycle_failures_total',
      'Cycles that could not reach the control plane',
      (s) => s.failures,
    ],
    [
      'media_assignment_releases_total',
      'Cameras whose per-camera state was released — a stop, a restart, or a runtime move',
      (s) => s.releases,
    ],
  ];
  for (const [name, help, read] of series) {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        const value = read(provider.stats());
        /* ⚠️ ADR-0039: an unavailable reading is omitted, never written as a zero. */
        if (value === null || !Number.isFinite(value)) {
          this.remove();
          return;
        }
        this.set(value);
      },
    });
  }

  const HEALTH: Record<string, number> = {
    healthy: 1,
    recovering: 2,
    degraded: 3,
    busy: 4,
    offline: 5,
    unknown: 0,
  };
  new Gauge({
    name: 'media_assignment_runtime_health',
    help: 'Runtime health as this enforcement point measured it: 1 healthy, 2 recovering, 3 degraded, 4 busy, 5 offline, 0 unknown',
    labelNames: ['runtime_id'],
    registers: [registry],
    collect() {
      for (const runtime of provider.stats().runtimes) {
        this.set({ runtime_id: runtime.runtimeId }, HEALTH[runtime.health] ?? 0);
      }
    },
  });

  new Gauge({
    name: 'media_assignment_runtime_latency_ms',
    help: 'Health-probe round trip per runtime (ms). Absent when the runtime could not be reached.',
    labelNames: ['runtime_id'],
    registers: [registry],
    collect() {
      for (const runtime of provider.stats().runtimes) {
        /* ⚠️ Unreachable ⇒ no sample. A timeout is not a slow round trip; it is no round trip. */
        if (runtime.latencyMs === null) continue;
        this.set({ runtime_id: runtime.runtimeId }, runtime.latencyMs);
      }
    },
  });
}

/**
 * The two skip counters (P-8 Phase 6). Registered beside the perception series they belong with.
 *
 * ⚠️ Separate from `frames_dropped`, and that separation is the point: a skipped frame is a decision
 * an operator made, a dropped frame is a symptom of load. One series covering both would make a
 * correctly configured deployment and an overloaded one produce the same graph.
 */
export function registerAssignmentSkipMetrics(
  registry: Registry,
  provider: { stats(): FrameSinkStats },
): void {
  const series: Array<[string, string, (s: FrameSinkStats) => number]> = [
    [
      'media_perception_frames_skipped_unassigned_total',
      'Frames not sent because the camera has no AI assignment (policy, not loss)',
      (s) => s.skippedUnassigned,
    ],
    [
      'media_perception_frames_skipped_held_total',
      'Frames not sent because an operator paused the camera (policy, not loss)',
      (s) => s.skippedHeld,
    ],
  ];
  for (const [name, help, read] of series) {
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read(provider.stats()));
      },
    });
  }
}
