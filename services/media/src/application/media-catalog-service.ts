/**
 * Application: the media catalog use-cases (P2-2 G-2). Owns recording + clip metadata and resolves
 * **signed** playback URLs. Every operation is tenant-scoped via @vip/tenancy (fail-closed) and the
 * store; playback goes through a per-tenant @vip/storage `TenantObjectStore`, so a principal can only
 * ever address its own tenant's objects. Media access is signed-URL only — never public.
 *
 * It also implements the supervisor's `RecordingSink`: as segments are recorded they are indexed here
 * so the console can list and play them back. Indexing is idempotent on a derived recording id.
 */
import type {
  Clip,
  ClipPage,
  ClipPlayback,
  ClipQuery,
  CreateClipInput,
  PlaybackTarget,
  Recording,
  RecordingPage,
  RecordingQuery,
  RecordingSegment,
} from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { TenantObjectStore, type ObjectStore } from '@vip/storage';
import type { Clock } from '../domain/stream.js';
import { newRecording, toRecording, type RecordingDoc } from '../domain/recording.js';
import { newClip, toClip, type ClipDoc } from '../domain/clip.js';
import { notFound } from './errors.js';
import type { MediaCatalogStore, RecordingSink } from './ports.js';

export interface IdGen {
  clipId(): string;
}

export interface MediaCatalogServiceDeps {
  store: MediaCatalogStore;
  objectStore: ObjectStore;
  clock: Clock;
  ids: IdGen;
  /** Playback URL lifetime (seconds). */
  playbackTtlSeconds: number;
}

export class MediaCatalogService implements RecordingSink {
  readonly #store: MediaCatalogStore;
  readonly #objectStore: ObjectStore;
  readonly #clock: Clock;
  readonly #ids: IdGen;
  readonly #ttl: number;

  constructor(deps: MediaCatalogServiceDeps) {
    this.#store = deps.store;
    this.#objectStore = deps.objectStore;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#ttl = deps.playbackTtlSeconds;
  }

  // --- RecordingSink (called by the supervisor after a segment is stored) -----------------------

  /** Index a finalized segment (idempotent). Scope is derived from the segment's own tenantId. */
  async record(segment: RecordingSegment): Promise<void> {
    const scope = TenantScope.fromTenantId(segment.tenantId);
    await this.#store.putRecording(scope, newRecording(segment, this.#clock.now()));
  }

  // --- Recordings -------------------------------------------------------------------------------

  async listRecordings(scope: TenantScope, q: RecordingQuery): Promise<RecordingPage> {
    const { items, nextCursor } = await this.#store.listRecordings(scope, q);
    return {
      items: items.map(toRecording),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async getRecording(scope: TenantScope, id: string): Promise<Recording> {
    return toRecording(await this.#requireRecording(scope, id));
  }

  /** Resolve a short-lived signed playback URL for a stored recording. */
  async recordingPlayback(scope: TenantScope, id: string): Promise<PlaybackTarget> {
    const doc = await this.#requireRecording(scope, id);
    return this.#target(scope, doc.key, doc.contentType);
  }

  // --- Clips ------------------------------------------------------------------------------------

  /** Bookmark a clip over a camera's recorded time range, snapshotting the covered segment keys. */
  async createClip(scope: TenantScope, createdBy: string, input: CreateClipInput): Promise<Clip> {
    const covering = await this.#store.recordingsCovering(
      scope,
      input.cameraId,
      input.startedAt,
      input.endedAt,
    );
    const doc = newClip(
      scope.tenantId,
      this.#ids.clipId(),
      createdBy,
      input,
      covering.map((r) => r.key),
      this.#clock.now(),
    );
    await this.#store.putClip(scope, doc);
    return toClip(doc);
  }

  async listClips(scope: TenantScope, q: ClipQuery): Promise<ClipPage> {
    const { items, nextCursor } = await this.#store.listClips(scope, q);
    return {
      items: items.map(toClip),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async getClip(scope: TenantScope, id: string): Promise<Clip> {
    return toClip(await this.#requireClip(scope, id));
  }

  /**
   * Playback for a clip. When materialized (`key`), a single signed target for the standalone object;
   * otherwise the ordered signed targets for the recordings the clip range currently covers.
   */
  async clipPlayback(scope: TenantScope, id: string): Promise<ClipPlayback> {
    const doc = await this.#requireClip(scope, id);
    const clip = toClip(doc);
    if (doc.key) {
      return { clip, segments: [await this.#target(scope, doc.key)] };
    }
    const covering = await this.#store.recordingsCovering(
      scope,
      doc.cameraId,
      doc.startedAt,
      doc.endedAt,
    );
    const segments = await Promise.all(
      covering.map((r) => this.#target(scope, r.key, r.contentType)),
    );
    return { clip, segments };
  }

  async deleteClip(scope: TenantScope, id: string): Promise<void> {
    const removed = await this.#store.deleteClip(scope, id);
    if (!removed) throw notFound(`clip "${id}" not found`);
  }

  // --- internals --------------------------------------------------------------------------------

  async #requireRecording(scope: TenantScope, id: string): Promise<RecordingDoc> {
    const doc = await this.#store.getRecording(scope, id);
    if (!doc) throw notFound(`recording "${id}" not found`);
    return doc;
  }

  async #requireClip(scope: TenantScope, id: string): Promise<ClipDoc> {
    const doc = await this.#store.getClip(scope, id);
    if (!doc) throw notFound(`clip "${id}" not found`);
    return doc;
  }

  async #target(scope: TenantScope, key: string, contentType?: string): Promise<PlaybackTarget> {
    const store = new TenantObjectStore(this.#objectStore, scope.tenantId);
    const url = await store.presignGet(key, this.#ttl);
    return {
      key,
      url,
      expiresInSeconds: this.#ttl,
      ...(contentType !== undefined ? { contentType } : {}),
    };
  }
}
