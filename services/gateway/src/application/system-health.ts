/**
 * Application: the platform's view of itself (P-6.4).
 *
 * ### ⚠️ Why the fan-out lives here and not in the browser
 *
 * The console could reach every service's readiness probe through the proxy it already has — ten
 * round trips, ten tokens, from a laptop that may be on a phone tether. Here it is ten calls inside
 * the cluster, issued once and shared by every operator looking at the page, because the answer is
 * about the deployment and not about the caller. The gateway is also the only process that knows the
 * upstream list, so asking it avoids a second copy of that list living in the frontend.
 *
 * ### ⚠️ Readiness, not liveness
 *
 * `GET /health` on every service returns `{status:'ok'}` unconditionally — it says a process is up,
 * which is what an orchestrator restarts on. It **cannot fail while the process can answer**, so a
 * health page built on it is green by construction. Only `/ready` runs the dependency checks, so
 * only `/ready` is asked.
 *
 * ### ⚠️ Infrastructure is derived from those checks, never probed
 *
 * MongoDB's state is the union of what the services say about MongoDB. That is cheaper than opening
 * a socket from here, and truer: it reports the database *as the platform experiences it*, which is
 * the only version an operator can act on. Nothing appears in the infrastructure list unless some
 * service actually depends on it — a row for something nobody checks would be an assertion that it
 * is part of the system, made by the one component that has no way to know.
 */
import {
  PLATFORM_CAPABILITIES,
  type SystemComponent,
  type SystemComponentCheck,
  type SystemComponentState,
  type SystemHealth,
} from '@vip/contracts';

/** Wall-clock ceiling on one readiness probe. A slow answer is a degraded service, not a hung page. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long one snapshot is reused.
 *
 * ⚠️ Short enough that an operator watching a restart sees it, long enough that N operators (or one
 * operator with the tab left open) cannot multiply into N × 10 upstream calls per poll. The page
 * refreshes on a longer interval than this, so the cache mostly serves concurrent viewers.
 */
const CACHE_TTL_MS = 5_000;

/** Identifier → the word an operator reads. The one place a service name becomes English. */
const SERVICE_LABEL: Record<string, string> = {
  identity: 'Identity',
  tenant: 'Tenant',
  camera: 'Cameras',
  media: 'Media',
  events: 'Events',
  rules: 'Rules',
  workflow: 'Incidents',
  notify: 'Notifications',
  evidence: 'Evidence',
};

/** Dependency check name → the word an operator reads. */
const INFRA_LABEL: Record<string, string> = {
  mongo: 'MongoDB',
  storage: 'Object storage',
  nats: 'Message backbone',
  redis: 'Redis',
};

interface ReadyBody {
  status?: string;
  checks?: { name?: string; status?: string; detail?: string }[];
}

export interface SystemHealthDeps {
  /** Prefix → upstream base URL. The gateway's own config; not a second list. */
  upstreams: Record<string, string>;
  /** The gateway's own readiness report, so it appears beside the services it fronts. */
  ownReadiness: () => Promise<{ status: string; checks: readonly SystemComponentCheck[] }>;
  /** Whether real-time delivery is wired in this deployment (`STREAM_ENABLED`). */
  streamEnabled: boolean;
  fetch?: typeof fetch;
  clock?: () => Date;
}

export class SystemHealthService {
  readonly #deps: SystemHealthDeps;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  #cached: { at: number; report: SystemHealth } | null = null;
  /**
   * ⚠️ Which dependencies each service has ever reported on, so a row cannot **vanish** when the
   * services that speak for it go quiet.
   *
   * Found by pausing MongoDB against the deployment: every service's readiness probe blocked, all
   * ten timed out as `unreachable`, they contributed no checks — and the MongoDB row **disappeared
   * from the report entirely**. The operator was shown ten red rows during a total database outage
   * and not one word about the database. A page that drops the row for the thing that broke is a
   * page that hides the answer exactly when it is needed.
   */
  readonly #everReported = new Map<string, string[]>();

  constructor(deps: SystemHealthDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetch ?? fetch;
    this.#clock = deps.clock ?? (() => new Date());
  }

  /** The current report, re-derived at most once per {@link CACHE_TTL_MS}. */
  async report(): Promise<SystemHealth> {
    const now = this.#clock().getTime();
    if (this.#cached && now - this.#cached.at < CACHE_TTL_MS) return this.#cached.report;

    const services = await this.#probeServices();
    const gateway = await this.#probeSelf();
    const all = [gateway, ...services];
    for (const component of all) {
      if (component.checks.length > 0) {
        this.#everReported.set(
          component.id,
          component.checks.map((c) => c.name),
        );
      }
    }
    const report: SystemHealth = {
      components: [
        ...all,
        ...deriveInfrastructure(all, this.#everReported),
        ...capabilities(this.#deps.streamEnabled),
      ],
      derivedAt: this.#clock().toISOString(),
      cacheTtlMs: CACHE_TTL_MS,
    };
    this.#cached = { at: now, report };
    return report;
  }

  /** Ask every upstream's readiness probe, in parallel. One slow service does not delay the rest. */
  async #probeServices(): Promise<SystemComponent[]> {
    const entries = Object.entries(this.#deps.upstreams);
    return Promise.all(entries.map(([id, base]) => this.#probeOne(id, base)));
  }

  async #probeOne(id: string, base: string): Promise<SystemComponent> {
    const label = SERVICE_LABEL[id] ?? id;
    const url = `${base.replace(/\/$/, '')}/ready`;
    const started = Date.now();
    const observedAt = this.#clock().toISOString();
    try {
      const response = await this.#fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
      const latencyMs = Date.now() - started;
      let body: ReadyBody = {};
      try {
        body = (await response.json()) as ReadyBody;
      } catch {
        /*
         * ⚠️ Answered, but not with a readiness report. That is `unknown`, not `ready`: something is
         * listening on the port and we have no idea what it thinks of itself.
         */
        return {
          id,
          label,
          kind: 'service',
          state: 'unknown',
          detail: `answered HTTP ${response.status} but not with a readiness report`,
          checks: [],
          latencyMs,
          observedAt,
        };
      }
      const checks = readChecks(body);
      const failed = checks.filter((c) => c.status === 'fail');
      /*
       * ⚠️ A service answering 503 is **degraded**, not unavailable. It answered — its dependency is
       * what failed, and the page should send someone to the dependency rather than to the service.
       * `unreachable` is reserved for "did not answer at all", which is a different call-out.
       */
      const state: SystemComponentState =
        failed.length === 0 && body.status === 'pass' ? 'ready' : 'degraded';
      const component: SystemComponent = {
        id,
        label,
        kind: 'service',
        state,
        checks,
        latencyMs,
        observedAt,
      };
      if (state !== 'ready') {
        component.detail =
          failed.length > 0
            ? `${failed.map((c) => `${c.name}: ${c.detail ?? 'failing'}`).join('; ')}`.slice(0, 300)
            : `readiness reported "${body.status ?? 'no status'}"`;
      }
      return component;
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return {
        id,
        label,
        kind: 'service',
        state: 'unreachable',
        detail: timedOut ? `did not answer within ${PROBE_TIMEOUT_MS} ms` : connectionReason(err),
        checks: [],
        latencyMs: Date.now() - started,
        observedAt,
      };
    }
  }

  /** The gateway reports on itself from its own registry — it does not make an HTTP call to itself. */
  async #probeSelf(): Promise<SystemComponent> {
    const observedAt = this.#clock().toISOString();
    try {
      const own = await this.#deps.ownReadiness();
      const checks = own.checks.map((c) => ({ ...c }));
      const failed = checks.filter((c) => c.status === 'fail');
      const component: SystemComponent = {
        id: 'gateway',
        label: 'Gateway',
        kind: 'service',
        state: failed.length === 0 && own.status === 'pass' ? 'ready' : 'degraded',
        checks,
        observedAt,
      };
      if (component.state !== 'ready') {
        component.detail = failed
          .map((c) => `${c.name}: ${c.detail ?? 'failing'}`)
          .join('; ')
          .slice(0, 300);
      }
      return component;
    } catch (err) {
      return {
        id: 'gateway',
        label: 'Gateway',
        kind: 'service',
        state: 'degraded',
        detail: (err instanceof Error ? err.message : 'readiness check threw').slice(0, 300),
        checks: [],
        observedAt,
      };
    }
  }
}

/**
 * ⚠️ **"fetch failed" is not a reason.**
 *
 * That is exactly what the deployment reported for a stopped container, and it tells an operator
 * nothing they did not already know from the word "Unavailable". `undici` puts the real cause —
 * `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET` — one level down in `error.cause`, which is the
 * difference between "the container is not running" and "the name does not resolve".
 */
function connectionReason(err: unknown): string {
  if (!(err instanceof Error)) return 'connection failed';
  const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const message = typeof cause?.message === 'string' ? cause.message : undefined;
  const reason = code ?? message;
  return (reason === undefined ? err.message : `${err.message} (${reason})`).slice(0, 300);
}

/** Take only what a readiness report is allowed to contain; ignore anything else it carries. */
function readChecks(body: ReadyBody): SystemComponentCheck[] {
  if (!Array.isArray(body.checks)) return [];
  return body.checks.slice(0, 20).flatMap((raw) => {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    if (name === '') return [];
    const status = raw.status === 'pass' ? 'pass' : 'fail';
    const detail = typeof raw.detail === 'string' ? raw.detail.slice(0, 300) : undefined;
    return [detail === undefined ? { name, status } : { name, status, detail }];
  });
}

/**
 * Roll the services' own dependency checks up into one row per dependency.
 *
 * ⚠️ A component only appears if some service actually checks it. Listing something nobody checks
 * would be the gateway asserting that it is part of the system, which is precisely the thing the
 * gateway has no way to know — and a row reading "Redis · unknown" is indistinguishable, to a
 * customer, from "Redis · broken".
 *
 * ⚠️ A service that did not answer contributes **nothing to the verdict**, rather than contributing a
 * failure. Its silence is already reported as its own row; counting it again as evidence about
 * MongoDB would turn one outage into two, and send someone to the wrong place.
 *
 * ⚠️ **But it does keep the row alive.** Measured against the deployment by pausing MongoDB: every
 * service's readiness probe blocked, all ten timed out, none reported a check — and the MongoDB row
 * vanished from the report. Ten red rows during a total database outage and not one word about the
 * database. A silent service therefore contributes its *last known* dependency names, so the row
 * survives as `unknown`: **nobody can speak for it right now** is a different sentence from "it is
 * broken", and both are different from silence.
 */
function deriveInfrastructure(
  services: readonly SystemComponent[],
  everReported: ReadonlyMap<string, string[]>,
): SystemComponent[] {
  const byName = new Map<
    string,
    { pass: string[]; fail: SystemComponentCheck[]; silent: string[]; at: string | undefined }
  >();
  const blank = () => ({ pass: [], fail: [], silent: [], at: undefined });

  for (const service of services) {
    if (service.state === 'unreachable') {
      for (const name of everReported.get(service.id) ?? []) {
        const entry = byName.get(name) ?? blank();
        entry.silent.push(service.label);
        byName.set(name, entry);
      }
      continue;
    }
    for (const check of service.checks) {
      const entry = byName.get(check.name) ?? blank();
      if (check.status === 'pass') entry.pass.push(service.label);
      else entry.fail.push({ ...check, name: service.label });
      entry.at = service.observedAt ?? entry.at;
      byName.set(check.name, entry);
    }
  }

  return [...byName.entries()].map(([name, entry]) => {
    /*
     * ⚠️ `unknown` only when **nobody** answered. One silent service among nine healthy ones says
     * nothing about the dependency — the other nine just used it successfully.
     */
    const state: SystemComponentState =
      entry.fail.length > 0
        ? entry.pass.length === 0
          ? 'unreachable'
          : 'degraded'
        : entry.pass.length === 0
          ? 'unknown'
          : 'ready';
    const component: SystemComponent = {
      id: `infra:${name}`,
      label: INFRA_LABEL[name] ?? name,
      kind: 'infrastructure',
      state,
      checks: entry.fail,
      ...(entry.at === undefined ? {} : { observedAt: entry.at }),
    };
    if (state !== 'ready') {
      const who = entry.fail.map((c) => c.name).join(', ');
      component.detail =
        state === 'unknown'
          ? `nothing can speak for it — every service that checks it (${entry.silent.join(', ')}) is not answering`
          : state === 'unreachable'
            ? `every service that depends on it reports it failing (${who})`
            : `failing for ${who}; healthy for ${entry.pass.join(', ')}`;
    }
    return component;
  });
}

/**
 * The capability rows: facts about the release rather than about this morning.
 *
 * Real-time delivery is the one that is genuinely *configurable*, so it is the one derived from
 * configuration. The rest come from the frozen register in `@vip/contracts`, which is the single
 * place those claims are written down.
 */
function capabilities(streamEnabled: boolean): SystemComponent[] {
  const stream: SystemComponent = {
    id: 'realtime-stream',
    label: 'Real-time updates',
    kind: 'capability',
    state: streamEnabled ? 'ready' : 'not-configured',
    checks: [],
    ...(streamEnabled
      ? {}
      : {
          detail:
            'STREAM_ENABLED is off in this deployment, so the console will not receive live ' +
            'incident updates. Pages still refresh on navigation.',
        }),
  };
  return [
    stream,
    ...PLATFORM_CAPABILITIES.map((capability): SystemComponent => ({
      id: capability.id,
      label: capability.label,
      kind: 'capability',
      state: capability.state,
      detail: capability.detail,
      checks: [],
    })),
  ];
}
