/**
 * Access audit contracts (P-5.2.0, Architect rec 7) — **read-side only, and that is the whole
 * point**.
 *
 * The recommendation listed eleven audit events: View, Open, Download, Export, Assignment, Comment,
 * Attachment, Resolution, Escalation, Evidence Access, AI Recommendation Viewed. They split cleanly
 * in two, along a line worth stating plainly:
 *
 * > **A write leaves a record. A read leaves nothing.**
 *
 * Assignment, Comment, Attachment, Resolution and Escalation are all **already recorded** — each
 * one appends to `Incident.history`, `Incident.assignments` or `Incident.notes`, and
 * `IncidentActivity` derives the narrative from them. Writing them a second time into an audit
 * collection is the mistake CONSTRAINTS §46 exists to prevent: two records of one truth, written by
 * different code paths, that eventually disagree with no principled way to decide which lied. They
 * are therefore **refused here**, and `REFUSED_AUDIT_ACTIONS` says so out loud.
 *
 * Reads are the opposite case. Nothing in the incident changes when someone opens it, downloads its
 * evidence or exports a report — so if it is not recorded at the moment it happens, the fact is
 * gone. That is exactly the set this contract covers, and it is why it exists at all.
 *
 * ### ⚠️ Three properties this log must have, and one it must not
 *
 * **It records the act, never the content.** An audit entry says *evidence `ev_88` was downloaded*.
 * It never carries the frame, the note body, or the search results. An audit log that quotes what
 * was read is a second copy of the data, with none of the retention or access control of the first.
 *
 * **It is itself permissioned.** A log of who looked at what is a surveillance tool pointed at your
 * own staff. Reading it needs `audit:read`, which no operator role holds.
 *
 * **Meaningful reads only — and no sampling.** Recording every rendered table row would multiply
 * the write load of the busiest path in the product. The answer is *not* to sample: a sampled audit
 * is not an audit, because the one access anybody ever asks about is the one that was dropped. The
 * answer is to record **record-level acts** — opening a record, downloading bytes, exporting,
 * running a search — and not list impressions.
 *
 * **It does not duplicate the chain of custody.** Evidence *byte* access is already recorded by
 * `EvidenceCustodyAction.accessed` in a hash-chained, tamper-evident log that is the legal artefact.
 * This contract defers to it rather than keeping a weaker parallel copy.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
import { SearchEntityKind } from '../search/search.js';

/**
 * A recordable access. **Read-side only** (see the header).
 */
export const AccessAuditAction = z.enum([
  /** A record's detail view was opened — the granularity that makes "who looked at this" answerable. */
  'open',
  /** Bytes left the platform: an evidence file, a report, an export archive. */
  'download',
  /** An export or report job was requested. Recorded at request time, not at completion. */
  'export',
  /** A search was executed. The query is recorded; ⚠️ the results are not. */
  'search',
  /**
   * An AI recommendation was displayed to a person. Recorded because acting on a suggestion is a
   * decision someone may later have to account for, and "nobody saw it" must be distinguishable
   * from "it was seen and ignored".
   */
  'recommendation-viewed',
]);
export type AccessAuditAction = z.infer<typeof AccessAuditAction>;

/**
 * ⚠️ **Requested and deliberately refused.** Each is either already recorded elsewhere, or is a
 * volume problem masquerading as a feature.
 *
 * - `assignment` · `comment` · `attachment` · `resolution` · `escalation` — already append to the
 *   incident's own streams and are derived by `IncidentActivity`. A second copy is §46.
 * - `evidence-access` — owned by `EvidenceCustodyAction.accessed`, which is hash-chained and is the
 *   artefact a court sees. A parallel entry would be the weaker of two records of one fact.
 * - `view` — at list-row granularity this is one write per rendered row. `open` records the act
 *   that anyone actually asks about; `view` records scrolling.
 */
export const REFUSED_AUDIT_ACTIONS = [
  'assignment',
  'comment',
  'attachment',
  'resolution',
  'escalation',
  'evidence-access',
  'view',
] as const;

/**
 * One access record. **Append-only and immutable** — there is no update input and no delete route,
 * which is the guarantee rather than a policy.
 */
export const AccessAuditEntry = z.object({
  id: Uuid,
  tenantId: TenantId,
  action: AccessAuditAction,
  /** What was accessed. Absent only for `search`, which has no single target. */
  entity: SearchEntityKind.optional(),
  targetId: z.string().min(1).max(200).optional(),
  /** Who. A principal id — resolving it to a name is Identity's job, at read time. */
  principalId: z.string().min(1).max(200),
  /**
   * The search text, for `action: 'search'`. ⚠️ The *query*, never the results — recording what
   * came back would copy the records into the audit log.
   */
  query: z.string().max(500).optional(),
  /** Why, when the caller supplied a reason (evidence access under a legal hold, for instance). */
  reason: z.string().max(500).optional(),
  /** The request's correlation id, so an access threads into the same story as everything else. */
  correlationId: z.string().min(1).optional(),
  /**
   * Client attribution. ⚠️ IP and user agent are personal data in most jurisdictions — they are
   * optional, retained under the audit retention policy, and never used for anything but attribution.
   */
  ipAddress: z.string().max(45).optional(),
  userAgent: z.string().max(300).optional(),
  at: IsoDateTime,
});
export type AccessAuditEntry = z.infer<typeof AccessAuditEntry>;

/**
 * Tenant-scoped audit query.
 *
 * ⚠️ Every filter here needs a declared covering index before the route is exposed (entry criterion
 * G-4, CONSTRAINTS §40). This log is the highest-volume collection the product will have, so a
 * query without an index is not a slow page — it is the query that takes the cluster down.
 */
export const AccessAuditQuery = z.object({
  action: AccessAuditAction.optional(),
  entity: SearchEntityKind.optional(),
  targetId: z.string().min(1).optional(),
  principalId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type AccessAuditQuery = z.infer<typeof AccessAuditQuery>;

export const AccessAuditPage = z.object({
  items: z.array(AccessAuditEntry).default([]),
  nextCursor: z.string().min(1).optional(),
});
export type AccessAuditPage = z.infer<typeof AccessAuditPage>;
