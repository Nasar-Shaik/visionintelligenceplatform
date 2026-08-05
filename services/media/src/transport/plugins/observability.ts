/**
 * Transport plugin: Prometheus metrics (docs/architecture/16). Uses a per-instance registry
 * (not the global default) so multiple app instances — notably in tests — never collide on
 * "metric already registered". Records default process metrics plus an HTTP request-duration
 * histogram, and returns the registry for the /metrics route.
 */
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { FrameSinkStats } from '../../adapters/http-frame-sink.js';

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
