/**
 * Domain: pure clip-metadata record construction + projection (P2-2 G-2). A clip is a named,
 * playable time range of a camera's footage, optionally linked to an incident as evidence. It starts
 * `pending` — materializing a standalone cut file is deferred to a later media enhancement; until
 * then playback resolves to the covered recording segments. Framework- and I/O-free.
 */
import type { Clip, ClipStatus, CreateClipInput } from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/** MongoDB-persisted clip document. `_id` is the clip id; `tenantId` scopes it (Law 5). */
export interface ClipDoc extends TenantScoped {
  _id: string;
  cameraId: string;
  label?: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  status: ClipStatus;
  note?: string;
  incidentId?: string;
  segmentKeys: string[];
  /** The materialized clip object key once exported, else null (pending). */
  key: string | null;
  sizeBytes?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Whole-second duration of a clip's time range. */
export function clipDurationSeconds(startedAt: string, endedAt: string): number {
  return Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
}

/**
 * Build a persisted clip document. `segmentKeys` are the recording object keys covering the range at
 * creation time (used for pre-materialization playback). Clips start `pending`.
 */
export function newClip(
  tenantId: string,
  id: string,
  createdBy: string,
  input: CreateClipInput,
  segmentKeys: string[],
  at: Date,
): ClipDoc {
  const ts = at.toISOString();
  return {
    _id: id,
    tenantId,
    cameraId: input.cameraId,
    ...(input.label !== undefined ? { label: input.label } : {}),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSeconds: clipDurationSeconds(input.startedAt, input.endedAt),
    status: 'pending',
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.incidentId !== undefined ? { incidentId: input.incidentId } : {}),
    segmentKeys,
    key: null,
    createdBy,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Project a persisted clip to its public contract shape. */
export function toClip(doc: ClipDoc): Clip {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    cameraId: doc.cameraId,
    ...(doc.label !== undefined ? { label: doc.label } : {}),
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    durationSeconds: doc.durationSeconds,
    status: doc.status,
    ...(doc.note !== undefined ? { note: doc.note } : {}),
    ...(doc.incidentId !== undefined ? { incidentId: doc.incidentId } : {}),
    segmentKeys: doc.segmentKeys,
    key: doc.key,
    ...(doc.sizeBytes !== undefined ? { sizeBytes: doc.sizeBytes } : {}),
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
