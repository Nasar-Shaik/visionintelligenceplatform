import type { ReactElement } from 'react';
import { AlertTriangle, Clock, Film, Link2, User } from 'lucide-react';
import type { CandidateEvidenceRef, CandidateExplanation, CandidateTimeline } from '@vip/contracts';
import { Alert, Badge } from '@/ui';

/**
 * **The loitering evidence panel** (P-8 Phase 7 §Incidents; Architect recs 1, 4 + 5).
 *
 * Rendered on an incident raised by a dwell rule. It shows the structured explanation, the ordered
 * timeline, and the references an operator follows to the pixels.
 *
 * ### ⚠️ The qualifying facts are shown first, not last
 *
 * `trackFragments > 1` and a long `longestGapSeconds` are the two things that make a duration a
 * weaker claim, and they are rendered as a **banner above the numbers** rather than in a detail row
 * underneath. An operator who scrolls past the reassuring half and never reaches the qualifying half
 * has been misled by the layout, whatever the payload said.
 *
 * ### ⚠️ Nothing here is computed
 *
 * Every value is a field the engine measured. The panel does not derive a duration from two
 * timestamps, or a confidence from a count — a second implementation of a number the server already
 * decided is exactly how a UI starts disagreeing with the record it is displaying.
 */

export interface LoiteringEvidenceProps {
  explanation?: CandidateExplanation | undefined;
  timeline?: CandidateTimeline | undefined;
  evidence?: readonly CandidateEvidenceRef[] | undefined;
  confidence?: number | null | undefined;
}

function secs(value: number | undefined): string {
  if (value === undefined) return '—';
  return `${Math.round(value * 10) / 10}s`;
}

const KIND_ICON: Record<string, ReactElement> = {
  'first-observed': <Clock className="size-3.5" />,
  observed: <Clock className="size-3.5" />,
  'identity-relinked': <User className="size-3.5" />,
  gap: <AlertTriangle className="size-3.5" />,
  'threshold-crossed': <AlertTriangle className="size-3.5" />,
  raised: <AlertTriangle className="size-3.5" />,
};

export function LoiteringEvidence({
  explanation,
  timeline,
  evidence,
  confidence,
}: LoiteringEvidenceProps): ReactElement | null {
  /* ⚠️ Absent, not empty. An incident from a stateless rule renders nothing here rather than an
   * empty "Loitering" section that implies the analysis ran and found nothing. */
  if (explanation === undefined) return null;

  const fragmented = (explanation.trackFragments ?? 1) > 1;
  const gappy = (explanation.longestGapSeconds ?? 0) >= 1;

  return (
    <section className="space-y-4" data-testid="loitering-evidence">
      <h3 className="text-sm font-semibold">Why this was raised</h3>

      {/*
       * ⚠️ Above the numbers. See the header — a qualification below the fold is a qualification
       * nobody reads.
       */}
      {fragmented || gappy ? (
        <Alert variant="warning" title="This duration was assembled, not watched continuously">
          {fragmented
            ? `Identity was carried across ${explanation.trackFragments} track fragments — the platform inferred that these were the same person from position and timing, with no appearance model. `
            : ''}
          {gappy
            ? `The longest stretch with no observation was ${secs(explanation.longestGapSeconds)}.`
            : ''}
        </Alert>
      ) : null}

      <p className="text-sm">{explanation.summary}</p>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Field label="Subject">
          <span className="font-mono text-xs">{explanation.identityId ?? '—'}</span>
          {explanation.subjectKind ? (
            <Badge variant="outline" className="ml-2">
              by {explanation.subjectKind}
            </Badge>
          ) : null}
        </Field>
        <Field label="Zone">
          {explanation.zoneName ?? explanation.zoneId ?? '—'}
          {/*
           * ⚠️ The zone VERSION, shown deliberately. It is what lets this incident be redrawn over
           * its own footage after somebody has since moved the polygon.
           */}
          {explanation.zoneVersion !== undefined ? (
            <span className="ml-1 text-xs text-fg-muted">v{explanation.zoneVersion}</span>
          ) : null}
        </Field>
        <Field label="Camera">{explanation.cameraId ?? '—'}</Field>
        <Field label="Observed">{secs(explanation.observedSeconds)}</Field>
        <Field label="Threshold">{secs(explanation.thresholdSeconds)}</Field>
        <Field label="Observations">{explanation.observations ?? '—'}</Field>
        <Field label="Entry">{explanation.firstObservedAt ?? '—'}</Field>
        <Field label="Last seen">{explanation.lastObservedAt ?? '—'}</Field>
        {/*
         * ⚠️ "still present" rather than a fabricated exit time. A candidate is raised DURING a
         * loiter, so at the moment of raising nobody has left. Copying the last observation into an
         * exit field would put a claim on an evidence record that nothing observed.
         */}
        <Field label="Exit">
          {explanation.exitAt ?? (
            <span className="text-fg-muted">not observed — still present when raised</span>
          )}
        </Field>
        <Field label="Confidence">
          {confidence === null || confidence === undefined ? (
            /* ADR-0039: unmeasured, not zero. */
            <span className="text-fg-muted">not measured</span>
          ) : (
            confidence.toFixed(2)
          )}
        </Field>
      </dl>

      {timeline !== undefined && timeline.entries.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            Timeline
            {timeline.omitted > 0 ? (
              <span className="ml-2 text-xs font-normal text-fg-muted">
                {timeline.entries.length} of {timeline.total} shown · {timeline.omitted} routine
                observations omitted
              </span>
            ) : null}
          </h4>
          <ol className="space-y-1.5 border-l border-border pl-4">
            {timeline.entries.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="relative text-sm">
                <span className="absolute -left-[1.4rem] top-0.5 text-fg-muted">
                  {KIND_ICON[entry.kind] ?? <Clock className="size-3.5" />}
                </span>
                <span className="tabular-nums text-xs text-fg-muted">
                  +{entry.elapsedSeconds.toFixed(1)}s
                </span>{' '}
                {entry.summary}
                {entry.evidence.map((ref) => (
                  <a
                    key={ref.locator}
                    href={ref.locator}
                    className="ml-2 inline-flex items-center gap-1 text-xs text-brand underline"
                  >
                    <Link2 className="size-3" />
                    {ref.kind}
                  </a>
                ))}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {evidence !== undefined && evidence.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">Evidence</h4>
          {/*
           * ⚠️ References, never copies. The platform points at the recording; it does not duplicate
           * footage into an incident record. Following one of these resolves the material on demand.
           */}
          <ul className="space-y-1">
            {evidence.map((ref) => (
              <li key={ref.locator} className="text-sm">
                <a
                  href={ref.locator}
                  className="inline-flex items-center gap-1.5 text-brand underline"
                >
                  <Film className="size-3.5" />
                  {ref.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): ReactElement {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
