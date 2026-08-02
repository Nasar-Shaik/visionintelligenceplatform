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
  CameraEvidenceTimeline,
  CameraHealthSummary,
  CameraLifecycleState,
  CameraProbeMetrics,
  CameraProbeRecord,
  CameraProbeReport,
  CameraProbeHistory,
  CameraTimelineEntry,
  FleetProbeMetrics,
  OperationalConfidence,
  ProbeReplay,
  CapabilityRefreshResult,
  CameraIdentityChange,
  CapabilityChange,
  HealthTrendWindow,
  TimelineReasonCode,
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
import {
  appendIdentityHistory,
  buildMatchIndex,
  confidenceFor,
  identityChanges,
  identityKey,
  matchDevice,
  mergeIdentity,
} from '../domain/identity.js';
import { classifyDrift, diffCapabilities, highestSeverity } from '../domain/capability-diff.js';
import {
  buildProbeRecord,
  replayProbe,
  toProbeRecord,
  PROBE_RETENTION,
  type ProbeRecordDoc,
} from '../domain/probe-archive.js';
import { recordCompatibility } from '../domain/compatibility.js';
import { operationalConfidence } from '../domain/confidence.js';
import { fleetMetrics, inWindow, probeMetrics } from '../domain/probe-metrics.js';
import { evidenceTimeline } from '../domain/evidence-timeline.js';
import {
  capabilityRefreshDecision,
  declaredCache,
  freshnessOf,
  recordRefresh,
} from '../domain/capability-cache.js';
import { WINDOW_HOURS, summarizeHealth } from '../domain/health-history.js';
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

/**
 * The runtime's typed failure code → the timeline's typed reason code (P-2.1 rec 7/8).
 *
 * A mapping, not a re-derivation: the runtime already decided *why* the probe failed, and inferring
 * it a second time from the same evidence is how two components come to disagree about one event.
 */
function reasonCodeForProbe(result: StreamProbeResult): TimelineReasonCode {
  if (result.framesRead > 0) return 'hardware-evidence';
  switch (result.failureCode) {
    case 'authentication-failure':
      return 'authentication-failure';
    case 'dns-failure':
    case 'tcp-failure':
      return 'device-unreachable';
    case 'rtsp-negotiation-failure':
    case 'timeout':
    case 'no-first-frame':
    case 'stream-interrupted':
    case 'codec-unsupported':
      return 'stream-unavailable';
    default:
      return 'hardware-evidence';
  }
}

function reasonCodeForRefresh(reason: CapabilityRefreshResult['reason']): TimelineReasonCode {
  switch (reason) {
    case 'firmware-changed':
      return 'firmware-updated';
    case 'stale':
      return 'cache-expired';
    case 'never-discovered':
      return 'cache-version-changed';
    default:
      return 'operator-action';
  }
}

/** One line naming what actually changed, led by the most severe class. */
function summarizeChanges(changes: readonly CapabilityChange[]): string {
  const severity = highestSeverity(changes);
  const fields = changes
    .map((c) => c.field)
    .slice(0, 6)
    .join(', ');
  return `${severity ?? 'no'} change: ${fields}`.slice(0, 300);
}

export interface CameraServiceDeps {
  cameras: TenantRepository<CameraDoc>;
  /**
   * The immutable probe archive (P-2.2). **Required, not optional**: an evidence store that a
   * deployment can forget to wire is one that will be forgotten, and the failure is silent — every
   * probe would still work and the history would simply never exist.
   */
  probes: TenantRepository<ProbeRecordDoc>;
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
  private readonly probes: TenantRepository<ProbeRecordDoc>;
  private readonly vault: SecretBox;
  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly publisher: EventPublisher;
  private readonly discovery: DiscoveryProvider;
  private readonly streamProbe: StreamProbe;

  constructor(deps: CameraServiceDeps) {
    this.cameras = deps.cameras;
    this.probes = deps.probes;
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
              reasonCode: 'credentials-rotated' as const,
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
              reasonCode: 'configuration-changed' as const,
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
        // Reported, never assumed (P-2.1 rec 3). A `low` match rests on a network address, and
        // addresses get reassigned — merging two cameras on that basis is worse than a duplicate.
        identityConfidence: match
          ? confidenceFor(match.matchedOn, identityKey(device.identity))
          : 'unknown',
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

    const probeId = this.ids.probeId();
    const previous = await this.latestProbe(scope, cameraId);
    const outcome = await this.streamProbe.probe({
      protocol: doc.protocol,
      streamUrl: doc.streamUrl,
      ...(credentials ? { credentials } : {}),
      ...(doc.capabilities ? { capabilities: doc.capabilities } : {}),
    });
    const at = this.clock.now();

    if (!outcome.result) {
      // A probe that could not run is still recorded (P-2.2 rec 2). It measured nothing about the
      // camera, and that is the point: a gap in the evidence with a timestamp on it is what lets
      // somebody line "we stopped being able to test cameras" up against a deployment.
      await this.archive(
        scope,
        buildProbeRecord({
          probeId,
          cameraId,
          at,
          doc,
          result: null,
          lifecycleBefore: lifecycle.state,
          lifecycleAfter: lifecycle.state,
          sequence: (doc.probeCount ?? 0) + 1,
          previous,
        }),
        doc,
      );
      return {
        cameraId,
        lifecycle,
        unavailable: outcome.unavailable ?? 'the stream validator returned no result',
      };
    }

    const result = outcome.result;
    const operational = healthFromProbe(result);
    const target = stateForProbe(result);

    const entries: (CameraTimelineEntry | null)[] = [
      {
        at: operational.observedAt,
        kind: result.framesRead > 0 ? 'probe-succeeded' : 'probe-failed',
        evidence: 'measured',
        // The runtime named the failure; the service records that name rather than re-deriving it
        // from prose (P-2.1 rec 7/8).
        reasonCode: reasonCodeForProbe(result),
        probeVersion: result.probeVersion,
        ...(result.correlationId ? { correlationId: result.correlationId } : {}),
        // The report behind this line, addressable (P-2.2 rec 2). A timeline entry that describes a
        // measurement without pointing at it makes the reader take the summary on trust.
        probeId,
        ...(result.totalMs !== undefined ? { durationMs: result.totalMs } : {}),
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
        reasonCode: 'hardware-evidence',
        reason: this.probeDetail(result),
        at,
        probeVersion: result.probeVersion,
        ...(result.correlationId ? { correlationId: result.correlationId } : {}),
      });
      next = moved.lifecycle;
      entries.push(moved.entry ? { ...moved.entry, probeId } : null);
    }

    const record = buildProbeRecord({
      probeId,
      cameraId,
      at,
      doc,
      result,
      lifecycleBefore: lifecycle.state,
      lifecycleAfter: next.state,
      sequence: (doc.probeCount ?? 0) + 1,
      previous,
    });
    await this.archive(scope, record, doc);

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
          // What this camera has now been proven to work under (P-2.2 rec 5). Folded here rather
          // than derived on read because the register accumulates across probes that retention will
          // eventually age out — the counters must outlive the reports that produced them.
          compatibility: recordCompatibility(doc.compatibility ?? [], record),
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

  // --- P-2.2: the immutable probe archive ------------------------------------------------------

  /**
   * A camera's retained probe reports, most recent first (P-2.2 rec 2).
   *
   * `evicted` is what stops a trimmed archive from reading as a complete one: three retained reports
   * from a camera with a hundred and forty probes behind it is a very different picture from three
   * probes total, and the list alone cannot tell them apart.
   */
  async probeHistory(
    scope: TenantScope,
    cameraId: string,
    options: { limit?: number } = {},
  ): Promise<CameraProbeHistory> {
    const doc = await this.require(scope, cameraId);
    const records = await this.recordsFor(scope, cameraId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), PROBE_RETENTION);
    const total = doc.probeCount ?? records.length;
    return {
      cameraId,
      records: records.slice(0, limit),
      total,
      retained: records.length,
      evicted: Math.max(0, total - records.length),
    };
  }

  /**
   * Reconstruct one stored probe without contacting the camera (P-2.2 rec 6).
   *
   * The comparison against the preceding probe travels with it, because a replayed report on its own
   * says what happened and the pair says what *changed* — and the change is what a support engineer
   * opened the page to find.
   */
  async replay(scope: TenantScope, cameraId: string, probeId: string): Promise<ProbeReplay> {
    await this.require(scope, cameraId);
    const doc = (await this.probes.findOne(scope, { _id: probeId })) as ProbeRecordDoc | null;
    if (!doc || doc.cameraId !== cameraId) throw notFound(`probe "${probeId}" not found`);
    const record = toProbeRecord(doc);
    const previous = record.previousProbeId
      ? ((await this.probes.findOne(scope, {
          _id: record.previousProbeId,
        })) as ProbeRecordDoc | null)
      : null;
    return replayProbe(record, this.clock.now(), previous ? toProbeRecord(previous) : null);
  }

  /** Probe performance for one camera over a window (P-2.2 rec 7). Computed, never stored. */
  async probeMetrics(
    scope: TenantScope,
    cameraId: string,
    options: { window?: HealthTrendWindow } = {},
  ): Promise<CameraProbeMetrics> {
    const doc = await this.require(scope, cameraId);
    const window = options.window ?? 'day';
    const { windowStart, windowEnd } = this.windowFor(window);
    return probeMetrics({
      cameraId,
      window,
      windowStart,
      windowEnd,
      records: await this.recordsFor(scope, cameraId),
      timeline: doc.timeline ?? [],
    });
  }

  /**
   * Every record a camera has, merged into one chronology (P-2.2 rec 8).
   *
   * The four stores stay separate on the write side — they have different bounds, keys and retention
   * rules — and are merged here on read. See `domain/evidence-timeline.ts` for why that split is the
   * right one rather than a compromise.
   */
  async evidence(
    scope: TenantScope,
    cameraId: string,
    options: { window?: HealthTrendWindow } = {},
  ): Promise<CameraEvidenceTimeline> {
    const doc = await this.require(scope, cameraId);
    const { windowStart, windowEnd } = this.windowFor(options.window ?? 'month');
    return evidenceTimeline({
      cameraId,
      from: windowStart,
      to: windowEnd,
      timeline: doc.timeline ?? [],
      identityHistory: doc.identityHistory ?? [],
      probes: await this.recordsFor(scope, cameraId),
      compatibility: doc.compatibility ?? [],
    });
  }

  /**
   * Probe performance across the whole tenant (P-2.2 rec 7) — the fleet dashboard's numbers.
   *
   * The same computation as the per-camera view over more records, so the dashboard and the camera
   * page can never disagree. Cameras that have never been probed are counted explicitly: a fleet
   * success rate computed over the handful anyone has tested is a green number describing a sample
   * nobody chose.
   */
  async fleetProbeMetrics(
    scope: TenantScope,
    options: { window?: HealthTrendWindow } = {},
  ): Promise<FleetProbeMetrics> {
    const window = options.window ?? 'day';
    const { windowStart, windowEnd } = this.windowFor(window);
    const cameras = (await this.cameras.findMany(scope, {})) as CameraDoc[];
    const records = ((await this.probes.findMany(scope, {})) as ProbeRecordDoc[]).map(
      toProbeRecord,
    );

    const confidenceScores: number[] = [];
    for (const camera of cameras) {
      const score = this.confidenceFor(camera, records, windowStart, windowEnd).score;
      if (score !== undefined) confidenceScores.push(score);
    }

    return fleetMetrics({
      window,
      windowStart,
      windowEnd,
      cameras: cameras.map((camera) => ({
        cameraId: camera._id,
        ...(camera.capabilityCache?.firmware ? { firmware: camera.capabilityCache.firmware } : {}),
        compatibilityStatuses: (camera.compatibility ?? []).map((row) => row.status),
      })),
      records,
      confidenceScores,
    });
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
      // Freshness is recomputed against the clock on every read — a stored value is wrong the moment
      // after it is written, which is the silent staleness this field exists to prevent.
      return {
        cameraId,
        capabilities,
        cache: { ...cache, freshness: freshnessOf(cache, at) },
        reason: decision.reason,
        refreshed: false,
        changes: [],
      };
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
        changes: [],
        unavailable:
          'this camera has no discovered device address, so it cannot be queried directly — run discovery first',
      };
    }

    const refreshStarted = this.clock.now();
    const found = await this.discovery.probe({ timeoutSeconds: 5, endpoint });
    const refreshMs = Math.max(0, this.clock.now().getTime() - refreshStarted.getTime());
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
        changes: [],
        unavailable: found.unavailable ?? 'the device did not answer',
      };
    }

    const firmware = device.metadata.firmware;
    // The diff is the product of a refresh, not a side effect of it: "capabilities refreshed" tells
    // an operator nothing, while "codecs h264 → h265, sub.resolution 640x360 → 3840x2160" tells them
    // their decode cost just changed by an order of magnitude (P-2.1 rec 2).
    const firmwareMoved = Boolean(firmware && cache.firmware && firmware !== cache.firmware);
    // Classified, not just listed (P-2.2 rec 3). "Codecs changed" and "codecs changed and nothing
    // explains it" are the same row until something attributes it, and only the second is a reason
    // to go and look at the camera.
    const changes = classifyDrift(diffCapabilities(doc.capabilities, device.capabilities), {
      firmwareChanged: firmwareMoved,
      firstObservation: doc.capabilities === undefined,
    });
    const unexpected = changes.filter((change) => change.drift === 'unexpected');
    const updatedCache = recordRefresh(cache, {
      reason: decision.reason,
      refreshed: true,
      at,
      source: 'onvif-directed',
      ...(firmware ? { firmware } : {}),
    });
    const timeline = appendTimeline(
      doc.timeline ?? [],
      ...(firmwareMoved
        ? [
            {
              at: at.toISOString(),
              kind: 'firmware-changed' as const,
              evidence: 'measured' as const,
              reasonCode: 'firmware-updated' as const,
              detail: `firmware changed from ${cache.firmware} to ${firmware}`,
            },
          ]
        : []),
      {
        at: at.toISOString(),
        kind: 'capability-refreshed' as const,
        evidence: 'measured' as const,
        reasonCode: reasonCodeForRefresh(decision.reason),
        // Cost of the refresh, so "average capability refresh time" is measured rather than guessed
        // at (P-2.2 rec 7).
        durationMs: refreshMs,
        detail:
          changes.length > 0
            ? `${unexpected.length > 0 ? 'unexpected' : 'expected'} ${summarizeChanges(changes)}`
            : 'no capabilities changed',
      },
    );

    // Identity is APPENDED to, never overwritten (P-2.1 rec 1). A device whose serial changed under
    // the same address is either a swapped unit or a re-used record, and both need to survive.
    const observedIdentity = device.identity;
    const idChanges: CameraIdentityChange[] = observedIdentity
      ? identityChanges(doc.identity, observedIdentity, { at, source: 'discovery' })
      : [];

    await this.cameras.updateOne(
      scope,
      { _id: cameraId },
      {
        $set: {
          capabilities: device.capabilities,
          capabilityCache: updatedCache,
          timeline: appendTimeline(
            timeline,
            ...idChanges.map((change) => ({
              at: change.at,
              kind: 'identity-changed' as const,
              evidence: 'measured' as const,
              reasonCode: 'address-changed' as const,
              detail: `${change.attribute}: ${change.from ?? '(unknown)'} → ${change.to}`,
            })),
          ),
          ...(observedIdentity ? { identity: mergeIdentity(doc.identity, observedIdentity) } : {}),
          ...(idChanges.length > 0
            ? { identityHistory: appendIdentityHistory(doc.identityHistory ?? [], ...idChanges) }
            : {}),
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
      changes,
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
    options: { window?: HealthTrendWindow } = {},
  ): Promise<CameraHealthSummary> {
    const doc = await this.require(scope, cameraId);
    const window = options.window ?? 'day';
    const { windowStart, windowEnd } = this.windowFor(window);
    const latency = doc.operational?.rtspLatencyMs;
    const records = await this.recordsFor(scope, cameraId);
    // Probe durations now come from the archive rather than from the single last measurement, so
    // "average probe time" is an average rather than a sample of one wearing the word.
    const probeSamples = records
      .filter((record) => inWindow(record.at, windowStart, windowEnd))
      .map((record) => record.result?.totalMs)
      .filter((value): value is number => value !== undefined);
    const summary = summarizeHealth({
      cameraId,
      timeline: doc.timeline ?? [],
      window,
      windowStart,
      windowEnd,
      ...(latency !== undefined ? { latencySamples: [latency] } : {}),
      ...(probeSamples.length > 0 ? { probeSamples } : {}),
    });
    return { ...summary, confidence: this.confidenceFor(doc, records, windowStart, windowEnd) };
  }

  /**
   * Append one record to the archive and advance the camera's probe counter.
   *
   * **There is no update path.** The archive is written with `insertOne` and read; nothing in this
   * service issues an update or a `$set` against it. Eviction deletes the oldest records whole,
   * which is a retention decision the history reports (`evicted`) — never an edit to what a report
   * said.
   */
  private async archive(
    scope: TenantScope,
    record: CameraProbeRecord,
    doc: CameraDoc,
  ): Promise<void> {
    const { probeId, ...rest } = record;
    await this.probes.insertOne(scope, { _id: probeId, ...rest });
    await this.cameras.updateOne(
      scope,
      { _id: record.cameraId },
      { $set: { probeCount: (doc.probeCount ?? 0) + 1 } },
    );
    const retained = await this.recordsFor(scope, record.cameraId);
    for (const stale of retained.slice(PROBE_RETENTION)) {
      await this.probes.deleteOne(scope, { _id: stale.probeId });
    }
  }

  /** A camera's records, newest first. Sorted here so the in-memory and Mongo paths agree exactly. */
  private async recordsFor(scope: TenantScope, cameraId: string): Promise<CameraProbeRecord[]> {
    const docs = (await this.probes.findMany(scope, { cameraId })) as ProbeRecordDoc[];
    // Ordered by the per-camera sequence, not by timestamp: two probes in the same millisecond are
    // ordinary (a retry, a scheduled sweep) and a time sort would leave their order to the storage
    // engine — taking the `previousProbeId` chain with it.
    return docs.map(toProbeRecord).sort((a, b) => b.sequence - a.sequence);
  }

  private async latestProbe(
    scope: TenantScope,
    cameraId: string,
  ): Promise<CameraProbeRecord | null> {
    return (await this.recordsFor(scope, cameraId))[0] ?? null;
  }

  private windowFor(window: HealthTrendWindow): { windowStart: Date; windowEnd: Date } {
    const windowEnd = this.clock.now();
    return {
      windowStart: new Date(windowEnd.getTime() - WINDOW_HOURS[window] * 3_600_000),
      windowEnd,
    };
  }

  /**
   * Operational confidence for one camera (P-2.2 rec 4) — never from a single probe.
   *
   * Assembled from four records rather than one because each catches something the others cannot: a
   * camera can stay nominally online and fail every probe, pass every probe and still have dropped
   * overnight, or work perfectly while its capabilities are rewritten underneath it.
   */
  private confidenceFor(
    doc: CameraDoc,
    records: readonly CameraProbeRecord[],
    windowStart: Date,
    windowEnd: Date,
  ): OperationalConfidence {
    const timeline = (doc.timeline ?? []).filter((entry) =>
      inWindow(entry.at, windowStart, windowEnd),
    );
    const summary = summarizeHealth({
      cameraId: doc._id,
      timeline: doc.timeline ?? [],
      window: 'day',
      windowStart,
      windowEnd,
    });
    return operationalConfidence({
      ...(summary.availabilityPercent !== undefined
        ? { availabilityPercent: summary.availabilityPercent }
        : {}),
      offlineCount: summary.offlineCount,
      credentialFailures: summary.credentialFailures,
      stateObservations: timeline.filter(
        (entry) => entry.kind === 'state-changed' && entry.evidence === 'measured',
      ).length,
      probes: records.filter(
        (r) => r.cameraId === doc._id && inWindow(r.at, windowStart, windowEnd),
      ),
      // Drift classification happens at refresh time and is recorded in the timeline's detail line;
      // what is counted here is the refresh events themselves, which is the signal the confidence
      // model wants — a device whose capabilities keep moving is a device to trust less.
      unexpectedCapabilityChanges: timeline.filter(
        (entry) => entry.kind === 'capability-refreshed' && entry.detail.startsWith('unexpected'),
      ).length,
      identityChanges: (doc.identityHistory ?? []).filter(
        (change) => inWindow(change.at, windowStart, windowEnd) && change.from !== undefined,
      ).length,
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
      moved = transition(lifecycle, {
        to,
        evidence: 'administrative',
        reasonCode: 'operator-action',
        reason,
        at,
      });
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
