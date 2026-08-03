/**
 * Application: Evidence use-cases — the single place lifecycle + custody logic lives. Every operation
 * is tenant-scoped via @vip/tenancy (fail-closed) and object access goes through a per-tenant
 * @vip/storage `TenantObjectStore`, so a principal can only ever touch its own tenant's bytes;
 * retrieval is **signed-URL only**. Registration is **idempotent** on the stable id. The media is
 * **immutable**: only the overlay/lifecycle/retention change, each mutation appending a hash-chained
 * custody entry. Never depends on any AI engine.
 */
import type {
  Evidence,
  EvidenceCustodyPage,
  EvidenceDownloadTarget,
  EvidenceManifest,
  EvidencePage,
  EvidenceQuery,
  PlaybackSession,
  RegisterEvidenceInput,
  SetRetentionInput,
  UpdateEvidenceMetadataInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { TenantObjectStore, type ObjectStore } from '@vip/storage';
import {
  applyMetadataUpdate,
  isPurgeEligible,
  newEvidence,
  nextRetention,
  toEvidence,
  type EvidenceDoc,
} from '../domain/evidence.js';
import {
  newCustodyEntry,
  toCustodyEntry,
  verifyChain,
  type CustodyDoc,
} from '../domain/custody.js';
import { resolveSession } from '../domain/playback.js';
import { sha256Hex } from '../domain/integrity.js';
import { badRequest, conflict, notFound } from './errors.js';
import type { CustodyLog, EvidenceStore } from './ports.js';
import { NoopEvidencePublisher, type EvidencePublisher } from './evidence-publisher.js';
import type { EvidenceMetrics } from './metrics.js';

export interface EvidenceServiceDeps {
  store: EvidenceStore;
  custody: CustodyLog;
  /** The untenanted StorageProvider (@vip/storage ObjectStore); wrapped per-tenant internally. */
  objectStore: ObjectStore;
  publisher?: EvidencePublisher;
  metrics?: EvidenceMetrics;
  now?: () => Date;
  newId?: () => string;
  downloadTtlSeconds: number;
  defaultRetentionDays: number;
}

export class EvidenceService {
  readonly #store: EvidenceStore;
  readonly #custody: CustodyLog;
  readonly #objectStore: ObjectStore;
  readonly #publisher: EvidencePublisher;
  #metrics: EvidenceMetrics | undefined;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #ttl: number;
  readonly #defaultRetentionDays: number;

  constructor(deps: EvidenceServiceDeps) {
    this.#store = deps.store;
    this.#custody = deps.custody;
    this.#objectStore = deps.objectStore;
    this.#publisher = deps.publisher ?? NoopEvidencePublisher;
    this.#metrics = deps.metrics;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
    this.#ttl = deps.downloadTtlSeconds;
    this.#defaultRetentionDays = deps.defaultRetentionDays;
  }

  useMetrics(metrics: EvidenceMetrics): void {
    this.#metrics = metrics;
  }

  // --- Registration (idempotent) ----------------------------------------------------------------

  /**
   * Register evidence for media already in storage. Verifies the object exists, resolves integrity
   * (precomputed, or hashed from the stored bytes), persists the manifest, and opens the custody log.
   * Idempotent: re-registering the same object returns the existing item unchanged.
   */
  async register(
    scope: TenantScope,
    actor: string,
    input: RegisterEvidenceInput,
  ): Promise<Evidence> {
    const store = this.#tenantStore(scope);
    const head = await store.head(input.storageKey);
    if (!head) throw badRequest(`no stored object at key "${input.storageKey}"`);

    const integrity = input.integrity ?? {
      algorithm: 'sha256' as const,
      hash: sha256Hex((await store.get(input.storageKey)).body),
      sizeBytes: head.size,
    };

    const doc = newEvidence({
      tenantId: scope.tenantId,
      createdBy: actor,
      input,
      integrity,
      now: this.#now(),
      defaultRetentionDays: this.#defaultRetentionDays,
    });

    const inserted = await this.#store.insert(scope, doc);
    if (!inserted) {
      // Same object already registered — idempotent: return the existing item.
      const existing = await this.#store.get(scope, doc._id);
      if (existing) {
        this.#metrics?.registrationsDeduplicated.inc();
        return toEvidence(existing);
      }
      throw conflict(`evidence "${doc._id}" exists but could not be read`);
    }

    await this.#appendCustody(scope, doc._id, 'created', actor, undefined, {
      kind: doc.kind,
      storageKey: doc.media.storageKey,
      hash: integrity.hash,
      source: doc.source,
    });
    this.#metrics?.registered.inc({ kind: doc.kind });
    await this.#publisher.publish({ type: 'evidence.created', evidence: toEvidence(doc) });
    return toEvidence(doc);
  }

  // --- Reads ------------------------------------------------------------------------------------

  async get(scope: TenantScope, id: string): Promise<Evidence> {
    return toEvidence(await this.#require(scope, id));
  }

  /** The canonical, storage-independent manifest (a projection of the record). */
  async manifest(scope: TenantScope, id: string): Promise<EvidenceManifest> {
    const e = await this.get(scope, id);
    return {
      id: e.id,
      tenantId: e.tenantId,
      kind: e.kind,
      source: e.source,
      capturedAt: e.capturedAt,
      ...(e.interval ? { interval: e.interval } : {}),
      media: e.media,
      metadata: e.metadata,
      ...(e.ai ? { ai: e.ai } : {}),
    };
  }

  async list(scope: TenantScope, query: EvidenceQuery): Promise<EvidencePage> {
    const { items, nextCursor } = await this.#store.list(scope, query);
    return {
      items: items.map(toEvidence),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  // --- Secure retrieval (signed URL + audited access) -------------------------------------------

  /** Resolve a short-lived signed download/playback URL. Records an audited `accessed` custody entry. */
  async download(
    scope: TenantScope,
    id: string,
    actor: string,
    reason?: string,
  ): Promise<EvidenceDownloadTarget> {
    const doc = await this.#require(scope, id);
    if (doc.status !== 'available') {
      throw conflict(`evidence "${id}" is not available (status: ${doc.status})`);
    }
    const store = this.#tenantStore(scope);
    const url = await store.presignGet(doc.media.storageKey, this.#ttl);
    await this.#appendCustody(scope, id, 'accessed', actor, reason, { via: 'signed-url' });
    this.#metrics?.downloads.inc();
    return {
      evidenceId: id,
      key: doc.media.storageKey,
      url,
      expiresInSeconds: this.#ttl,
      contentType: doc.media.contentType,
      sizeBytes: doc.media.integrity.sizeBytes,
    };
  }

  /**
   * Resolve a **playback session** over one evidence item (P-5.5).
   *
   * ⚠️ **Watching evidence is accessing evidence, and it is audited as such.** This issues a signed
   * URL exactly as `download` does; the only difference is what the operator does with it. Leaving
   * playback out of the custody log would mean an investigator could review a clip a hundred times
   * and the chain of custody would show nobody ever opened it — which is the one question a custody
   * log exists to answer. The entry records `via: 'playback'` so the two access routes stay
   * distinguishable.
   *
   * ⚠️ **Derived per request, never stored** (`PlaybackSession` decision 1). The signed URL expires
   * on its own schedule; a cached session would go stale while claiming to be current.
   */
  async playbackSession(
    scope: TenantScope,
    id: string,
    actor: string,
    reason?: string,
  ): Promise<PlaybackSession> {
    const doc = await this.#require(scope, id);
    if (doc.status !== 'available') {
      /*
       * ⚠️ A purged or expired item is a *conflict*, not a 404: the record exists and the reason it
       * cannot be played is information the investigator needs. "Not found" would suggest the
       * incident never had this evidence.
       */
      throw conflict(`evidence "${id}" is not available (status: ${doc.status})`);
    }
    const store = this.#tenantStore(scope);
    const url = await store.presignGet(doc.media.storageKey, this.#ttl);
    await this.#appendCustody(scope, id, 'accessed', actor, reason, { via: 'playback' });
    this.#metrics?.downloads.inc();
    return resolveSession(toEvidence(doc), {
      url,
      expiresInSeconds: this.#ttl,
      now: this.#now(),
    });
  }

  // --- Version-safe metadata (overlay only; media never touched) --------------------------------

  async updateMetadata(
    scope: TenantScope,
    id: string,
    actor: string,
    patch: UpdateEvidenceMetadataInput,
  ): Promise<Evidence> {
    const doc = await this.#require(scope, id);
    const { metadata, ai } = applyMetadataUpdate(doc, patch);
    const now = this.#now().toISOString();
    await this.#store.patch(scope, id, {
      metadata,
      ...(ai !== undefined ? { ai } : {}),
      updatedAt: now,
    });
    await this.#appendCustody(scope, id, 'metadata-updated', actor, patch.reason, {
      metadataVersion: metadata.metadataVersion,
    });
    this.#metrics?.metadataUpdates.inc();
    const updated = await this.#require(scope, id);
    return toEvidence(updated);
  }

  // --- Retention / legal hold (audited) ---------------------------------------------------------

  async setRetention(
    scope: TenantScope,
    id: string,
    actor: string,
    input: SetRetentionInput,
  ): Promise<Evidence> {
    const doc = await this.#require(scope, id);
    const retention = nextRetention(doc, input);
    const now = this.#now().toISOString();
    const patch: Partial<EvidenceDoc> = { retention, updatedAt: now };
    if (input.tier) patch.media = { ...doc.media, tier: input.tier };
    await this.#store.patch(scope, id, patch);

    await this.#appendCustody(scope, id, 'retention-set', actor, input.reason, {
      retainUntil: retention.retainUntil,
      tier: input.tier ?? doc.media.tier,
    });
    if (input.legalHold !== undefined && input.legalHold !== doc.retention.legalHold) {
      await this.#appendCustody(
        scope,
        id,
        input.legalHold ? 'legal-hold-placed' : 'legal-hold-released',
        actor,
        input.reason,
      );
    }
    this.#metrics?.retentionSets.inc();
    return toEvidence(await this.#require(scope, id));
  }

  // --- Chain of custody -------------------------------------------------------------------------

  async listCustody(
    scope: TenantScope,
    id: string,
    opts: { limit: number; cursor?: string },
  ): Promise<EvidenceCustodyPage> {
    await this.#require(scope, id); // tenant-scoped existence (cross-tenant → 404)
    const { items, nextCursor } = await this.#custody.list(scope, id, opts);
    return {
      items: items.map(toCustodyEntry),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  /** Verify the full custody hash-chain for an item (tamper-evidence check). */
  async verifyCustody(scope: TenantScope, id: string): Promise<boolean> {
    await this.#require(scope, id);
    const all: CustodyDoc[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#custody.list(scope, id, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return verifyChain(all);
  }

  // --- Retention sweep (design hook; enforcement scheduling deferred — see README/TD) ------------

  /** Mark one past-retention item expired (not on legal hold). Returns the new status or null. */
  async expireIfDue(scope: TenantScope, id: string, actor = 'system'): Promise<Evidence | null> {
    const doc = await this.#require(scope, id);
    if (!isPurgeEligible(doc, this.#now())) return null;
    await this.#store.patch(scope, id, { status: 'expired', updatedAt: this.#now().toISOString() });
    await this.#appendCustody(scope, id, 'expired', actor);
    return toEvidence(await this.#require(scope, id));
  }

  // --- internals --------------------------------------------------------------------------------

  #tenantStore(scope: TenantScope): TenantObjectStore {
    return new TenantObjectStore(this.#objectStore, scope.tenantId);
  }

  async #require(scope: TenantScope, id: string): Promise<EvidenceDoc> {
    const doc = await this.#store.get(scope, id);
    if (!doc) throw notFound(`evidence "${id}" not found`);
    return doc;
  }

  async #appendCustody(
    scope: TenantScope,
    evidenceId: string,
    action: Parameters<typeof newCustodyEntry>[0]['action'],
    actor: string,
    reason?: string | undefined,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const prev = await this.#custody.head(scope, evidenceId);
    const entry = newCustodyEntry({
      id: this.#newId(),
      tenantId: scope.tenantId,
      evidenceId,
      seq: prev ? prev.seq + 1 : 0,
      action,
      actor,
      reason,
      at: this.#now(),
      ...(details ? { details } : {}),
      prevHash: prev ? prev.hash : null,
    });
    await this.#custody.append(scope, entry);
  }
}
