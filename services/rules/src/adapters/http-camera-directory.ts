/**
 * Adapter: the **camera context**, over HTTP (P-8 Phase 7).
 *
 * Two jobs, and they have deliberately different failure postures because they answer different
 * questions:
 *
 * 1. **`CameraDirectory`** — validation-time scope resolution. Called while an operator waits on a
 *    save. ⚠️ **Fails closed**: an unreachable camera service reports `available: false`, the
 *    validation report says `verified: false`, and the rule cannot be enabled. A rule that goes live
 *    because a check could not run is the configuration version of certifying hardware from a
 *    simulation.
 *
 * 2. **`ZoneCatalog`** — a periodically refreshed name/version cache, read **synchronously** on the
 *    per-event path so a candidate's explanation can say "Checkout Queue" instead of "zn-a91f". ⚠️
 *    **Fails soft**: a stale or empty catalog produces candidates carrying the zone id alone, which
 *    is honest and still actionable. Blocking an alert on a name lookup would be the wrong trade in
 *    every direction.
 *
 * ⚠️ Both go through the **internal key**, not a user token. These are service-to-service reads that
 * happen without a user present (the catalog refreshes on a timer), and the gateway strips
 * `x-internal-key`, so neither route is reachable from a browser.
 */
import type { TenantScope } from '@vip/tenancy';
import type {
  CameraDirectory,
  CameraLookup,
  GroupResolution,
  ZoneResolution,
} from '../application/ports.js';

interface ScopeResolveResponse {
  cameras?: { missing?: string[] };
  groups?: { cameraIds?: string[]; missing?: string[]; empty?: string[] };
  zones?: { missing?: string[]; disabled?: string[]; cameraIds?: Record<string, string> };
}

export interface HttpCameraDirectoryOptions {
  /** Base URL of the camera service, e.g. `http://camera:8082`. */
  baseUrl: string;
  internalKey: string;
  /** ⚠️ Short. This runs while somebody waits on a save; a slow answer is worse than no answer. */
  timeoutMs?: number;
  onLog?: (level: 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export class HttpCameraDirectory implements CameraDirectory {
  readonly #baseUrl: string;
  readonly #key: string;
  readonly #timeoutMs: number;
  readonly #onLog: HttpCameraDirectoryOptions['onLog'];

  constructor(opts: HttpCameraDirectoryOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#key = opts.internalKey;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onLog = opts.onLog;
  }

  /**
   * One round trip for cameras, groups and zones together.
   *
   * ⚠️ The three `CameraDirectory` methods all funnel through this, so a rule naming all three costs
   * one call rather than three. It is called up to three times per validation only if a caller asks
   * for the parts separately — which the rule service does not; see `buildValidation`.
   */
  async #resolve(
    scope: TenantScope,
    body: {
      cameraIds?: readonly string[];
      groupIds?: readonly string[];
      zoneIds?: readonly string[];
    },
  ): Promise<ScopeResolveResponse | null> {
    try {
      const res = await fetch(`${this.#baseUrl}/internal/zones/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': this.#key,
          'x-tenant-id': scope.tenantId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        this.#onLog?.('warn', 'camera service refused a scope resolution', { status: res.status });
        return null;
      }
      const parsed = (await res.json()) as { data?: ScopeResolveResponse };
      return parsed.data ?? null;
    } catch (err) {
      this.#onLog?.('warn', 'camera service unreachable for scope resolution', {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async findMissing(scope: TenantScope, cameraIds: readonly string[]): Promise<CameraLookup> {
    if (cameraIds.length === 0) return { available: true, missingCameraIds: [] };
    const data = await this.#resolve(scope, { cameraIds });
    /* ⚠️ `available: false`, never "nothing missing". See the header. */
    if (data === null) return { available: false, missingCameraIds: [] };
    return { available: true, missingCameraIds: data.cameras?.missing ?? [] };
  }

  async resolveGroups(scope: TenantScope, groupIds: readonly string[]): Promise<GroupResolution> {
    if (groupIds.length === 0) {
      return { available: true, cameraIds: [], missingGroupIds: [], emptyGroupIds: [] };
    }
    const data = await this.#resolve(scope, { groupIds });
    if (data === null) {
      return { available: false, cameraIds: [], missingGroupIds: [], emptyGroupIds: [] };
    }
    return {
      available: true,
      cameraIds: data.groups?.cameraIds ?? [],
      missingGroupIds: data.groups?.missing ?? [],
      emptyGroupIds: data.groups?.empty ?? [],
    };
  }

  async resolveZones(scope: TenantScope, zoneIds: readonly string[]): Promise<ZoneResolution> {
    if (zoneIds.length === 0) {
      return { available: true, missingZoneIds: [], disabledZoneIds: [], zoneCameraIds: {} };
    }
    const data = await this.#resolve(scope, { zoneIds });
    if (data === null) {
      return { available: false, missingZoneIds: [], disabledZoneIds: [], zoneCameraIds: {} };
    }
    return {
      available: true,
      missingZoneIds: data.zones?.missing ?? [],
      disabledZoneIds: data.zones?.disabled ?? [],
      zoneCameraIds: data.zones?.cameraIds ?? {},
    };
  }
}

interface CatalogRow {
  tenantId: string;
  zoneId: string;
  name: string;
  version: number;
}

/**
 * A periodically refreshed zone name/version cache (P-8 Phase 7).
 *
 * ⚠️ **Refreshed on a timer, never on demand.** The lookup happens while building a candidate, on the
 * per-event path — the one place in this service that must not do I/O. A cache miss returns
 * `undefined` and the candidate carries the zone id, which is exactly what happens for a zone created
 * in the last few seconds. That staleness is bounded by the refresh interval and stated on the field
 * it affects (`CandidateExplanation.zoneName`), rather than removed by a blocking call.
 *
 * ⚠️ The **version** is what makes the cache more than cosmetic: it is stamped onto every candidate so
 * an incident detail page can fetch the geometry *as it was*. A stale version here would send that
 * page to the wrong snapshot, so the refresh interval is short and a zone edit bumps it immediately
 * via the plan — the same signal media uses.
 */
export class ZoneCatalog {
  #byKey = new Map<string, { name: string; version: number }>();
  #timer: NodeJS.Timeout | undefined;
  #lastRefreshAt: number | null = null;
  readonly #baseUrl: string;
  readonly #key: string;
  readonly #intervalMs: number;
  readonly #onLog: HttpCameraDirectoryOptions['onLog'];

  constructor(opts: HttpCameraDirectoryOptions & { intervalMs?: number }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#key = opts.internalKey;
    this.#intervalMs = opts.intervalMs ?? 15_000;
    this.#onLog = opts.onLog;
  }

  /** Synchronous, allocation-free, and `undefined` on a miss. ⚠️ Never a placeholder name. */
  lookup = (
    tenantId: string,
    zoneId: string | undefined,
  ): { name: string; version: number } | undefined => {
    if (zoneId === undefined) return undefined;
    return this.#byKey.get(`${tenantId}:${zoneId}`);
  };

  /** True once a refresh has succeeded. Reported by readiness so an empty cache is distinguishable. */
  get warm(): boolean {
    return this.#lastRefreshAt !== null;
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(`${this.#baseUrl}/internal/zones/catalog`, {
        headers: { 'x-internal-key': this.#key },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;
      const parsed = (await res.json()) as { data?: CatalogRow[] };
      const rows = parsed.data ?? [];
      /*
       * ⚠️ Built into a fresh map and swapped, never mutated in place. A reader on the per-event path
       * must never observe a half-populated cache — it would name a zone correctly on one candidate
       * and not on the next, for no reason anybody could reproduce.
       */
      const next = new Map<string, { name: string; version: number }>();
      for (const row of rows) {
        next.set(`${row.tenantId}:${row.zoneId}`, { name: row.name, version: row.version });
      }
      this.#byKey = next;
      this.#lastRefreshAt = Date.now();
    } catch (err) {
      /* ⚠️ Keeps the previous map. A stale name is better than no name and far better than a stall. */
      this.#onLog?.('warn', 'zone catalog refresh failed; keeping the previous one', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  start(): void {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
