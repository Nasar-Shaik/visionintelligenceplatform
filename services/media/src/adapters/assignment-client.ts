/**
 * Adapter: the **enforcement point's link to the control plane** (P-8 Phase 6).
 *
 * Three jobs on one timer:
 *
 *   1. **poll** the platform's processing plan from the camera service (internal key, cross-tenant);
 *   2. **probe** every runtime the plan names — the only place in the platform that measures runtime
 *      health, because media is the only service permitted to talk to a runtime;
 *   3. **report** both back, which is the sole path by which an assignment reaches an observed state.
 *
 * ### ⚠️ Poll, not subscribe
 *
 * A plan delivered by event would be faster and would still need reconciliation, because a missed
 * message leaves the enforcement point silently wrong for as long as nobody restarts it. Polling a
 * versioned document is self-healing: whatever happened, the next tick converges. It also makes
 * "assignments survive a restart" true by construction rather than by replay.
 *
 * ### ⚠️ Nothing here can stall the frame path
 *
 * Every network call is bounded by a timeout, the whole tick is wrapped, and a failure logs and
 * returns. A control plane that is down must degrade to *the last known plan*, which keeps analysing
 * exactly the cameras an operator last authorised — not to "everything" and not to "nothing".
 *
 * ### ⚠️ Health is derived from what was measured, and `busy` is not a guess
 *
 * - unreachable → `offline`
 * - reachable, but frames to it are failing → `busy` (it answers a health probe and cannot do work)
 * - reachable and slow → `degraded`
 * - reachable, and it was offline last tick → `recovering`
 * - otherwise → `healthy`
 *
 * There is no path to `unknown` from here: this observer either reached a runtime or did not.
 * `unknown` is the control plane's word for *nobody has looked*, and only it can say that.
 */
import type {
  AssignmentPlan,
  CameraObservation,
  RuntimeHealth,
  RuntimeObservation,
} from '@vip/contracts';
import type { AssignmentGate } from '../application/assignment-gate.js';

export interface AssignmentClientOptions {
  /** Base URL of the camera service — the control plane. */
  controlPlaneUrl: string;
  internalKey: string;
  gate: AssignmentGate;
  /** How often to poll, ms. */
  intervalMs?: number;
  /** Per-request ceiling, ms. */
  timeoutMs?: number;
  /** A runtime slower than this on its health probe is `degraded`. */
  degradedMs?: number;
  /** Identifies this enforcement point in the audit trail. */
  reportedBy?: string;
  /** Called for every camera the plan says to release. Returns nothing; must not throw. */
  onRelease: (tenantId: string, cameraId: string) => void;
  /** Delivery failures per runtime since the last tick — the `busy` signal. */
  runtimeFailures?: () => Map<string, number>;
  /**
   * Facts only this process can measure, for every camera it supervises (§ rec 1).
   *
   * ⚠️ Covers cameras that are **not in the plan**. A camera deliberately excluded from AI still
   * records, and the capability matrix has to be able to say so — a report limited to assigned
   * cameras would leave every recording-only camera answering "unknown" for ever.
   */
  cameraFacts?: () => CameraObservation[];
  onLog?: (level: 'warn' | 'error' | 'info', msg: string, fields?: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}

export interface AssignmentClientStats {
  enabled: boolean;
  /** Plan version currently applied. ⚠️ `null` before the first successful poll — never 0. */
  planVersion: number | null;
  /** Cameras the plan authorises for processing or holding. */
  plannedCameras: number;
  /** Successful poll+report cycles. */
  cycles: number;
  /** Cycles that could not reach the control plane. */
  failures: number;
  /** Cameras released because the plan said so, or because their session epoch moved. */
  releases: number;
  /** ⚠️ `null` until a plan has been fetched. */
  lastPlanAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Last measured health per runtime, as this process saw it. */
  runtimes: { runtimeId: string; health: RuntimeHealth; latencyMs: number | null }[];
}

export class AssignmentClient {
  readonly #url: string;
  readonly #key: string;
  readonly #gate: AssignmentGate;
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #degradedMs: number;
  readonly #reportedBy: string;
  readonly #onRelease: AssignmentClientOptions['onRelease'];
  readonly #runtimeFailures: () => Map<string, number>;
  readonly #cameraFacts: () => CameraObservation[];
  readonly #onLog: AssignmentClientOptions['onLog'];
  readonly #fetch: typeof fetch;

  #timer: NodeJS.Timeout | null = null;
  #cycles = 0;
  #failures = 0;
  #releases = 0;
  #lastPlanAt: string | null = null;
  #lastError: string | null = null;
  #lastErrorAt: string | null = null;
  /** Previous health per runtime, so a return from `offline` can be reported as `recovering`. */
  readonly #lastHealth = new Map<string, RuntimeHealth>();
  readonly #lastLatency = new Map<string, number | null>();

  constructor(opts: AssignmentClientOptions) {
    this.#url = opts.controlPlaneUrl.replace(/\/+$/, '');
    this.#key = opts.internalKey;
    this.#gate = opts.gate;
    this.#intervalMs = opts.intervalMs ?? 5_000;
    this.#timeoutMs = opts.timeoutMs ?? 3_000;
    this.#degradedMs = opts.degradedMs ?? 1_500;
    this.#reportedBy = opts.reportedBy ?? 'media';
    this.#onRelease = opts.onRelease;
    this.#runtimeFailures = opts.runtimeFailures ?? (() => new Map());
    this.#cameraFacts = opts.cameraFacts ?? (() => []);
    this.#onLog = opts.onLog;
    this.#fetch = opts.fetch ?? fetch;
  }

  start(): void {
    if (this.#timer !== null) return;
    /* ⚠️ `unref` so a pending tick never holds the process open during a graceful shutdown. */
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One full cycle. Exposed so a test can drive it without a timer. Never throws. */
  async tick(): Promise<void> {
    try {
      const plan = await this.#fetchPlan();
      if (plan !== null) {
        const { release } = this.#gate.applyPlan(plan);
        for (const camera of release) {
          this.#releases += 1;
          /* ⚠️ A release that throws must not abort the cycle — the remaining cameras still need it. */
          try {
            this.#onRelease(camera.tenantId, camera.cameraId);
          } catch (err) {
            this.#note(err instanceof Error ? err.message : 'release failed');
          }
        }
        this.#lastPlanAt = new Date().toISOString();
      }

      const runtimes = await this.#probeRuntimes();
      await this.#report(runtimes);
      this.#cycles += 1;
    } catch (err) {
      this.#failures += 1;
      this.#note(err instanceof Error ? err.message : String(err));
    }
  }

  stats(): AssignmentClientStats {
    return {
      enabled: true,
      planVersion: this.#gate.planVersion,
      plannedCameras: this.#gate.size,
      cycles: this.#cycles,
      failures: this.#failures,
      releases: this.#releases,
      lastPlanAt: this.#lastPlanAt,
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt,
      runtimes: [...this.#lastHealth].map(([runtimeId, health]) => ({
        runtimeId,
        health,
        latencyMs: this.#lastLatency.get(runtimeId) ?? null,
      })),
    };
  }

  async #fetchPlan(): Promise<AssignmentPlan | null> {
    const res = await this.#fetch(`${this.#url}/internal/assignment/plan`, {
      headers: { 'x-internal-key': this.#key },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) {
      this.#note(`control plane answered ${res.status} for the plan`);
      return null;
    }
    const body = (await res.json()) as { data?: AssignmentPlan };
    return body.data ?? null;
  }

  /**
   * Measure every runtime the plan names.
   *
   * ⚠️ Runtimes are probed **in parallel with a bounded timeout each**: serialising them would make
   * one dead runtime delay the health of every other, and a report that arrives late about a healthy
   * runtime is a report that can trigger an unnecessary failover.
   */
  async #probeRuntimes(): Promise<RuntimeObservation[]> {
    const targets = this.#gate.runtimes();
    const failures = this.#runtimeFailures();
    return Promise.all(
      targets.map((t) => this.#probe(t.runtimeId, t.url, failures.get(t.runtimeId) ?? 0)),
    );
  }

  async #probe(runtimeId: string, url: string, failedFrames: number): Promise<RuntimeObservation> {
    const base = url.replace(/\/+$/, '');
    const started = Date.now();
    let latencyMs: number | null = null;
    let reachable = false;
    let detail: string | undefined;

    try {
      const res = await this.#fetch(`${base}/health`, {
        headers: { 'x-internal-key': this.#key },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      latencyMs = Date.now() - started;
      reachable = res.ok;
      if (!res.ok) detail = `health answered ${res.status}`;
    } catch (err) {
      /* ⚠️ `latencyMs` stays null. A timeout is not a 3000 ms round trip — it is no round trip. */
      detail = err instanceof Error ? err.message : 'unreachable';
    }

    const previous = this.#lastHealth.get(runtimeId);
    let health: RuntimeHealth;
    if (!reachable) {
      health = 'offline';
    } else if (failedFrames > 0) {
      /* Answers a health probe and cannot do work. That is `busy`, and it is measured. */
      health = 'busy';
      detail = `${failedFrames} frame deliveries failed since the last report`;
    } else if (latencyMs !== null && latencyMs > this.#degradedMs) {
      health = 'degraded';
      detail = `health probe took ${latencyMs} ms`;
    } else if (previous === 'offline') {
      health = 'recovering';
    } else {
      health = 'healthy';
    }

    const capabilities = reachable ? await this.#capabilities(base) : null;
    this.#lastHealth.set(runtimeId, health);
    this.#lastLatency.set(runtimeId, latencyMs);
    return {
      runtimeId,
      health,
      latencyMs,
      capabilities,
      ...(detail === undefined ? {} : { detail }),
    };
  }

  /**
   * What the runtime says it can run.
   *
   * ⚠️ Returns `null` on any problem rather than `[]`. An empty list means "it offered none", which
   * would make every profile read as unsupported; `null` means "we could not ask", and the control
   * plane keeps the last known list.
   */
  async #capabilities(base: string): Promise<string[] | null> {
    try {
      const res = await this.#fetch(`${base}/capabilities`, {
        headers: { 'x-internal-key': this.#key },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      const rows = Array.isArray(body.data) ? body.data : [];
      const ids = rows
        .map((row) => {
          const r = row as { capabilityId?: unknown; id?: unknown };
          return typeof r.capabilityId === 'string' ? r.capabilityId : r.id;
        })
        .filter((id): id is string => typeof id === 'string');
      return ids.length === 0 ? null : ids;
    } catch {
      return null;
    }
  }

  async #report(runtimes: RuntimeObservation[]): Promise<void> {
    const body = {
      reportedBy: this.#reportedBy,
      at: new Date().toISOString(),
      planVersion: this.#gate.planVersion,
      runtimes,
      cameras: mergeObservations(this.#gate.observations(Date.now()), this.#cameraFacts()),
    };
    const res = await this.#fetch(`${this.#url}/internal/assignment/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': this.#key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) this.#note(`control plane answered ${res.status} for the report`);
  }

  #note(message: string): void {
    this.#lastError = message;
    this.#lastErrorAt = new Date().toISOString();
    this.#onLog?.('warn', 'assignment cycle degraded', { error: message });
  }
}

/**
 * Merge the gate's per-camera **states** with the process's per-camera **facts**.
 *
 * ⚠️ The gate wins on `state` and the facts win on everything else, and the asymmetry is the point:
 * only the gate knows whether a camera is being processed, and only the supervisor and publisher know
 * whether it is recording or has produced tracks. A camera the gate has never heard of still appears,
 * carrying `idle` — a state that deliberately moves no state machine on the control plane, so
 * reporting a recording-only camera cannot disturb its assignment.
 */
export function mergeObservations(
  states: CameraObservation[],
  facts: CameraObservation[],
): CameraObservation[] {
  const byKey = new Map<string, CameraObservation>();
  for (const fact of facts) byKey.set(`${fact.tenantId} ${fact.cameraId}`, fact);
  for (const state of states) {
    const key = `${state.tenantId} ${state.cameraId}`;
    const fact = byKey.get(key);
    byKey.set(key, fact === undefined ? state : { ...fact, ...state });
  }
  return [...byKey.values()];
}
