/**
 * Domain: the unified evidence timeline (P-2.2, Architect P-2.2 rec 8 + closing recommendation).
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
 * | Probe archive   | 200   | time, own store     | immutable evidence; ~2 KB each, unbounded in   |
 * |                 |       |                     | principle, and never trimmed to suit a UI      |
 * | Compatibility   | 60    | (dimension, value)  | not chronological at all — it is a register    |
 *
 * One physical log would mean either throwing away probe evidence to keep the timeline small, or
 * letting a camera that reconnects every thirty seconds bury a firmware change under ten thousand
 * identical rows. Merging on read costs one sort, gives the operator the single chronology they
 * actually want, and creates no second copy of any fact that could drift from the first.
 *
 * Every entry answers the same three questions in the same fields — **what changed** (`summary`,
 * `field`, `from`/`to`), **when** (`at`), **why** (`reasonCode`) — so an investigator never has to
 * know which subsystem recorded a fact in order to read it.
 *
 * Pure and deterministic.
 */
import type {
  CameraEvidenceTimeline,
  CameraIdentityChange,
  CameraProbeRecord,
  CameraTimelineEntry,
  CompatibilityRecord,
  CameraEvidenceEntry,
  CameraEvidenceSeverity,
  CameraEvidenceSource,
} from '@vip/contracts';

/** Matches the `CameraEvidenceTimeline` contract bound. */
export const EVIDENCE_LIMIT = 300;

/** Timeline event kinds that should not be scrolled past. */
const LOUD_KINDS = new Set(['probe-failed', 'firmware-changed', 'identity-changed']);

function severityForTimeline(entry: CameraTimelineEntry): CameraEvidenceSeverity {
  if (LOUD_KINDS.has(entry.kind)) return 'warning';
  if (entry.kind === 'state-changed' && (entry.to === 'offline' || entry.to === 'degraded')) {
    return 'warning';
  }
  if (entry.kind === 'state-changed' || entry.kind === 'capability-refreshed') return 'notice';
  return 'info';
}

function fromLifecycle(entry: CameraTimelineEntry): CameraEvidenceEntry {
  const source: CameraEvidenceSource =
    entry.kind === 'identity-changed'
      ? 'identity'
      : entry.kind === 'capability-refreshed' || entry.kind === 'firmware-changed'
        ? 'capability'
        : entry.kind === 'configuration-updated' || entry.kind === 'credentials-updated'
          ? 'configuration'
          : entry.kind === 'probe-succeeded' || entry.kind === 'probe-failed'
            ? 'probe'
            : 'lifecycle';
  return {
    at: entry.at,
    source,
    summary: entry.detail,
    reasonCode: entry.reasonCode,
    evidence: entry.evidence,
    severity: severityForTimeline(entry),
    ...(entry.from ? { from: entry.from } : {}),
    ...(entry.to ? { to: entry.to } : {}),
    ...(entry.probeId ? { probeId: entry.probeId } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
  };
}

function fromIdentity(change: CameraIdentityChange): CameraEvidenceEntry {
  return {
    at: change.at,
    source: 'identity',
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

function fromProbe(record: CameraProbeRecord): CameraEvidenceEntry {
  const failed = record.outcome !== 'succeeded';
  return {
    at: record.at,
    source: 'probe',
    summary: failed
      ? `probe ${record.outcome}${record.failureCode ? `: ${record.failureCode}` : ''} via ${record.provider}`
      : `probe succeeded via ${record.provider}${
          record.result?.resolution ? ` at ${record.result.resolution}` : ''
        }`,
    reasonCode: failed ? 'stream-unavailable' : 'hardware-evidence',
    evidence: 'measured',
    evidenceClass: record.evidenceClass,
    severity: failed ? 'warning' : 'info',
    probeId: record.probeId,
    ...(record.correlationId ? { correlationId: record.correlationId } : {}),
    ...(record.result?.totalMs !== undefined ? { durationMs: record.result.totalMs } : {}),
  };
}

function fromCompatibility(row: CompatibilityRecord): CameraEvidenceEntry {
  return {
    // Dated by when the condition was *first* met: that is the event — "this camera started running
    // V5.8.0" — and re-dating the row every time it is seen again would make it drift to the top of
    // the timeline forever, burying the moment that actually explains anything.
    at: row.firstSeenAt,
    source: 'compatibility',
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

export interface EvidenceTimelineInput {
  cameraId: string;
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

  // The probe archive is authoritative for probes, so a lifecycle entry that merely echoes an
  // archived report is dropped rather than merged. Two rows for one probe would make a camera look
  // twice as busy as it was, and the counts an operator reads off a timeline would be wrong.
  // Entries written before the archive existed carry no `probeId` and are kept — losing them would
  // be worse than a duplicate, and there is nothing to duplicate them with.
  const archived = new Set(input.probes.map((p) => p.probeId));

  const entries: CameraEvidenceEntry[] = [
    ...input.timeline
      .filter((e) => within(e.at) && !(e.probeId !== undefined && archived.has(e.probeId)))
      .map(fromLifecycle),
    ...input.identityHistory.filter((e) => within(e.at)).map(fromIdentity),
    ...input.probes.filter((p) => within(p.at)).map(fromProbe),
    ...input.compatibility.filter((c) => within(c.firstSeenAt)).map(fromCompatibility),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

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
