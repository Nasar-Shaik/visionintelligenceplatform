/**
 * Application: camera-inventory use-cases (tenant-scoped via @vip/tenancy, fail-closed). This is
 * where credentials are vaulted: on create/update they are sealed with @vip/crypto and only the
 * cipher is persisted — plaintext never reaches the domain, the store, a log, or a response.
 *
 * Zone referential integrity: a camera references its `zoneId` (an `OrgNode` owned by the Tenant
 * context, P1-1). This slice validates the id's shape/tenant-scoping but does NOT synchronously
 * call the tenant service to confirm the node exists — cross-context reads go through the event
 * backbone (subscribe to `tenant.hierarchy.changed`, P1-5), keeping the contexts independently
 * deployable. Enforcing existence is tracked as tech-debt until the backbone lands (ED-0024/TD-3).
 */
import { CreateCameraInput } from '@vip/contracts';
import type {
  BulkCreateCamerasInput,
  CameraHealthSummary,
  CameraLifecycleState,
  CameraProbeReport,
  CameraTimelineEntry,
  CapabilityRefreshResult,
  BulkCreateCamerasResult,
  BulkCreateCameraResult,
  Camera,
  CameraCapabilities,
  CameraHealth,
  CameraHealthReport,
  CameraStatus,
  CameraValidationInput,
  CameraValidationResult,
  CameraOperationalHealth,
  StreamProbeResult,
  DiscoverCamerasInput,
  DiscoverCamerasResult,
  DiscoveredCamera,
  StreamConnection,
  UpdateCameraInput,
} from '@vip/contracts';
import type { TenantScope, TenantRepository } from '@vip/tenancy';
import type { SecretBox } from '@vip/crypto';
import { MongoServerError } from 'mongodb';
import {
  applyCameraUpdate,
  defaultCapabilities,
  defaultMetadata,
  newCamera,
  toCamera,
  validateCameraConfig,
  type Clock,
  type IdGen,
  type CameraDoc,
} from '../domain/camera.js';
import {
  appendTimeline,
  derivedLifecycle,
  healthFromProbe,
  stateForProbe,
  transition,
  LifecycleError,
} from '../domain/lifecycle.js';
import { buildMatchIndex, matchDevice } from '../domain/identity.js';
import {
  capabilityRefreshDecision,
  declaredCache,
  recordRefresh,
} from '../domain/capability-cache.js';
import { summarizeHealth } from '../domain/health-history.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';
import { UnavailableDiscoveryProvider, type DiscoveryProvider } from './discovery.js';
import { UnavailableStreamProbe, type StreamProbe } from './stream-probe.js';

const DUPLICATE_KEY = 11000;

/** Best-effort label for a bulk row that failed validation — an index alone is hard to act on. */
function nameOf(raw: unknown): string {
  const name = (raw as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.length > 0 ? name.slice(0, 200) : '(unnamed)';
}

export interface CameraServiceDeps {
  cameras: TenantRepository<CameraDoc>;
  vault: SecretBox;
  clock: Clock;
  ids: IdGen;
  publisher?: EventPublisher;
  /** Network discovery (P-1). Absent = a deployment that onboards from a list of URLs. */
  discovery?: DiscoveryProvider;
  /** Stream validation (P-2). Absent = a deployment that cannot measure a camera, and says so. */
  probe?: StreamProbe;
}

export class CameraService {
  private readonly cameras: TenantRepository<CameraDoc>;
  private readonly vault: SecretBox;
  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly publisher: EventPublisher;
  private readonly discovery: DiscoveryProvider;
  private readonly streamProbe: StreamProbe;

  constructor(deps: CameraServiceDeps) {
    this.cameras = deps.cameras;
    this.vault = deps.vault;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
    this.discovery = deps.discovery ?? new UnavailableDiscoveryProvider();
    this.streamProbe = deps.probe ?? new UnavailableStreamProbe();
  }

  /**
   * Onboard a camera under the caller's tenant. Credentials (if any) are sealed before persistence.
   *
   * **Validation gates onboarding** (Architect P-1 rec 4): a configuration that fails the
   * deterministic checks is refused rather than stored, because a camera that can never connect is
   * not an inventory entry — it is a support ticket with a name. What is *not* gated here is live
   * connectivity: proving that needs the network, and an installer configuring cameras from an
   * office must still be able to onboard them. That proof is `probeConnection`, and until it runs
   * the camera stays at `configured` and claims nothing.
   */
  async create(scope: TenantScope, input: CreateCameraInput): Promise<Camera> {
    const validation = validateCameraConfig({
      protocol: input.protocol,
      streamUrl: input.streamUrl,
      ...(input.credentials ? { credentials: input.credentials } : {}),
      ...(input.capture ? { capture: input.capture } : {}),
    });
    if (!validation.valid) {
      const failed = validation.checks.filter((c) => !c.passed && !c.informational);
      throw badRequest(
        `configuration is not valid: ${failed.map((c) => c.message ?? c.name).join('; ')}`,
      );
    }
    const cipher = input.credentials ? this.vault.seal(JSON.stringify(input.credentials)) : null;
    const doc = newCamera(scope.tenantId, this.ids.cameraId(), input, cipher, this.clock.now());
    try {
      await this.cameras.insertOne(scope, doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
        throw conflict(`a camera with this stream URL already exists in this tenant`);
      }
      throw err;
    }
    await this.publisher.publish({
      type: 'camera.registered',
      tenantId: scope.tenantId,
      payload: { cameraId: doc._id, zoneId: doc.zoneId, protocol: doc.protocol },
    });
    return toCamera(doc);
  }

  /** List the caller tenant's cameras (guard-isolated). Credentials are never included. */
  async list(scope: TenantScope): Promise<Camera[]> {
    const docs = await this.cameras.findMany(scope, {});
    return docs.map((d) => toCamera(d as CameraDoc));
  }

  /** Get one camera within scope, or 404 (also the cross-tenant response — no existence leak). */
  async get(scope: TenantScope, cameraId: string): Promise<Camera> {
    return toCamera(await this.require(scope, cameraId));
  }

  /** Update a camera. A new `streamUrl` must keep the (immutable) protocol's scheme. */
  async update(scope: TenantScope, cameraId: string, patch: UpdateCameraInput): Promise<Camera> {
    const existing = await this.require(scope, cameraId);
    if (patch.streamUrl && !patch.streamUrl.toLowerCase().startsWith(existing.protocol)) {
      throw badRequest(`streamUrl scheme must match protocol "${existing.protocol}"`);
    }
    const cipher = patch.credentials
      ? this.vault.seal(JSON.stringify(patch.credentials))
      : undefined;
    const at = this.clock.now();
    const updated = applyCameraUpdate(existing, patch, cipher, at);
    // P-2: record what changed, because a camera that stopped connecting an hour after someone
    // rotated its credentials is a five-second diagnosis with this line and an afternoon without it.
    const timeline = appendTimeline(
      existing.timeline ?? [],
      ...(cipher !== undefined
        ? [
            {
              at: at.toISOString(),
              kind: 'credentials-updated' as const,
              evidence: 'declared' as const,
              detail: 'credentials were re-vaulted',
            },
          ]
        : []),
      ...(patch.streamUrl || patch.capture || patch.capabilities
        ? [
            {
              at: at.toISOString(),
              kind: 'configuration-updated' as const,
              evidence: 'declared' as const,
              detail: [
                patch.streamUrl ? 'stream URL' : null,
                patch.capture ? 'capture profile' : null,
                patch.capabilities ? 'capabilities' : null,
              ]
                .filter(Boolean)
                .join(', '),
            },
          ]
        : []),
    );
    await this.cameras.updateOne(
      scope,
      { _id: cameraId },
      {
        $set: {
          name: updated.name,
          zoneId: updated.zoneId,
          streamUrl: updated.streamUrl,
          status: updated.status,
          capture: updated.capture,
          // Backfill defaults so a pre-G-1 camera gains these fields on its next write.
          capabilities:
            updated.capabilities ?? defaultCapabilities(updated.protocol, updated.capture),
          metadata: updated.metadata ?? defaultMetadata(),
          timeline,
          credentialCipher: updated.credentialCipher,
          updatedAt: updated.updatedAt,
        },
      },
    );
    await this.publisher.publish({
      type: 'camera.updated',
      tenantId: scope.tenantId,
      payload: { cameraId, credentialsRotated: cipher !== undefined },
    });
    return toCamera({ ...updated, timeline });
  }

  /** Remove a camera from the inventory (ingestion should stop consuming it). */
  async remove(scope: TenantScope, cameraId: string): Promise<void> {
    await this.require(scope, cameraId);
    await this.cameras.deleteOne(scope, { _id: cameraId });
    await this.publisher.publish({
      type: 'camera.removed',
      tenantId: scope.tenantId,
      payload: { cameraId },
    });
  }

  /** Report a camera's observed health (populated by the ingestion/health path in P1-4). */
  async health(scope: TenantScope, cameraId: string): Promise<CameraHealthReport> {
    const doc = await this.require(scope, cameraId);
    return { cameraId, ...doc.health };
  }

  /** A camera's declared capabilities (P2-2 G-1), defaulting for pre-G-1 documents. */
  async capabilities(scope: TenantScope, cameraId: string): Promise<CameraCapabilities> {
    const doc = await this.require(scope, cameraId);
    return doc.capabilities ?? defaultCapabilities(doc.protocol, doc.capture);
  }

  /** Validate a candidate configuration before onboarding (P2-2 G-1) — pure, no persistence. */
  validateConfig(input: CameraValidationInput): CameraValidationResult {
    return validateCameraConfig(input);
  }

  /**
   * Probe the network for ONVIF devices and reconcile the answers against this tenant (P-1).
   *
   * **Reconciliation is the part that matters.** A raw device list is nearly useless to an installer
   * re-scanning a site they half-configured last week: they cannot tell which of the twelve results
   * are already watched. So every device is matched against the tenant's existing cameras by stream
   * URL and marked `alreadyOnboarded` — shown, not hidden, because a device *missing* from the list
   * means it did not answer, and that is a different problem entirely.
   *
   * Discovery never persists anything. It returns candidates; onboarding is a separate, deliberate act.
   */
  async discover(scope: TenantScope, input: DiscoverCamerasInput): Promise<DiscoverCamerasResult> {
    const probe = await this.discovery.probe({ timeoutSeconds: input.timeoutSeconds });
    const existing = (await this.cameras.findMany(scope, {})) as CameraDoc[];
    // P-2: matched on DEVICE identity first, network identity second. A camera whose DHCP lease
    // moved it to a new address is the same camera; matching on URL alone would offer it as a new
    // device, and the installer would onboard the same hardware twice.
    const index = buildMatchIndex(existing);

    const devices: DiscoveredCamera[] = probe.devices.map((device) => {
      const match = matchDevice(index, device);
      return {
        endpoint: device.endpoint,
        ...(device.address ? { address: device.address } : {}),
        metadata: device.metadata,
        capabilities: device.capabilities,
        ...(device.suggestedStreamUrl ? { suggestedStreamUrl: device.suggestedStreamUrl } : {}),
        ...(device.registryId ? { registryId: device.registryId } : {}),
        ...(device.warning ? { warning: device.warning } : {}),
        ...(device.identity ? { identity: device.identity } : {}),
        alreadyOnboarded: match !== null,
        ...(match ? { cameraId: match.camera._id } : {}),
        addressChanged: match?.addressChanged ?? false,
      };
    });

    return {
      devices,
      probedSeconds: probe.probedSeconds,
      ...(input.subnet ? { subnet: input.subnet } : {}),
      ...(probe.unavailable ? { unavailable: probe.unavailable } : {}),
    };
  }

  /**
   * Onboard several cameras in one call (P-1) — the DVR/NVR case, where one device publishes 8, 16
   * or 32 channels.
   *
   * **Partial success is the expected outcome, not an error.** One duplicate channel must not
   * discard the other fifteen, so each camera is created independently and its outcome recorded.
   * Wrapping this in a transaction would be worse: an installer who mistyped channel 7 would lose
   * the six that were right and have to do the whole DVR again.
   */
  async createMany(
    scope: TenantScope,
    input: BulkCreateCamerasInput,
  ): Promise<BulkCreateCamerasResult> {
    const results: BulkCreateCameraResult[] = [];
    for (const [index, raw] of input.cameras.entries()) {
      // Validated here, per item, rather than at the envelope — see BulkCreateCamerasInput. A
      // malformed row must be reported as a row, not turn the whole request into a 400.
      const parsed = CreateCameraInput.safeParse(raw);
      if (!parsed.success) {
        results.push({
          index,
          name: nameOf(raw),
          created: false,
          error: parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'camera'}: ${issue.message}`)
            .join('; ')
            .slice(0, 500),
        });
        continue;
      }
      const candidate = parsed.data;
      try {
        const camera = await this.create(scope, candidate);
        results.push({ index, name: candidate.name, created: true, camera });
      } catch (err) {
        results.push({
          index,
          name: candidate.name,
          created: false,
          error: err instanceof Error ? err.message : 'could not onboard this camera',
        });
      }
    }
    return {
      results,
      created: results.filter((r) => r.created).length,
      failed: results.filter((r) => !r.created).length,
    };
  }

  /** Validate an existing camera's stored configuration (P2-2 G-1). */
  async validateExisting(scope: TenantScope, cameraId: string): Promise<CameraValidationResult> {
    const doc = await this.require(scope, cameraId);
    return validateCameraConfig({
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      capture: doc.capture,
      ...(doc.credentialCipher
        ? { credentials: { username: 'vaulted', password: 'vaulted' } }
        : {}),
    });
  }

  /**
   * Actively re-check a camera's health (P2-2 G-1) and record the snapshot. Deterministic: it runs
   * the configuration validation (no network). An invalid config → `unhealthy`; a valid config keeps
   * its current observed status (live connectivity is proven by ingestion, Media enabler G-2) but
   * refreshes `lastCheckedAt`. Returns the recorded report.
   */
  async checkHealth(scope: TenantScope, cameraId: string): Promise<CameraHealthReport> {
    const doc = await this.require(scope, cameraId);
    const result = validateCameraConfig({
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      capture: doc.capture,
    });
    const at = this.clock.now().toISOString();
    const health: CameraHealth = result.valid
      ? { status: doc.health.status, lastCheckedAt: at }
      : {
          status: 'unhealthy',
          lastCheckedAt: at,
          detail: `configuration invalid: ${result.checks
            .filter((c) => !c.passed && !c.informational)
            .map((c) => c.name)
            .join(', ')}`,
        };
    await this.cameras.updateOne(scope, { _id: cameraId }, { $set: { health, updatedAt: at } });
    await this.publisher.publish({
      type: 'camera.health.checked',
      tenantId: scope.tenantId,
      payload: { cameraId, status: health.status },
    });
    return { cameraId, ...health };
  }

  /** Set a camera's administrative status (P2-2 G-1 enable/disable convenience). */
  async setStatus(scope: TenantScope, cameraId: string, status: CameraStatus): Promise<Camera> {
    const doc = await this.require(scope, cameraId);
    const at = this.clock.now().toISOString();
    await this.cameras.updateOne(scope, { _id: cameraId }, { $set: { status, updatedAt: at } });
    await this.publisher.publish({
      type: 'camera.updated',
      tenantId: scope.tenantId,
      payload: { cameraId, credentialsRotated: false },
    });
    return toCamera({ ...doc, status, updatedAt: at });
  }

  // --- P-2: lifecycle, measured health, capability cache -------------------------------------

  /**
   * Test a camera's connection against the physical device and record what was measured.
   *
   * This is the only path by which a camera reaches `connected`, and the rule it enforces is the
   * one that keeps the whole state machine honest: **a probe that did not touch hardware moves
   * nothing**. A simulated or file-backed probe still returns its full check list — the console
   * shows it, and it is genuinely useful for debugging the platform — but the lifecycle does not
   * advance, because nothing was learned about a camera.
   *
   * `unavailable` (no probe configured) is reported distinctly from a probe that ran and failed.
   */
  async probeConnection(scope: TenantScope, cameraId: string): Promise<CameraProbeReport> {
    const doc = await this.require(scope, cameraId);
    const lifecycle = doc.lifecycle ?? derivedLifecycle(doc.createdAt);
    const credentials = this.openCredentials(doc);

    const outcome = await this.streamProbe.probe({
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      ...(credentials ? { credentials } : {}),
      ...(doc.capabilities ? { capabilities: doc.capabilities } : {}),
    });
    if (!outcome.result) {
      return {
        cameraId,
        lifecycle,
        unavailable: outcome.unavailable ?? 'the stream validator returned no result',
      };
    }

    const result = outcome.result;
    const at = this.clock.now();
    const operational = healthFromProbe(result);
    const target = stateForProbe(result);

    const entries: (CameraTimelineEntry | null)[] = [
      {
        at: operational.observedAt,
        kind: result.framesRead > 0 ? 'probe-succeeded' : 'probe-failed',
        evidence: 'measured',
        detail: this.probeDetail(result),
      },
    ];

    let next = lifecycle;
    if (target !== null && lifecycle.state !== 'retired') {
      // A retired camera is skipped rather than refused: a scheduled probe reaching a decommissioned
      // device is an observation, not an operator decision, and it must not throw.
      const moved = transition(lifecycle, {
        to: target,
        evidence: 'measured',
        evidenceClass: result.evidenceClass,
        reason: this.probeDetail(result),
        at,
      });
      next = moved.lifecycle;
      entries.push(moved.entry);
    }

    const timeline = appendTimeline(doc.timeline ?? [], ...entries);
    await this.cameras.updateOne(
      scope,
      { _id: cameraId },
      {
        $set: {
          lifecycle: next,
          timeline,
          operational,
          health: this.rollupHealth(operational, at),
          updatedAt: at.toISOString(),
        },
      },
    );
    await this.publisher.publish({
      type: 'camera.health.checked',
      tenantId: scope.tenantId,
      payload: { cameraId, status: this.rollupHealth(operational, at).status },
    });
    return { cameraId, probe: result, operational, lifecycle: next };
  }

  /**
   * Read a camera's capabilities, going back to the device only when that is warranted (P-2).
   *
   * The decision is the product here, not the read: an ONVIF negotiation is several round trips
   * against an embedded web server, and a platform that re-queries on every session start is a
   * platform whose cameras eventually stop answering.
   */
  async refreshCapabilities(
    scope: TenantScope,
    cameraId: string,
    options: { force?: boolean } = {},
  ): Promise<CapabilityRefreshResult> {
    const doc = await this.require(scope, cameraId);
    const capabilities = doc.capabilities ?? defaultCapabilities(doc.protocol, doc.capture);
    const cache = doc.capabilityCache ?? declaredCache();
    const at = this.clock.now();

    const decision = capabilityRefreshDecision({
      cache,
      now: at,
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(doc.operational?.firmware ? { observedFirmware: doc.operational.firmware } : {}),
    });
    if (!decision.refresh) {
      return { cameraId, capabilities, cache, reason: decision.reason, refreshed: false };
    }

    // A directed negotiation of this one device — not a broadcast. The device is identified by the
    // endpoint discovery recorded; without one there is nothing to address, and saying so beats
    // re-scanning the whole segment on a per-camera button press.
    const endpoint = doc.identity?.lastKnownAddress;
    if (!endpoint) {
      const updated = recordRefresh(cache, { reason: decision.reason, refreshed: false, at });
      await this.cameras.updateOne(
        scope,
        { _id: cameraId },
        { $set: { capabilityCache: updated, updatedAt: at.toISOString() } },
      );
      return {
        cameraId,
        capabilities,
        cache: updated,
        reason: decision.reason,
        refreshed: false,
        unavailable:
          'this camera has no discovered device address, so it cannot be queried directly — run discovery first',
      };
    }

    const found = await this.discovery.probe({ timeoutSeconds: 5, endpoint });
    const device = found.devices[0];
    if (!device) {
      const updated = recordRefresh(cache, { reason: decision.reason, refreshed: false, at });
      await this.cameras.updateOne(
        scope,
        { _id: cameraId },
        { $set: { capabilityCache: updated, updatedAt: at.toISOString() } },
      );
      return {
        cameraId,
        capabilities,
        cache: updated,
        reason: decision.reason,
        refreshed: false,
        unavailable: found.unavailable ?? 'the device did not answer',
      };
    }

    const firmware = device.metadata.firmware;
    const updatedCache = recordRefresh(cache, {
      reason: decision.reason,
      refreshed: true,
      at,
      ...(firmware ? { firmware } : {}),
    });
    const firmwareMoved = Boolean(firmware && cache.firmware && firmware !== cache.firmware);
    const timeline = appendTimeline(
      doc.timeline ?? [],
      ...(firmwareMoved
        ? [
            {
              at: at.toISOString(),
              kind: 'firmware-changed' as const,
              evidence: 'measured' as const,
              detail: `firmware changed from ${cache.firmware} to ${firmware}`,
            },
          ]
        : []),
      {
        at: at.toISOString(),
        kind: 'capability-refreshed' as const,
        evidence: 'measured' as const,
        detail: decision.detail,
      },
    );

    await this.cameras.updateOne(
      scope,
      { _id: cameraId },
      {
        $set: {
          capabilities: device.capabilities,
          capabilityCache: updatedCache,
          timeline,
          updatedAt: at.toISOString(),
        },
      },
    );
    return {
      cameraId,
      capabilities: device.capabilities,
      cache: updatedCache,
      reason: decision.reason,
      refreshed: true,
    };
  }

  /**
   * Decommission a camera without destroying it.
   *
   * **Retire is not delete.** Deleting a camera throws away the timeline an incident investigation
   * six months from now may need to explain why there is no footage of something. Retiring keeps the
   * record and its evidence, stops ingestion, and makes the state explicit so a later probe cannot
   * quietly bring it back (see `transition`).
   */
  async retire(scope: TenantScope, cameraId: string, reason = 'retired by an operator') {
    return this.administrative(scope, cameraId, 'retired', reason, 'disabled');
  }

  /** Return a retired camera to service. It re-enters at `configured` and re-earns everything else. */
  async reinstate(scope: TenantScope, cameraId: string, reason = 'reinstated by an operator') {
    return this.administrative(scope, cameraId, 'configured', reason, 'enabled');
  }

  /** Trends over a camera's recorded timeline (P-2). Computed, never stored. */
  async healthSummary(
    scope: TenantScope,
    cameraId: string,
    options: { windowHours?: number } = {},
  ): Promise<CameraHealthSummary> {
    const doc = await this.require(scope, cameraId);
    const windowEnd = this.clock.now();
    const windowStart = new Date(windowEnd.getTime() - (options.windowHours ?? 24) * 3_600_000);
    const latency = doc.operational?.rtspLatencyMs;
    return summarizeHealth({
      cameraId,
      timeline: doc.timeline ?? [],
      windowStart,
      windowEnd,
      ...(latency !== undefined ? { latencySamples: [latency] } : {}),
    });
  }

  /** Shared implementation of the two administrative transitions. */
  private async administrative(
    scope: TenantScope,
    cameraId: string,
    to: CameraLifecycleState,
    reason: string,
    status: CameraStatus,
  ): Promise<Camera> {
    const doc = await this.require(scope, cameraId);
    const lifecycle = doc.lifecycle ?? derivedLifecycle(doc.createdAt);
    const at = this.clock.now();
    let moved;
    try {
      moved = transition(lifecycle, { to, evidence: 'administrative', reason, at });
    } catch (err) {
      throw err instanceof LifecycleError ? badRequest(err.message) : err;
    }
    const timeline = appendTimeline(doc.timeline ?? [], moved.entry);
    await this.cameras.updateOne(
      scope,
      { _id: cameraId },
      { $set: { lifecycle: moved.lifecycle, timeline, status, updatedAt: at.toISOString() } },
    );
    await this.publisher.publish({
      type: 'camera.updated',
      tenantId: scope.tenantId,
      payload: { cameraId, credentialsRotated: false },
    });
    return toCamera({
      ...doc,
      lifecycle: moved.lifecycle,
      timeline,
      status,
      updatedAt: at.toISOString(),
    });
  }

  /** One line an installer can act on, assembled from the first check that actually failed. */
  private probeDetail(result: StreamProbeResult): string {
    const failed = result.checks.find((c) => c.status === 'fail');
    if (failed) {
      return `${failed.name} failed${failed.detail ? `: ${failed.detail}` : ''}`.slice(0, 300);
    }
    if (result.framesRead === 0) return (result.error ?? 'no frames were received').slice(0, 300);
    return `read ${result.framesRead} frames${result.resolution ? ` at ${result.resolution}` : ''}`;
  }

  /**
   * Collapse a measured observation into the coarse `CameraHealth` rollup the list view shows.
   *
   * A probe that never touched hardware refreshes the timestamp and nothing else: it measured the
   * platform, not the camera, and overwriting an operator's view of a real device with a simulation
   * result is the same mistake as certifying hardware from a simulation.
   */
  private rollupHealth(operational: CameraOperationalHealth, at: Date): CameraHealth {
    if (operational.evidenceClass !== 'hardware') {
      return {
        status: 'unknown',
        lastCheckedAt: at.toISOString(),
        detail: 'not measured on hardware',
      };
    }
    const status = !operational.reachable
      ? 'offline'
      : operational.streamAvailable
        ? 'online'
        : 'unhealthy';
    return {
      status,
      lastCheckedAt: at.toISOString(),
      ...(operational.detail ? { detail: operational.detail } : {}),
    };
  }

  /** Decrypt vaulted credentials for a transient internal use. Never logged, never persisted. */
  private openCredentials(doc: CameraDoc): { username: string; password: string } | null {
    if (!doc.credentialCipher) return null;
    return JSON.parse(this.vault.open(doc.credentialCipher)) as {
      username: string;
      password: string;
    };
  }

  /**
   * Resolve a camera's stream connection descriptor, **decrypting its vaulted credentials** — the
   * single sanctioned decryption point. For internal service-to-service use only (media, P1-4);
   * never exposed on a user-facing route. The plaintext is returned transiently and never stored.
   */
  async resolveConnection(scope: TenantScope, cameraId: string): Promise<StreamConnection> {
    const doc = await this.require(scope, cameraId);
    const creds = doc.credentialCipher
      ? (JSON.parse(this.vault.open(doc.credentialCipher)) as {
          username: string;
          password: string;
        })
      : null;
    return {
      cameraId: doc._id,
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      ...(creds ? { username: creds.username, password: creds.password } : {}),
    };
  }

  /** Fetch a camera within scope or throw 404 (shared by get/update/remove/health). */
  private async require(scope: TenantScope, cameraId: string): Promise<CameraDoc> {
    const doc = (await this.cameras.findOne(scope, { _id: cameraId })) as CameraDoc | null;
    if (!doc) throw notFound(`camera "${cameraId}" not found`);
    return doc;
  }
}
