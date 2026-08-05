import { Activity, Archive, PlugZap, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { Camera, CapabilityChange, StreamProbeResult } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { formatTimestamp } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  StatusIndicator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@/ui';
import {
  COMPATIBILITY_KIND,
  COMPATIBILITY_LABEL,
  DRIFT_KIND,
  DRIFT_LABEL,
  FRESHNESS_KIND,
  FRESHNESS_LABEL,
  LIFECYCLE_MEANING,
  SEVERITY_KIND,
  analysisProfile,
  cameraLifecyclePresentation,
  healthPresentation,
} from './cameraPresentation';
import { EvidenceTimelinePanel } from './EvidenceTimelinePanel';
import { ProbeHistoryPanel } from './ProbeHistoryPanel';
import { ProbeResultPanel } from './ProbeResultPanel';
import {
  useCameraLifecycleAction,
  useCheckCameraHealth,
  useProbeCamera,
  useRefreshCapabilities,
  useSetCameraStatus,
} from './useCameras';

/**
 * Everything known about one camera (P-1) — connection, declared capabilities, stream profiles,
 * health, and the operator actions.
 *
 * The **stream profiles** table is the part that earns its space: it shows which profile the runtime
 * will analyze, and a camera publishing a 2560×1440 main stream with nothing marked for analysis is
 * a site quietly paying 16× the decode cost it needs to. That is invisible everywhere else.
 */
/**
 * Everything the **device** says about itself, and the operator actions that act on it.
 *
 * ### ⚠️ Why this is no longer a sheet
 *
 * These panels were reachable only by clicking a row: the camera had no address, so an installer
 * could not link to one, a refresh lost it, and the back button did nothing. P-6.6 gave the camera a
 * page (`/cameras/:id`) and moved the panels onto it **unchanged** — they were already the right
 * panels, and rewriting working screens is how a milestone spends itself on nothing. What moved is
 * where they live; what stayed is every measurement, every tri-state, and every honest "not
 * measured" they already carried.
 *
 * The **stream profiles** table is the part that earns its space: it shows which profile the runtime
 * will analyse, and a camera publishing a 2560×1440 main stream with nothing marked for analysis is
 * a site quietly paying 16× the decode cost it needs to. That is invisible everywhere else.
 */
export function CameraDeviceSections({
  camera,
  probeResult,
  probeUnavailable,
  capabilityChanges,
}: {
  camera: Camera;
  /*
   * ⚠️ These come from the actions that produced them, not from state of their own.
   *
   * Extracting these panels out of the sheet split one component into two, and the first cut left
   * the display holding its *own* copies of this state — so a probe would run, the action would
   * record the result, and the panel that exists to show it would render nothing for ever. The
   * producer owns the state; the display is given it.
   */
  probeResult: StreamProbeResult | null;
  /* "This deployment cannot test connections" is a standing fact an installer needs while they
     work, not a message that disappears in four seconds. */
  probeUnavailable: string | null;
  capabilityChanges: CapabilityChange[] | null;
}) {
  const profiles = camera.capabilities.streamProfiles;
  const analysed = analysisProfile(camera.capabilities);

  return (
    <div className="space-y-6">
      {/*
            ⚠️ Stream URL, location, status, credentials and "last checked" are in the page header
            and summary grid above. They were here when this was a drawer with nothing above it.
          */}
      {camera.health.detail ? (
        <p className="text-sm text-status-warn">{camera.health.detail}</p>
      ) : null}

      {/*
            ⚠️ The device block that used to live here is on the page above, where it also carries
            the tags, the description and the notes an operator writes. Two blocks showing the same
            four fields is how a page starts contradicting itself after one of them is edited.
          */}

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">Lifecycle</h3>
        <p className="text-sm">{LIFECYCLE_MEANING[camera.lifecycle.state]}</p>
        <p className="text-xs text-text-subtle">
          Since {formatTimestamp(camera.lifecycle.since)} · {camera.lifecycle.evidence} evidence
          {camera.lifecycle.reason ? ` · ${camera.lifecycle.reason}` : ''}
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Measured health
        </h3>
        {camera.operational ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Reachable">{yesNo(camera.operational.reachable)}</Field>
              <Field label="Stream">{yesNo(camera.operational.streamAvailable)}</Field>
              <Field label="Latency">
                {camera.operational.rtspLatencyMs !== undefined
                  ? `${Math.round(camera.operational.rtspLatencyMs)} ms`
                  : 'Not measured'}
              </Field>
              <Field label="Frame rate">
                {camera.operational.fps !== undefined
                  ? `${camera.operational.fps.toFixed(1)} fps`
                  : 'Not measured'}
              </Field>
              <Field label="Authentication">{camera.operational.authentication}</Field>
              <Field label="Last frame">
                {camera.operational.lastFrameAt
                  ? formatTimestamp(camera.operational.lastFrameAt)
                  : 'Never'}
              </Field>
            </div>
            <p className="text-xs text-text-subtle">
              Observed {formatTimestamp(camera.operational.observedAt)} via{' '}
              {camera.operational.source} · {camera.operational.evidenceClass} evidence
            </p>
          </>
        ) : (
          // "Never measured" and "measured and found offline" are different facts. Rendering
          // the first as zeros would be claiming a measurement nobody took.
          <p className="text-sm text-text-subtle">
            Nothing has ever measured this camera. Run a connection test to find out whether it
            works.
          </p>
        )}
      </section>

      {camera.identity || camera.identityHistory.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Device identity
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <Field label="ONVIF UUID">{camera.identity?.onvifUuid ?? '—'}</Field>
            <Field label="Serial">{camera.identity?.serialNumber ?? '—'}</Field>
            <Field label="MAC">{camera.identity?.macAddress ?? '—'}</Field>
            <Field label="Last known address">{camera.identity?.lastKnownAddress ?? '—'}</Field>
          </div>
          {camera.identityHistory.length > 0 ? (
            <ol className="space-y-1 border-l border-border pl-3">
              {[...camera.identityHistory].reverse().map((change, i) => (
                <li key={`${change.at}-${i}`} className="text-xs">
                  <span className="font-mono">{change.attribute}</span>{' '}
                  <span className="text-text-subtle">
                    {change.from ?? '(first seen)'} → {change.to}
                  </span>
                  <div className="text-text-subtle">
                    {formatTimestamp(change.at)} · {change.source}
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      {probeUnavailable ? (
        <Alert variant="warning" title="Connections cannot be tested here">
          <p>{probeUnavailable}</p>
          <p className="mt-1 text-muted-foreground">
            This is a deployment gap, not a fault with this camera.
          </p>
        </Alert>
      ) : null}
      {probeResult ? <ProbeResultPanel probe={probeResult} /> : null}

      <ProbeHistoryPanel cameraId={camera.id} />

      <EvidenceTimelinePanel cameraId={camera.id} />

      {camera.compatibility.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Compatibility
          </h3>
          {/* Every condition this camera has run under, not only the current one (P-2.2 rec 5).
                  A camera that worked on V5.7.9 and has failed since V5.8.0 is telling a story that
                  a single current-status field erases — and the story is the diagnosis. */}
          <ul className="space-y-1">
            {camera.compatibility.map((row) => (
              <li
                key={`${row.dimension}:${row.value}`}
                className="flex items-baseline gap-2 text-xs"
              >
                <StatusIndicator
                  status={COMPATIBILITY_KIND[row.status]}
                  label={COMPATIBILITY_LABEL[row.status]}
                />
                <span className="text-text-subtle">{row.dimension}</span>
                <span className="font-mono">{row.value}</span>
                <span className="ml-auto text-text-subtle">
                  {row.successfulProbes}✓ / {row.failedProbes}✗
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Capabilities
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {camera.capabilities.onvif ? <Badge variant="brand">ONVIF</Badge> : null}
          {camera.capabilities.ptz ? <Badge variant="outline">PTZ</Badge> : null}
          {camera.capabilities.audio ? <Badge variant="outline">Audio</Badge> : null}
          {camera.capabilities.metadataStream ? (
            <Badge variant="outline">Metadata stream</Badge>
          ) : null}
          {camera.capabilities.codecs.map((codec) => (
            <Badge key={codec} variant="neutral">
              {codec.toUpperCase()}
            </Badge>
          ))}
          {camera.capabilities.fpsRange ? (
            <Badge variant="neutral">
              {camera.capabilities.fpsRange.min}–{camera.capabilities.fpsRange.max} fps
            </Badge>
          ) : null}
        </div>
        {camera.capabilityCache ? (
          <p className="flex items-center gap-2 text-xs">
            <StatusIndicator
              status={FRESHNESS_KIND[camera.capabilityCache.freshness]}
              label={FRESHNESS_LABEL[camera.capabilityCache.freshness]}
            />
            <span className="text-text-subtle">
              from {camera.capabilityCache.source}
              {camera.capabilityCache.firmware
                ? ` · read against ${camera.capabilityCache.firmware}`
                : ''}
              {camera.capabilityCache.lastRefreshedAt
                ? ` · ${formatTimestamp(camera.capabilityCache.lastRefreshedAt)}`
                : ''}
            </span>
          </p>
        ) : null}
        {capabilityChanges && capabilityChanges.length > 0 ? (
          <ul className="space-y-1 rounded-md border border-border p-2">
            {capabilityChanges.map((change) => (
              <li key={change.field} className="flex items-baseline gap-2 text-xs">
                <StatusIndicator status={SEVERITY_KIND[change.severity]} label={change.severity} />
                <span className="font-mono">{change.field}</span>
                <span className="text-text-subtle">
                  {change.from ?? '(none)'} → {change.to ?? '(removed)'}
                </span>
                {/* P-2.2 rec 3. `unexpected` is the whole point of the row: a codec that moved
                        with nothing to account for it means the device was reconfigured by somebody
                        outside this platform. */}
                <StatusIndicator
                  status={DRIFT_KIND[change.drift]}
                  label={
                    change.drift === 'unexpected' && change.cause !== 'unexplained'
                      ? `${DRIFT_LABEL[change.drift]} · after ${change.cause.replace('-', ' ')}`
                      : change.drift === 'unexpected'
                        ? `${DRIFT_LABEL[change.drift]} · unexplained`
                        : DRIFT_LABEL[change.drift]
                  }
                />
                {change.direction === 'reduced' ? <Badge variant="outline">reduced</Badge> : null}
              </li>
            ))}
          </ul>
        ) : capabilityChanges ? (
          <p className="text-xs text-text-subtle">
            The device was re-read and nothing had changed.
          </p>
        ) : null}
        {camera.capabilities.discoveredAt ? (
          <p className="text-xs text-text-subtle">
            Confirmed against the device {formatTimestamp(camera.capabilities.discoveredAt)}
          </p>
        ) : (
          <p className="text-xs text-text-subtle">
            Declared, not confirmed against the device. Run discovery to populate these from the
            camera itself.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
          Stream profiles
        </h3>
        {profiles.length === 0 ? (
          <p className="text-sm text-text-subtle">
            No profiles declared — the runtime will analyse the configured URL as-is.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Profile</TableHead>
                <TableHead>Resolution</TableHead>
                <TableHead>FPS</TableHead>
                <TableHead>Analysed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((profile) => (
                <TableRow key={profile.name}>
                  <TableCell className="font-medium">{profile.name}</TableCell>
                  <TableCell>{profile.resolution ?? '—'}</TableCell>
                  <TableCell>{profile.fps ?? '—'}</TableCell>
                  <TableCell>
                    {profile.preferredForAnalysis ? (
                      <Badge variant="success">Yes</Badge>
                    ) : (
                      <span className="text-text-subtle">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {profiles.length > 1 && !analysed ? (
          <p className="text-xs text-status-warn">
            This device publishes several profiles but none is marked for analysis, so the main
            stream will be decoded on every frame.
          </p>
        ) : null}
      </section>
      {camera.timeline.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">Timeline</h3>
          <ol className="space-y-1.5 border-l border-border pl-3">
            {[...camera.timeline].reverse().map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="text-sm">
                <span className="font-medium">{entry.kind.replace(/-/g, ' ')}</span>
                {entry.from && entry.to ? (
                  <span className="text-muted-foreground">
                    {' '}
                    {entry.from} → {entry.to}
                  </span>
                ) : null}
                <div className="text-xs text-text-subtle">
                  {formatTimestamp(entry.at)} · {entry.detail}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

/** The write actions for one camera. Every one is permission-gated and reports what it did. */
export function CameraActions({
  camera,
  onDelete,
  onProbeResult,
  onProbeUnavailable,
  onCapabilityChanges,
}: {
  camera: Camera;
  onDelete: (camera: Camera) => void;
  onProbeResult: (result: StreamProbeResult | null) => void;
  onProbeUnavailable: (reason: string | null) => void;
  onCapabilityChanges: (changes: CapabilityChange[] | null) => void;
}) {
  const setStatus = useSetCameraStatus();
  const checkHealth = useCheckCameraHealth();
  const probeCamera = useProbeCamera();
  const refreshCapabilities = useRefreshCapabilities();
  const lifecycleAction = useCameraLifecycleAction();
  const canUpdate = usePermission('camera:update');
  const canDelete = usePermission('camera:delete');

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canUpdate || probeCamera.isPending}
          onClick={() =>
            probeCamera.mutate(camera.id, {
              onSuccess: (report) => {
                onProbeResult(report.probe ?? null);
                onProbeUnavailable(report.unavailable ?? null);
                if (report.unavailable) {
                  // A deployment gap, not a camera fault. Saying "test failed" here would send
                  // an installer to a working camera.
                  return;
                }
                toast.success(
                  `Now ${cameraLifecyclePresentation(report.lifecycle.state).label.toLowerCase()}`,
                );
              },
              onError: () => toast.error('Could not test the connection'),
            })
          }
        >
          <PlugZap className="size-4" aria-hidden />
          {probeCamera.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button
          variant="outline"
          disabled={!canUpdate || refreshCapabilities.isPending}
          onClick={() =>
            refreshCapabilities.mutate(
              { id: camera.id, force: true },
              {
                onSuccess: (result) => {
                  onCapabilityChanges(result.refreshed ? result.changes : null);
                  if (result.unavailable) {
                    toast.error(result.unavailable);
                    return;
                  }
                  toast.success(
                    result.refreshed
                      ? `Re-read from the device — ${result.changes.length} change${result.changes.length === 1 ? '' : 's'}`
                      : 'Served from cache — the device was not contacted',
                  );
                },
                onError: () => toast.error('Could not refresh capabilities'),
              },
            )
          }
        >
          <RefreshCw className="size-4" aria-hidden />
          Refresh capabilities
        </Button>
        <Button
          variant="outline"
          disabled={!canUpdate || lifecycleAction.isPending}
          onClick={() =>
            lifecycleAction.mutate(
              {
                id: camera.id,
                action: camera.lifecycle.state === 'retired' ? 'reinstate' : 'retire',
              },
              {
                onSuccess: (updated) =>
                  toast.success(
                    updated.lifecycle.state === 'retired'
                      ? 'Camera retired — its history is kept'
                      : 'Camera reinstated',
                  ),
                onError: () => toast.error('Could not change the lifecycle state'),
              },
            )
          }
        >
          {camera.lifecycle.state === 'retired' ? (
            <RotateCcw className="size-4" aria-hidden />
          ) : (
            <Archive className="size-4" aria-hidden />
          )}
          {camera.lifecycle.state === 'retired' ? 'Reinstate' : 'Retire'}
        </Button>
        <Button
          variant="outline"
          disabled={!canUpdate || checkHealth.isPending}
          onClick={() =>
            checkHealth.mutate(camera.id, {
              onSuccess: (report) =>
                toast.success(`Health re-checked: ${healthPresentation(report.status).label}`),
              onError: () => toast.error('Could not re-check health'),
            })
          }
        >
          <Activity className="size-4" aria-hidden />
          Re-check health
        </Button>
        <Button
          variant="outline"
          disabled={!canUpdate || setStatus.isPending}
          onClick={() =>
            setStatus.mutate(
              { id: camera.id, status: camera.status === 'enabled' ? 'disabled' : 'enabled' },
              {
                onSuccess: () =>
                  toast.success(camera.status === 'enabled' ? 'Camera disabled' : 'Camera enabled'),
                onError: () => toast.error('Could not change the camera status'),
              },
            )
          }
        >
          {camera.status === 'enabled' ? 'Disable' : 'Enable'}
        </Button>
      </div>
      {canDelete ? (
        <Button variant="destructive" onClick={() => onDelete(camera)}>
          <Trash2 className="size-4" aria-hidden />
          Remove
        </Button>
      ) : null}
      {canDelete ? (
        <Button variant="destructive" onClick={() => onDelete(camera)}>
          <Trash2 className="size-4" aria-hidden />
          Remove
        </Button>
      ) : null}
    </div>
  );
}

/** One labelled fact. Shared by the page and these sections so both read identically. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

/** Tri-state: an unmeasured signal reads "Not measured", never "No". */
function yesNo(value: boolean | undefined): string {
  if (value === undefined) return 'Not measured';
  return value ? 'Yes' : 'No';
}
