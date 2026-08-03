/**
 * Domain: the **evidence chain** (P-5.3, Architect rec 7) — camera → detection → rule → incident →
 * evidence → playback → export → report, derived from the incident and one bounded evidence read.
 *
 * Pure. Handed what the application gathered, it decides which links resolved and — for the ones
 * that did not — *which of six different reasons* applies. That distinction is the feature: a
 * traceability diagram whose broken links all look the same invites the reader to conclude the
 * platform lost something, when in most cases the platform is behaving exactly as designed.
 *
 * ### ⚠️ Three of the eight stages have no producer, and the chain says so rather than omitting them
 *
 * `playback` needs a session resolver (P-5.3 froze the contract; nothing resolves one). `export`
 * needs packaging (TD-16). `report` needs a generator (Q-8). Rendering seven stages and stopping
 * would let a viewer assume the chain ends at evidence; rendering eight with three marked
 * `not-built` tells them the truth, and tells them a release rather than a support call is what
 * changes it.
 */
import type {
  EvidenceChain,
  EvidenceChainLink,
  Incident,
  IncidentTimelineSource,
} from '@vip/contracts';
import { chainIsComplete } from '@vip/contracts';
import type { RelatedEvidence } from './incident-timeline.js';

export interface ChainInputs {
  incident: Incident;
  /** The bounded evidence read, when it was made and succeeded. */
  evidence?: { items: RelatedEvidence[]; truncated: boolean } | undefined;
  /** Sources the caller asked for — an evidence link is `not-requested` rather than empty. */
  requested: readonly IncidentTimelineSource[];
  /** Upstream failures, so a `forbidden` or `unavailable` evidence link is reported as such. */
  failures?:
    | readonly {
        source: IncidentTimelineSource;
        reason: 'unavailable' | 'forbidden';
        detail: string;
      }[]
    | undefined;
  now: Date;
}

function broken(
  stage: EvidenceChainLink['stage'],
  brokenBecause: NonNullable<EvidenceChainLink['brokenBecause']>,
  detail: string,
): EvidenceChainLink {
  return { stage, resolved: false, brokenBecause, detail };
}

/**
 * Build the chain.
 *
 * ⚠️ Note what is **not** done here: nothing calls the Camera or Rules context to resolve a name.
 * The incident already carries `triggeredBy.cameraId` and `source.ruleName` as **provenance copied
 * at promotion time** — a snapshot of what was true when the rule fired, which is the correct
 * answer for a chain describing why this incident exists. Resolving the camera's *current* name
 * would answer a different question and would cost two more upstream calls on a panel that already
 * rides the timeline's budget (CONSTRAINTS §54).
 */
export function buildChain(inputs: ChainInputs): EvidenceChain {
  const { incident } = inputs;
  const links: EvidenceChainLink[] = [];

  // ── camera ────────────────────────────────────────────────────────────────────────────────
  if (incident.triggeredBy.cameraId !== undefined) {
    links.push({
      stage: 'camera',
      resolved: true,
      ref: incident.triggeredBy.cameraId,
      ...(incident.triggeredBy.zoneId !== undefined ? { label: incident.triggeredBy.zoneId } : {}),
    });
  } else {
    /*
     * A legitimate case, not a defect: a rule can fire on an event with no camera — a system event,
     * an integration, an aggregate over a window.
     */
    links.push(
      broken('camera', 'never-produced', 'the triggering event was not attributed to a camera'),
    );
  }

  // ── detection ─────────────────────────────────────────────────────────────────────────────
  links.push({
    stage: 'detection',
    resolved: true,
    ref: incident.triggeredBy.eventId,
    label: incident.triggeredBy.eventType,
    at: incident.triggeredBy.occurredAt,
    count: incident.matchedCount,
  });

  // ── rule ──────────────────────────────────────────────────────────────────────────────────
  links.push({
    stage: 'rule',
    resolved: true,
    ref: incident.source.ruleId,
    label: `${incident.source.ruleName} v${incident.source.ruleVersion}`,
  });

  // ── incident ──────────────────────────────────────────────────────────────────────────────
  links.push({
    stage: 'incident',
    resolved: true,
    ref: incident.id,
    label: incident.title,
    at: incident.raisedAt,
  });

  // ── evidence ──────────────────────────────────────────────────────────────────────────────
  const failure = inputs.failures?.find((entry) => entry.source === 'evidence');
  if (failure !== undefined) {
    links.push(broken('evidence', failure.reason, failure.detail));
  } else if (!inputs.requested.includes('evidence')) {
    /* Not asked for is not the same as none — the timeline's own distinction, kept here. */
    links.push(broken('evidence', 'unavailable', 'the evidence link was not requested'));
  } else if (inputs.evidence === undefined || inputs.evidence.items.length === 0) {
    /*
     * ⚠️ `never-produced` rather than a bare "none". The auto-capture extractor is a no-op pending
     * the media frame source (TD-15), so on most incidents today this is the platform's state, not
     * the investigation's.
     */
    links.push(
      broken(
        'evidence',
        'never-produced',
        'no evidence was captured for this incident (automatic capture is pending the media frame source)',
      ),
    );
  } else {
    const first = inputs.evidence.items[0];
    links.push({
      stage: 'evidence',
      resolved: true,
      ref: first?.id ?? incident.id,
      label: `${inputs.evidence.items.length} item${inputs.evidence.items.length === 1 ? '' : 's'}${inputs.evidence.truncated ? ' (truncated)' : ''}`,
      count: inputs.evidence.items.length,
      ...(first?.capturedAt !== undefined ? { at: first.capturedAt } : {}),
    });
  }

  // ── playback / export / report ────────────────────────────────────────────────────────────
  links.push(
    broken(
      'playback',
      'not-built',
      'playback contracts are frozen; no service resolves a playback session yet',
    ),
    broken('export', 'not-built', 'export packaging is not implemented (TD-16)'),
    broken('report', 'not-built', 'no report generator exists yet'),
  );

  return {
    tenantId: incident.tenantId,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    eventType: incident.triggeredBy.eventType,
    links,
    /* Derived, so the flag and the links can never disagree (CONSTRAINTS §46). */
    complete: chainIsComplete(links),
    derivedAt: inputs.now.toISOString(),
  };
}
