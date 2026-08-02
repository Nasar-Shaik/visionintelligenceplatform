/**
 * Domain: the unified evidence timeline (P-2.2 rec 8; provenance and navigation added in P-2.3).
 *
 * The Architect's recommendation was to stop keeping four separate timelines — identity history,
 * capability history, probe history, compatibility history — and introduce one `OperationalTimeline`.
 *
 * **The decision taken here: unify the reading, keep the writing separate.** The four records are not
 * interchangeable, and merging them physically would force one retention rule onto all four:
 *
 * | Record          | Bound | Keyed by            | Why it cannot share the others' rule           |
 * | --------------- | ----- | ------------------- | ---------------------------------------------- |
 * | Lifecycle       | 50    | time                | a camera flapping every 30s must not grow      |
 * |                 |       |                     | its document without limit                     |
 * | Identity        | 30    | attribute           | thirty changes already tell the whole story    |
 * | Probe archive   | 200   | sequence, own store | immutable evidence; ~2 KB each, unbounded in   |
 * |                 |       |                     | principle, and never trimmed to suit a UI      |
 * | Compatibility   | 60    | (dimension, value)  | not chronological at all — it is a register    |
 *
 * One physical log would mean either throwing away probe evidence to keep the timeline small, or
 * letting a camera that reconnects every thirty seconds bury a firmware change under ten thousand
 * identical rows. Merging on read costs one sort, gives the operator the single chronology they
 * actually want, and creates no second copy of any fact that could drift from the first.
 *
 * **This is the platform's only investigation API** (P-2.3 rec 6). Two properties make that
 * sustainable: every entry carries an identical provenance envelope whatever produced it, and every
 * entry carries its own navigation links. A fifth evidence type therefore appears in the timeline —
 * and in any consumer reading the envelope — **without a renderer change**.
 *
 * Pure and deterministic.
 */
import type {
  CameraEvidenceEntry,
  CameraEvidenceSeverity,
  CameraEvidenceSource,
  CameraEvidenceTimeline,
  CameraIdentityChange,
  CameraProbeRecord,
  CameraTimelineEntry,
  CompatibilityRecord,
  EvidenceProducer,
  EvidenceType,
} from '@vip/contracts';

/** Matches the `CameraEvidenceTimeline` contract bound. */
export const EVIDENCE_LIMIT = 300;

/** Timeline event kinds that should not be scrolled past. */
const LOUD_KINDS = new Set(['probe-failed', 'firmware-changed', 'identity-changed']);

/**
 * An entry before its links are resolved.
 *
 * Links are a property of the *set* — "the previous probe report", "what this went on to cause" — so
 * they can only be computed once every entry is present. Building them one source at a time would
 * mean each source guessing at what the others contributed.
 */
type Unlinked = Omit<CameraEvidenceEntry, 'links'> & {
  probeId?: string;
  changeSetId?: string;
  capabilitySnapshotAt?: string;
};

function severityForTimeline(entry: CameraTimelineEntry): CameraEvidenceSeverity {
  if (LOUD_KINDS.has(entry.kind)) return 'warning';
  if (entry.kind === 'state-changed' && (entry.to === 'offline' || entry.to === 'degraded')) {
    return 'warning';
  }
  if (entry.kind === 'state-changed' || entry.kind === 'capability-refreshed') return 'notice';
  return 'info';
}

/** Which record a timeline entry belongs to, and what kind of thing it is. */
function classifyTimeline(entry: CameraTimelineEntry): {
  source: CameraEvidenceSource;
  type: EvidenceType;
} {
  switch (entry.kind) {
    case 'identity-changed':
      return { source: 'identity', type: 'identity-change' };
    case 'capability-refreshed':
      return { source: 'capability', type: 'capability-refresh' };
    case 'firmware-changed':
      return { source: 'capability', type: 'firmware-change' };
    case 'configuration-updated':
      return { source: 'configuration', type: 'configuration-change' };
    case 'credentials-updated':
      return { source: 'configuration', type: 'credential-rotation' };
    case 'probe-succeeded':
    case 'probe-failed':
      return { source: 'probe', type: 'probe-report' };
    default:
      return { source: 'lifecycle', type: 'state-change' };
  }
}

function fromLifecycle(entry: CameraTimelineEntry, index: number, tenantId: string): Unlinked {
  const { source, type } = classifyTimeline(entry);
  return {
    // Derived from the entry's position in a stored, append-only array — stable across reads, which
    // a generated id would not be, and every link pointing at it would dangle on the next refresh.
    evidenceId: `tl:${index}:${entry.kind}`,
    evidenceType: type,
    at: entry.at,
    source,
    tenantId,
    producer: 'camera-service',
    ...(entry.probeVersion ? { producerVersion: entry.probeVersion } : {}),
    summary: entry.detail,
    reasonCode: entry.reasonCode,
    evidence: entry.evidence,
    severity: severityForTimeline(entry),
    ...(entry.from ? { from: entry.from } : {}),
    ...(entry.to ? { to: entry.to } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.probeId ? { probeId: entry.probeId } : {}),
    ...(entry.changeSetId ? { changeSetId: entry.changeSetId } : {}),
  };
}

function fromIdentity(change: CameraIdentityChange, index: number, tenantId: string): Unlinked {
  return {
    evidenceId: `id:${index}:${change.attribute}`,
    evidenceType: 'identity-change',
    at: change.at,
    source: 'identity',
    tenantId,
    producer: change.source === 'operator' ? 'operator' : 'discovery',
    summary:
      `${change.attribute} ${change.from ? `${change.from} → ` : 'first seen as '}${change.to}`.slice(
        0,
        300,
      ),
    // A first observation is not a change to be alarmed by; a *replaced* identifier is.
    reasonCode: change.attribute === 'address' ? 'address-changed' : 'derived',
    evidence: change.source === 'operator' ? 'declared' : 'measured',
    severity: change.from ? 'warning' : 'info',
    field: change.attribute,
    ...(change.from ? { from: change.from } : {}),
    to: change.to,
  };
}

function fromProbe(record: CameraProbeRecord, tenantId: string): Unlinked {
  const failed = record.outcome !== 'succeeded';
  return {
    evidenceId: `probe:${record.probeId}`,
    evidenceType: 'probe-report',
    at: record.at,
    source: 'probe',
    tenantId,
    // The runtime measured it; the camera service only stored it. Attributing it here would make a
    // measurement look like a camera-service claim, and provenance is the whole point of the field.
    producer: 'ai-runtime',
    producerVersion: record.probeVersion,
    ...(record.runtimeVersion ? { runtimeVersion: record.runtimeVersion } : {}),
    summary: failed
      ? `probe ${record.outcome}${record.failureCode ? `: ${record.failureCode}` : ''} via ${record.provider}`
      : `probe succeeded via ${record.provider}${
          record.result?.resolution ? ` at ${record.result.resolution}` : ''
        }`,
    reasonCode: failed ? 'stream-unavailable' : 'hardware-evidence',
    evidence: 'measured',
    evidenceClass: record.evidenceClass,
    severity: failed ? 'warning' : 'info',
    ...(record.correlationId ? { correlationId: record.correlationId } : {}),
    ...(record.result?.totalMs !== undefined ? { durationMs: record.result.totalMs } : {}),
    probeId: record.probeId,
    ...(record.capabilitySnapshotAt ? { capabilitySnapshotAt: record.capabilitySnapshotAt } : {}),
  };
}

function fromCompatibility(row: CompatibilityRecord, tenantId: string): Unlinked {
  return {
    evidenceId: `cmp:${row.dimension}:${row.value}`,
    evidenceType: 'compatibility-observation',
    // Dated by when the condition was *first* met: that is the event — "this camera started running
    // V5.8.0" — and re-dating the row every time it is seen again would make it drift to the top of
    // the timeline forever, burying the moment that actually explains anything.
    at: row.firstSeenAt,
    source: 'compatibility',
    tenantId,
    producer: 'camera-service',
    summary: `${row.dimension} ${row.value}: ${row.status}`,
    reasonCode: row.dimension === 'firmware' ? 'firmware-updated' : 'derived',
    evidence: 'measured',
    evidenceClass: row.evidenceClass,
    severity: row.status === 'unsupported' ? 'warning' : 'info',
    field: row.dimension,
    to: row.value,
    ...(row.lastProbeId ? { probeId: row.lastProbeId } : {}),
  };
}

/**
 * The key that says two entries are part of the same happening.
 *
 * Ordered by how strongly each ties things together: an explicit change set beats a probe id, which
 * beats a correlation id. An entry with none of the three is its own cause.
 */
function causalKey(entry: Unlinked): string | null {
  return entry.changeSetId ?? entry.probeId ?? entry.correlationId ?? null;
}

/**
 * Resolve every entry's navigation links (P-2.3, Architect rec 2/3).
 *
 * Three relationships, each answering a question an investigator actually asks:
 *
 * - **previous/next of the same type** — "the probe before this one", not "the row above". The row
 *   above is a scroll position; the previous probe is a question.
 * - **root cause, and what it caused** — causation has to work in both directions. Backwards answers
 *   *why did this happen?*; forwards answers *what did it break?*, which is what decides whether an
 *   incident is over and is unanswerable from a backward chain alone. A camera that went offline,
 *   failed three probes and lost a stream profile produces five rows that read as five problems;
 *   they share one root, and the pointer to it is the difference between reading a timeline and
 *   understanding it.
 * - **associated camera / probe / capability snapshot** — the underlying evidence, addressable.
 */
function resolveLinks(entries: readonly Unlinked[], cameraId: string): CameraEvidenceEntry[] {
  // Oldest first for the walk, so "previous" means earlier in time regardless of display order.
  const chronological = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const previousOfType = new Map<EvidenceType, string>();
  const previousId = new Map<string, string>();
  const nextId = new Map<string, string>();
  for (const entry of chronological) {
    const earlier = previousOfType.get(entry.evidenceType);
    if (earlier) {
      previousId.set(entry.evidenceId, earlier);
      nextId.set(earlier, entry.evidenceId);
    }
    previousOfType.set(entry.evidenceType, entry.evidenceId);
  }

  const rootOfGroup = new Map<string, string>();
  const causedBy = new Map<string, string[]>();
  for (const entry of chronological) {
    const key = causalKey(entry);
    if (!key) continue;
    const root = rootOfGroup.get(key);
    if (root === undefined) {
      rootOfGroup.set(key, entry.evidenceId);
      continue;
    }
    causedBy.set(root, [...(causedBy.get(root) ?? []), entry.evidenceId]);
  }

  return entries.map((entry) => {
    const { probeId, changeSetId, capabilitySnapshotAt, ...rest } = entry;
    const key = causalKey(entry);
    const root = key ? rootOfGroup.get(key) : undefined;
    return {
      ...rest,
      links: {
        cameraId,
        ...(previousId.has(entry.evidenceId)
          ? { previousEvidenceId: previousId.get(entry.evidenceId) as string }
          : {}),
        ...(nextId.has(entry.evidenceId)
          ? { nextEvidenceId: nextId.get(entry.evidenceId) as string }
          : {}),
        // Never point an entry at itself: "the root cause of this is this" is noise a consumer would
        // have to filter out, and a self-link reads as a chain that goes nowhere.
        ...(root && root !== entry.evidenceId ? { rootCauseEvidenceId: root } : {}),
        causedEvidenceIds: (causedBy.get(entry.evidenceId) ?? []).slice(0, 20),
        ...(probeId ? { probeId } : {}),
        ...(capabilitySnapshotAt ? { capabilitySnapshotAt } : {}),
        ...(changeSetId ? { changeSetId } : {}),
      },
    };
  });
}

export interface EvidenceTimelineInput {
  cameraId: string;
  tenantId: string;
  from: Date;
  to: Date;
  timeline: readonly CameraTimelineEntry[];
  identityHistory: readonly CameraIdentityChange[];
  probes: readonly CameraProbeRecord[];
  compatibility: readonly CompatibilityRecord[];
}

/**
 * Merge every record into one chronology, most recent first.
 *
 * Truncation drops the **oldest** entries and says so. Dropping by some notion of importance would
 * mean the timeline quietly agreed with whoever last defined important, and the entry an
 * investigator needs is regularly the boring one immediately before the interesting one.
 */
export function evidenceTimeline(input: EvidenceTimelineInput): CameraEvidenceTimeline {
  const startMs = input.from.getTime();
  const endMs = input.to.getTime();
  const within = (at: string) => {
    const t = Date.parse(at);
    return t >= startMs && t <= endMs;
  };

  // The probe archive is authoritative for probes, so a lifecycle entry that merely **echoes** an
  // archived report is dropped rather than merged. Two rows for one probe would make a camera look
  // twice as busy as it was, and the counts an operator reads off a timeline would be wrong.
  //
  // Only the echo — a `probe-succeeded`/`probe-failed` entry. A **state change** that references the
  // same probe is a different fact: the probe is what was measured, the transition is what the
  // platform did about it, and dropping the second would delete the causal link the timeline exists
  // to show. Entries written before the archive carry no `probeId` and are always kept.
  const archived = new Set(input.probes.map((p) => p.probeId));
  const isEcho = (entry: CameraTimelineEntry) =>
    (entry.kind === 'probe-succeeded' || entry.kind === 'probe-failed') &&
    entry.probeId !== undefined &&
    archived.has(entry.probeId);
  const { tenantId } = input;

  const unlinked: Unlinked[] = [
    ...input.timeline
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => within(entry.at) && !isEcho(entry))
      .map(({ entry, index }) => fromLifecycle(entry, index, tenantId)),
    ...input.identityHistory
      .map((change, index) => ({ change, index }))
      .filter(({ change }) => within(change.at))
      .map(({ change, index }) => fromIdentity(change, index, tenantId)),
    ...input.probes.filter((p) => within(p.at)).map((p) => fromProbe(p, tenantId)),
    ...input.compatibility
      .filter((c) => within(c.firstSeenAt))
      .map((c) => fromCompatibility(c, tenantId)),
  ];

  const entries = resolveLinks(unlinked, input.cameraId).sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at),
  );
  const sources = [...new Set(entries.map((e) => e.source))].sort() as CameraEvidenceSource[];

  return {
    cameraId: input.cameraId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    entries: entries.slice(0, EVIDENCE_LIMIT),
    sources,
    truncated: entries.length > EVIDENCE_LIMIT,
  };
}

/** Producers present in a set of entries — what a filter offers without hardcoding a list. */
export function producersIn(entries: readonly CameraEvidenceEntry[]): EvidenceProducer[] {
  return [...new Set(entries.map((e) => e.producer))].sort() as EvidenceProducer[];
}
