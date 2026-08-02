import { useState } from 'react';
import type { CameraEvidenceEntry } from '@vip/contracts';
import { formatTimestamp } from '@/lib/format';
import { Badge, Button, StatusIndicator } from '@/ui';
import {
  EVIDENCE_SEVERITY_KIND,
  decisionKindLabel,
  evidenceSourceLabel,
  formatDuration,
  producerLabel,
} from './cameraPresentation';
import { useCameraDecisions, useCameraEvidence } from './useCameras';

/**
 * The unified evidence timeline — the platform's **only investigation surface** (P-2.3 rec 6).
 *
 * Four records with four different retention rules are merged server-side into one chronology, and
 * this panel renders it **without knowing what any entry is**. Every row is drawn from the common
 * provenance envelope — `at` · `evidenceType` · `producer` · `evidenceClass` · `severity` ·
 * `summary` · `reasonCode` — so when a fifth producer starts emitting evidence (diagnostics,
 * recovery, certification), it appears here on the day it ships rather than after a console release.
 *
 * That is why the source and producer labels are looked up through a fallback rather than switched
 * on: an unrecognised source renders its own name in words, which is a worse label and an infinitely
 * better outcome than a blank cell or a crash.
 *
 * **Investigation, not measurement.** Nothing on this panel contacts a camera.
 */
export function EvidenceTimelinePanel({ cameraId }: { cameraId: string }) {
  const [showDecisions, setShowDecisions] = useState(false);
  const evidence = useCameraEvidence(cameraId);
  const decisions = useCameraDecisions(cameraId, showDecisions);

  if (evidence.isPending) {
    return <p className="text-xs text-text-subtle">Loading evidence…</p>;
  }
  const data = evidence.data;
  if (!data || data.entries.length === 0) {
    return (
      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Evidence timeline
        </h3>
        <p className="text-xs text-text-subtle">Nothing has been recorded for this camera yet.</p>
      </section>
    );
  }

  const byId = new Map(data.entries.map((entry) => [entry.evidenceId, entry]));

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Evidence timeline
        </h3>
        <div className="flex items-center gap-2">
          {data.sources.map((source) => (
            <Badge key={source} variant="outline">
              {evidenceSourceLabel(source)}
            </Badge>
          ))}
        </div>
      </div>

      {data.truncated ? (
        <p className="text-xs text-status-warn">
          Older entries were dropped to fit — this chronology is partial.
        </p>
      ) : null}

      <ol className="space-y-2">
        {data.entries.map((entry) => (
          <EvidenceRow key={entry.evidenceId} entry={entry} resolve={(id) => byId.get(id)} />
        ))}
      </ol>

      <div className="space-y-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={() => setShowDecisions((open) => !open)}>
          {showDecisions ? 'Hide' : 'Why did the platform do this?'}
        </Button>
        {showDecisions ? (
          decisions.isPending ? (
            <p className="text-xs text-text-subtle">Reconstructing decisions…</p>
          ) : (
            <ul className="space-y-2">
              {(decisions.data?.decisions ?? []).map((decision, index) => (
                <li
                  key={`${decision.kind}-${decision.at}-${index}`}
                  className="space-y-0.5 text-xs"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{decisionKindLabel(decision.kind)}</span>
                    <span className="font-mono">{decision.decision}</span>
                    <Badge variant="outline">{decision.actor}</Badge>
                    <span className="ml-auto text-text-subtle">{formatTimestamp(decision.at)}</span>
                  </div>
                  <p className="text-text-subtle">{decision.reason}</p>
                  {/* A decision with no supporting evidence is an opinion. Showing the ids is what
                      lets an operator check the platform's reasoning rather than take it on trust. */}
                  {decision.supportingEvidence.length > 0 ? (
                    <p className="font-mono text-[11px] text-text-subtle">
                      {decision.supportingEvidence.join(' · ')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </section>
  );
}

function EvidenceRow({
  entry,
  resolve,
}: {
  entry: CameraEvidenceEntry;
  resolve: (id: string) => CameraEvidenceEntry | undefined;
}) {
  const root = entry.links.rootCauseEvidenceId
    ? resolve(entry.links.rootCauseEvidenceId)
    : undefined;
  const caused = entry.links.causedEvidenceIds.length;

  return (
    <li className="space-y-0.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <StatusIndicator
          status={EVIDENCE_SEVERITY_KIND[entry.severity]}
          label={evidenceSourceLabel(entry.source)}
        />
        <span>{entry.summary}</span>
        {entry.evidenceClass && entry.evidenceClass !== 'hardware' ? (
          <Badge variant="outline">{entry.evidenceClass}</Badge>
        ) : null}
        <span className="ml-auto font-mono text-xs text-text-subtle">
          {formatTimestamp(entry.at)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 text-xs text-text-subtle">
        <span>{producerLabel(entry.producer)}</span>
        {entry.producerVersion ? <span>v{entry.producerVersion}</span> : null}
        <span className="font-mono">{entry.reasonCode}</span>
        {entry.durationMs !== undefined ? <span>{formatDuration(entry.durationMs)}</span> : null}
        {/* Causation, both ways (rec 2): backwards answers "why did this happen", forwards answers
            "what did it break" — the question that decides whether an incident is over. */}
        {root ? <span>caused by: {root.summary}</span> : null}
        {caused > 0 ? (
          <span>
            led to {caused} further {caused === 1 ? 'event' : 'events'}
          </span>
        ) : null}
      </div>
    </li>
  );
}
