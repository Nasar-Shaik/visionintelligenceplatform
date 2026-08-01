import type { StreamProbeResult } from '@vip/contracts';
import { Alert, Badge } from '@/ui';
import { CHECK_GLYPH, CHECK_LABEL, probeHeadline } from './cameraPresentation';

/**
 * The test-connection readout (P-2, Architect P-2 rec 7).
 *
 * **"Connection failed" is not a diagnosis.** It is the same message whether the cable is out, the
 * password is wrong, or the camera is serving a profile it cannot encode — three problems with three
 * different people fixing them. This panel renders the ordered check list instead, so an installer
 * standing on a ladder reads:
 *
 *     ✓ Device reachable
 *     ✗ Authentication — 401 from the device
 *     – RTSP opened
 *
 * and knows in one glance that the camera is fine and the credentials are not. The dashes matter as
 * much as the crosses: a check that was never reached must not look like one that failed.
 */
export function ProbeResultPanel({ probe }: { probe: StreamProbeResult }) {
  const headline = probeHeadline(probe.checks);
  const simulated = probe.evidenceClass !== 'hardware';

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Connection test
        </h3>
        <Badge variant={probe.evidenceClass === 'hardware' ? 'neutral' : 'outline'}>
          {probe.evidenceClass}
        </Badge>
      </div>

      {simulated ? (
        <Alert variant="warning" title="Measured against a simulated source">
          <p>
            This test exercised the platform, not a camera. The camera&rsquo;s state is unchanged —
            only a probe of the physical device can connect it.
          </p>
        </Alert>
      ) : headline ? (
        <Alert variant="warning" title={headline}>
          <p>The first failing check is the one to fix — everything below it is a consequence.</p>
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
            <span className={check.status === 'not-executed' ? 'text-text-subtle' : undefined}>
              {CHECK_LABEL[check.name] ?? check.name}
            </span>
            {check.measured ? (
              <span className="font-mono text-xs text-muted-foreground">{check.measured}</span>
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
    </section>
  );
}
