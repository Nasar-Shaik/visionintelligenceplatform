import type { StreamProbeResult } from '@vip/contracts';
import { Alert, Badge } from '@/ui';
import {
  CHECK_GLYPH,
  CHECK_LABEL,
  FAILURE_LABEL,
  FAILURE_REMEDY,
  formatDuration,
} from './cameraPresentation';

/**
 * The test-connection readout (P-2, deepened P-2.1).
 *
 * **"Connection failed" is not a diagnosis.** It is the same message whether the cable is out, the
 * password is wrong, DNS is broken, or the camera is serving a profile it cannot encode — four
 * problems with four different people fixing them. This panel renders the staged report instead, so
 * an installer on a ladder reads:
 *
 *     ✓ Name resolved            10.0.0.64      12 ms
 *     ✓ Device reachable         10.0.0.64:554   4 ms
 *     ✗ Authentication           — 401 from the device
 *     – RTSP negotiated
 *
 * and knows in one glance that the camera is fine and the credentials are not. Three details carry
 * that: the dashes (a stage never *reached* must not look like one that failed), the dots (a stage
 * this transport does not *have* is different again), and the per-stage timings — because "the
 * camera is slow" and "negotiation takes 1.4s" are different problems.
 *
 * **This component renders; it does not decide** (Architect P-2.1 rec 10). The failure headline comes
 * from `probe.failureCode`, which the runtime assigned. An earlier version inferred it here by
 * scanning for the first failing check, which is business logic in the visualization tier and would
 * have drifted from the runtime the first time a stage was renamed.
 */
export function ProbeResultPanel({ probe }: { probe: StreamProbeResult }) {
  const simulated = probe.evidenceClass !== 'hardware';

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Connection test
        </h3>
        <div className="flex items-center gap-2">
          {probe.totalMs !== undefined ? (
            <span className="font-mono text-xs text-text-subtle">
              {formatDuration(probe.totalMs)} total
            </span>
          ) : null}
          <Badge variant={probe.evidenceClass === 'hardware' ? 'neutral' : 'outline'}>
            {probe.evidenceClass}
          </Badge>
        </div>
      </div>

      {simulated ? (
        <Alert variant="warning" title="Measured against a simulated source">
          <p>
            This test exercised the platform, not a camera. The camera&rsquo;s state is unchanged —
            only a probe of the physical device can connect it.
          </p>
        </Alert>
      ) : probe.failureCode ? (
        <Alert variant="warning" title={FAILURE_LABEL[probe.failureCode]}>
          <p>{FAILURE_REMEDY[probe.failureCode]}</p>
        </Alert>
      ) : null}

      <ul className="space-y-1">
        {probe.checks.map((check) => (
          <li key={check.name} className="flex items-baseline gap-2 text-sm">
            <span
              aria-hidden
              className={
                check.status === 'pass'
                  ? 'text-status-ok'
                  : check.status === 'fail'
                    ? 'text-status-error'
                    : check.status === 'warn'
                      ? 'text-status-warn'
                      : 'text-text-subtle'
              }
            >
              {CHECK_GLYPH[check.status]}
            </span>
            <span
              className={
                check.status === 'not-executed' || check.status === 'skipped'
                  ? 'text-text-subtle'
                  : undefined
              }
            >
              {CHECK_LABEL[check.name] ?? check.name}
            </span>
            {check.measured ? (
              <span className="font-mono text-xs text-muted-foreground">{check.measured}</span>
            ) : null}
            {check.durationMs !== undefined ? (
              <span className="ml-auto font-mono text-xs text-text-subtle">
                {formatDuration(check.durationMs)}
              </span>
            ) : null}
            {check.detail ? (
              <span className="text-xs text-text-subtle">— {check.detail}</span>
            ) : null}
            <span className="sr-only">{check.status}</span>
          </li>
        ))}
      </ul>

      {probe.warnings.map((warning) => (
        <p key={warning} className="text-xs text-status-warn">
          {warning}
        </p>
      ))}

      <p className="text-xs text-text-subtle">
        Probe v{probe.probeVersion}
        {probe.runtimeVersion ? ` · runtime ${probe.runtimeVersion}` : ''}
        {probe.correlationId ? ` · ${probe.correlationId}` : ''}
      </p>
    </section>
  );
}
