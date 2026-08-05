import type { Camera, StreamStatus } from '@vip/contracts';
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui';
import {
  capabilitySummaryCounts,
  capabilityTruth,
  type CapabilityEvidence,
  type CapabilityRow,
} from './cameraCapabilityTruth';

/**
 * **What this camera can do, and how the platform knows it.**
 *
 * ⚠️ The evidence column is the panel. A tick on its own is a vendor's claim repeated back to a
 * customer; a tick beside "declared, never exercised" is something an operator can plan around. The
 * two are rendered differently on purpose, and `not-built` says the platform cannot do it **for any
 * camera** rather than blaming the device.
 */
const EVIDENCE_LABEL: Record<CapabilityEvidence, string> = {
  measured: 'measured',
  validated: 'validated',
  declared: 'declared',
  'not-built': 'not built',
  unknown: 'unknown',
};

const EVIDENCE_VARIANT: Record<CapabilityEvidence, 'success' | 'brand' | 'warning' | 'neutral'> = {
  measured: 'success',
  validated: 'brand',
  /* ⚠️ Amber, not green: "declared" means nobody has tested it, and it should not read as proof. */
  declared: 'warning',
  'not-built': 'neutral',
  unknown: 'neutral',
};

function support(row: CapabilityRow): { text: string; className: string } {
  if (row.evidence === 'not-built') return { text: 'Not built', className: 'text-text-subtle' };
  if (row.supported === null) return { text: 'Unknown', className: 'text-text-subtle' };
  return row.supported
    ? { text: 'Yes', className: 'text-success' }
    : { text: 'No', className: 'text-text-subtle' };
}

export function CapabilityTruthPanel({
  camera,
  stream,
}: {
  camera: Camera;
  /* ⚠️ Three states, not two: a status, "no worker" (null), and "we did not ask" (undefined). */
  stream: StreamStatus | null | undefined;
}) {
  /* ⚠️ Passed straight through: `null` (no worker) and `undefined` (no answer) are different facts. */
  const rows = capabilityTruth(camera, stream);
  const counts = capabilitySummaryCounts(rows);

  return (
    <section aria-labelledby="capability-truth">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id="capability-truth"
          className="text-xs font-medium uppercase tracking-wide text-text-subtle"
        >
          What this camera can do
        </h3>
        <p className="text-xs text-text-subtle">
          {counts.measured} measured · {counts.declared} declared and never tested ·{' '}
          {counts.unavailable} not built · {counts.unknown} unknown
        </p>
      </div>
      {/*
        ⚠️ Never say "supported" without saying where that came from. A capability list assembled
        from a model number looks exactly like one assembled from measurements, right up to the night
        somebody needs it.
      */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Capability</TableHead>
              <TableHead className="w-24">Supported</TableHead>
              <TableHead className="w-32">Evidence</TableHead>
              <TableHead>How the platform knows</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const state = support(row);
              return (
                <TableRow key={row.id} data-capability={row.id}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  <TableCell className={state.className}>{state.text}</TableCell>
                  <TableCell>
                    <Badge variant={EVIDENCE_VARIANT[row.evidence]}>
                      {EVIDENCE_LABEL[row.evidence]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{row.detail}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
