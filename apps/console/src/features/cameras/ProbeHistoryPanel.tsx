import { useState } from 'react';
import type { CameraProbeRecord } from '@vip/contracts';
import { formatTimestamp } from '@/lib/format';
import { Alert, Badge, Button, StatusIndicator } from '@/ui';
import {
  FAILURE_LABEL,
  PROBE_OUTCOME_KIND,
  PROBE_OUTCOME_LABEL,
  PROVIDER_LABEL,
  formatDuration,
} from './cameraPresentation';
import { ProbeResultPanel } from './ProbeResultPanel';
import { useProbeHistory, useProbeReplay } from './useCameras';

/**
 * The probe archive (P-2.2, Architect rec 2 + rec 6).
 *
 * **The single most useful question this answers is "was it always like this?"** A camera taking
 * four seconds to first frame is unremarkable if it always did and is an incident if it took 300 ms
 * last week — and before the archive existed, only one of those two readings was available, because
 * each probe overwrote the last.
 *
 * Selecting a row **replays** it: the stored staged report is reconstructed and rendered through the
 * same panel that shows a live probe, with no camera contacted. That matters because support work
 * happens days after the failure, often on a camera that has since been power-cycled into working
 * again — re-running the probe then answers "it works now", which closes the ticket without
 * explaining anything.
 *
 * This component renders; it does not decide. The outcome, the failure code, the provider and the
 * comparison all come from the server.
 */
export function ProbeHistoryPanel({ cameraId }: { cameraId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const history = useProbeHistory(cameraId);
  const replay = useProbeReplay(cameraId, selected);

  if (history.isPending) {
    return <p className="text-xs text-text-subtle">Loading probe history…</p>;
  }
  const data = history.data;
  if (!data || data.records.length === 0) {
    return (
      <section className="space-y-2">
        <Header total={0} retained={0} evicted={0} />
        <p className="text-xs text-text-subtle">
          This camera has never been probed. Nothing here is a claim about the device — there is
          simply no evidence yet.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <Header total={data.total} retained={data.retained} evicted={data.evicted} />

      {data.evicted > 0 ? (
        <Alert variant="info" title={`Showing ${data.retained} of ${data.total} probes`}>
          <p>
            Older reports have been aged out. Nothing shown here has been altered — retention drops
            whole reports rather than editing them.
          </p>
        </Alert>
      ) : null}

      <ul className="space-y-1">
        {data.records.map((record) => (
          <ProbeRow
            key={record.probeId}
            record={record}
            selected={record.probeId === selected}
            onSelect={() => setSelected(record.probeId === selected ? null : record.probeId)}
          />
        ))}
      </ul>

      {selected && replay.data ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Replayed from stored evidence
            </h4>
            <span className="text-xs text-text-subtle">
              measured {formatTimestamp(replay.data.recordedAt)} · the camera was not contacted
            </span>
          </div>

          {replay.data.comparison ? (
            <ProbeComparisonSummary comparison={replay.data.comparison} />
          ) : (
            <p className="text-xs text-text-subtle">
              This is the earliest retained probe, so there is nothing to compare it against.
            </p>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-text-subtle">Provider</dt>
            <dd>{PROVIDER_LABEL[replay.data.provider]}</dd>
            <dt className="text-text-subtle">Probed URL</dt>
            <dd className="truncate font-mono">{replay.data.configuration.streamUrl}</dd>
            {replay.data.configuration.firmware ? (
              <>
                <dt className="text-text-subtle">Firmware at the time</dt>
                <dd>{replay.data.configuration.firmware}</dd>
              </>
            ) : null}
          </dl>

          {replay.data.stages.length > 0 ? (
            <ProbeResultPanel
              probe={{
                probedAt: replay.data.recordedAt,
                evidenceClass: replay.data.evidenceClass,
                probeVersion: replay.data.probeVersion,
                ...(replay.data.runtimeVersion
                  ? { runtimeVersion: replay.data.runtimeVersion }
                  : {}),
                provider: replay.data.provider,
                checks: replay.data.stages,
                reachable: replay.data.outcome !== 'unavailable',
                framesRead: replay.data.outcome === 'succeeded' ? 1 : 0,
                ...(replay.data.totalMs !== undefined ? { totalMs: replay.data.totalMs } : {}),
                ...(replay.data.failureCode ? { failureCode: replay.data.failureCode } : {}),
                authentication: 'unknown',
                profiles: [],
                warnings: replay.data.warnings,
              }}
            />
          ) : (
            <p className="text-xs text-text-subtle">
              No probe ran — this record exists so the gap in the evidence has a timestamp on it.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Header({
  total,
  retained,
  evicted,
}: {
  total: number;
  retained: number;
  evicted: number;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
        Probe history
      </h3>
      <span className="text-xs text-text-subtle">
        {total} probe{total === 1 ? '' : 's'}
        {evicted > 0 ? ` · ${retained} retained` : ''}
      </span>
    </div>
  );
}

function ProbeRow({
  record,
  selected,
  onSelect,
}: {
  record: CameraProbeRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <Button
        variant="ghost"
        className={`flex w-full items-baseline gap-2 text-left text-sm ${
          selected ? 'bg-surface-raised' : ''
        }`}
        onClick={onSelect}
        aria-pressed={selected}
      >
        <StatusIndicator
          status={PROBE_OUTCOME_KIND[record.outcome]}
          label={PROBE_OUTCOME_LABEL[record.outcome]}
        />
        <span className="text-text-subtle">{formatTimestamp(record.at)}</span>
        {record.failureCode ? (
          <span className="text-xs">{FAILURE_LABEL[record.failureCode]}</span>
        ) : null}
        {record.evidenceClass !== 'hardware' ? (
          <Badge variant="outline">{record.evidenceClass}</Badge>
        ) : null}
        {record.result?.totalMs !== undefined ? (
          <span className="ml-auto font-mono text-xs text-text-subtle">
            {formatDuration(record.result.totalMs)}
          </span>
        ) : null}
      </Button>
    </li>
  );
}

/**
 * What changed since the previous probe.
 *
 * The comparison is the diagnosis: one failing probe says a camera is broken, and the pair says
 * *authentication used to pass and now does not* — which names the change and usually the person who
 * made it. `configurationChanged` leads, because it is the confound: a camera re-pointed at its main
 * stream did not get slower, it got asked for more.
 */
function ProbeComparisonSummary({
  comparison,
}: {
  comparison: NonNullable<NonNullable<ReturnType<typeof useProbeReplay>['data']>['comparison']>;
}) {
  return (
    <div className="space-y-1 text-xs">
      {comparison.configurationChanged ? (
        <p className="text-status-warn">
          The configuration also changed between these two probes — compare them with that in mind.
        </p>
      ) : null}
      {comparison.outcomeChanged ? (
        <p>
          Previously{' '}
          <strong>{PROBE_OUTCOME_LABEL[comparison.previousOutcome].toLowerCase()}</strong>
          {comparison.previousFailureCode
            ? ` (${FAILURE_LABEL[comparison.previousFailureCode]})`
            : ''}
          .
        </p>
      ) : (
        <p className="text-text-subtle">Same outcome as the probe before it.</p>
      )}
      {comparison.stageChanges.length > 0 ? (
        <ul className="space-y-0.5">
          {comparison.stageChanges.map((change) => (
            <li key={change.name}>
              <span className="font-mono">{change.name}</span>{' '}
              <span className="text-text-subtle">
                {change.from} → {change.to}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {comparison.totalMsDelta !== undefined && Math.abs(comparison.totalMsDelta) >= 1 ? (
        <p className="text-text-subtle">
          {comparison.totalMsDelta > 0 ? 'Slower' : 'Faster'} by{' '}
          {formatDuration(Math.abs(comparison.totalMsDelta))} than the previous probe.
        </p>
      ) : null}
    </div>
  );
}
