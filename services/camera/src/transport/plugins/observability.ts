/**
 * Transport plugin: Prometheus metrics (docs/architecture/16). Uses a per-instance registry
 * (not the global default) so multiple app instances — notably in tests — never collide on
 * "metric already registered". Records default process metrics plus an HTTP request-duration
 * histogram, and returns the registry for the /metrics route.
 */
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type { AssignmentRuntimeMetrics } from '@vip/contracts';

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
 * Camera Processing Assignment, made measurable (P-8 Phase 6 §9) — the CONTROL PLANE's half.
 *
 * Media's `media_assignment_*` series say what the enforcement point is doing; these say what the
 * control plane decided. They are deliberately different numbers: `camera_assignment_assigned_cameras`
 * counts what an operator authorised, `media_assignment_planned_cameras` counts what media picked up,
 * and **a gap between them is the signal** — it means a plan was published and has not landed.
 * Collapsing them into one series would erase the only view of that failure.
 *
 * ### ⚠️ Aggregate only
 *
 * No tenant label, no camera label. Prometheus has no tenant isolation, and per-camera figures are
 * served by the tenant-scoped API instead. Everything here is read at scrape time, so the write path
 * pays nothing.
 */
export function registerAssignmentMetrics(
  registry: Registry,
  provider: { metrics(): Promise<AssignmentRuntimeMetrics> },
): void {
  const series: Array<[string, string, (m: AssignmentRuntimeMetrics) => number | null]> = [
    [
      'camera_assignment_assigned_cameras',
      'Cameras with AI enabled — what operators authorised',
      (m) => m.assignedCameras,
    ],
    [
      'camera_assignment_active_cameras',
      'Cameras confirmed processing by an enforcement point',
      (m) => m.activeCameras,
    ],
    [
      'camera_assignment_disabled_cameras',
      'Cameras recording only — no AI assignment',
      (m) => m.disabledCameras,
    ],
    [
      'camera_assignment_changes_total',
      'Accepted assignment transitions',
      (m) => m.assignmentChanges,
    ],
    [
      'camera_assignment_failures_total',
      'Refused assignment operations — placement, capacity, limits, illegal transitions',
      (m) => m.assignmentFailures,
    ],
    [
      'camera_assignment_runtime_failovers_total',
      'Cameras moved because their runtime stopped being usable',
      (m) => m.runtimeFailovers,
    ],
    [
      /* ⚠️ The queue that matters: cameras an operator enabled that placement could not seat. */
      'camera_assignment_queue',
      'AI-enabled cameras waiting for a runtime',
      (m) => m.assignmentQueue,
    ],
    [
      /* ⚠️ `null` until a change has been published AND reported back — never 0, which would read
       * as "assignments apply instantly" on a deployment where nothing has ever applied. */
      'camera_assignment_latency_ms',
      'Mean ms from an accepted change to an enforcement point reporting it applied',
      (m) => m.assignmentLatencyMs,
    ],
    ['camera_assignment_plan_version', 'Current plan version', (m) => m.planVersion],
  ];

  for (const [name, help, read] of series) {
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        const value = read(await provider.metrics());
        /* ⚠️ ADR-0039: an unavailable reading is omitted, never written as a zero. */
        if (value === null || !Number.isFinite(value)) {
          this.remove();
          return;
        }
        this.set(value);
      },
    });
  }
}
