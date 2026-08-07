/**
 * Everything the platform recorded about a run, on the screen (P-8.6, priority 5).
 *
 * ⭐ **Nothing here is new.** The P-8.5 capability audit found the session storing **six** provenance
 * fields and showing one, the asset storing **ten** and showing three, and `progress` carrying
 * `throughputFps` and `etaUnavailableReason` that reached no screen at all. This panel is the
 * missing surface, not new measurement.
 *
 * ⛔ **A number that was never measured shows an em dash, never a zero** (ADR-0039) — see `orDash`.
 */
import type { VideoAnalysisDetail } from '@vip/contracts';
import { formatBytes, formatDuration, orDash } from './format';
import { formatTimestamp } from '@/lib/format';

type Session = VideoAnalysisDetail['sessions'][number];
type Analysis = VideoAnalysisDetail['analysis'];

export interface AnalysisDetailsPanelProps {
  analysis: Analysis;
  session: Session | undefined;
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular">{value}</dd>
      {hint === undefined ? null : <p className="text-2xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AnalysisDetailsPanel({ analysis, session }: AnalysisDetailsPanelProps) {
  const asset = analysis.asset;
  const p = session?.provenance;
  const progress = session?.progress;

  return (
    <section className="space-y-2" data-testid="analysis-details">
      <h2 className="text-sm font-semibold">Analysis details</h2>
      <div className="grid gap-x-6 gap-y-0 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
        <dl className="contents">
          <Row
            label="Resolution"
            value={
              asset === undefined ? '—' : `${String(asset.width)} × ${String(asset.height)}`
            }
            {...(asset !== undefined && asset.height > asset.width
              ? { hint: 'portrait source' }
              : {})}
          />
          <Row
            label="Codec"
            value={asset === undefined ? '—' : `${asset.codec}${codecTagOf(asset)}`}
            {...(asset?.codecTag?.toLowerCase().startsWith('hev1') === true
              ? { hint: '⚠️ hev1 — Safari and iOS cannot play this back (TD-29)' }
              : {})}
          />
          <Row label="Container" value={asset?.container ?? '—'} />
          <Row
            label="Duration"
            value={asset === undefined ? '—' : formatDuration(asset.durationSeconds)}
          />
          <Row label="File size" value={asset === undefined ? '—' : formatBytes(asset.bytes)} />
          <Row
            label="Source frame rate"
            value={asset?.sourceFrameRate === undefined ? '—' : `${String(asset.sourceFrameRate)} fps`}
          />

          {/*
            ⭐ **Footage start and WHERE IT CAME FROM, together.** Every incident time in the run is
            an offset from this instant, so a start that nobody confirmed makes every timestamp
            below it a claim rather than a measurement. The two belong on one line.
          */}
          <Row
            label="Footage started"
            value={formatTimestamp(analysis.footageStartedAt)}
            hint={FOOTAGE_SOURCE[analysis.footageStartSource] ?? analysis.footageStartSource}
          />

          <Row label="Model" value={p?.modelId ?? '—'} />
          <Row label="Runtime version" value={p?.runtimeVersion ?? '—'} />
          <Row label="Pipeline version" value={p?.pipelineVersion ?? '—'} />
          <Row label="Capability" value={p?.capabilityId ?? '—'} />
          <Row
            label="Execution provider"
            value={p?.executionProvider ?? '—'}
            {...(p?.executionProvider === 'CPUExecutionProvider'
              ? { hint: 'CPU — no GPU acceleration on this host' }
              : {})}
          />

          <Row
            label="Analysis frame rate"
            value={
              session?.analysisFrameRate === undefined
                ? '—'
                : `${String(session.analysisFrameRate)} fps`
            }
            {...(asset?.sourceFrameRate !== undefined && session?.analysisFrameRate !== undefined
              ? {
                  hint: `${String(session.analysisFrameRate)} of every ${String(asset.sourceFrameRate)} source frames were examined`,
                }
              : {})}
          />
          <Row label="Throughput" value={orDash(progress?.throughputFps ?? null, ' fps', 2)} />
          <Row
            label="Speed factor"
            value={orDash(progress?.speedFactor ?? null, '× real time')}
          />
          {/*
            ⛔ **An ETA nobody can estimate is not "0 seconds"** (ADR-0039). The contract carries the
            reason it is unavailable, and this is the first screen to show it.
          */}
          <Row
            label="Time remaining"
            value={
              progress?.etaSeconds === null || progress?.etaSeconds === undefined
                ? '—'
                : formatDuration(progress.etaSeconds)
            }
            {...(progress?.etaUnavailableReason === undefined
              ? {}
              : { hint: progress.etaUnavailableReason })}
          />
        </dl>
      </div>
    </section>
  );
}

function codecTagOf(asset: NonNullable<Analysis['asset']>): string {
  return asset.codecTag === undefined ? '' : ` (${asset.codecTag})`;
}

/** ⚠️ Says how much the footage start can be trusted, in the operator's words rather than an enum. */
const FOOTAGE_SOURCE: Record<string, string> = {
  operator: '✅ confirmed by an operator',
  'container-metadata': "⚠️ read from the file's own metadata, unconfirmed",
  'upload-time': '⛔ the file carried none — offsets are from the upload, not real clock times',
};
