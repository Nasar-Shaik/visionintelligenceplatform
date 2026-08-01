import { useState } from 'react';
import { Activity, Archive, KeyRound, PlugZap, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { Camera, CapabilityChange, StreamProbeResult } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { formatTimestamp } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
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
  FRESHNESS_KIND,
  FRESHNESS_LABEL,
  HEALTH_KIND,
  HEALTH_LABEL,
  LIFECYCLE_KIND,
  LIFECYCLE_LABEL,
  LIFECYCLE_MEANING,
  SEVERITY_KIND,
  analysisProfile,
} from './cameraPresentation';
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
export function CameraDetailSheet({
  camera,
  onClose,
  onDelete,
}: {
  camera: Camera | null;
  onClose: () => void;
  onDelete: (camera: Camera) => void;
}) {
  const setStatus = useSetCameraStatus();
  const checkHealth = useCheckCameraHealth();
  const probeCamera = useProbeCamera();
  const refreshCapabilities = useRefreshCapabilities();
  const lifecycleAction = useCameraLifecycleAction();
  const canUpdate = usePermission('camera:update');
  const canDelete = usePermission('camera:delete');
  const [probeResult, setProbeResult] = useState<StreamProbeResult | null>(null);
  // Kept in the sheet rather than only in a toast: "this deployment cannot test connections" is a
  // standing fact an installer needs while they work, not a message that disappears in four seconds.
  const [probeUnavailable, setProbeUnavailable] = useState<string | null>(null);
  const [capabilityChanges, setCapabilityChanges] = useState<CapabilityChange[] | null>(null);

  if (!camera) return null;
  const profiles = camera.capabilities.streamProfiles;
  const analysed = analysisProfile(camera.capabilities);

  return (
    <Sheet open={camera !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{camera.name}</SheetTitle>
          <SheetDescription>
            <span className="flex items-center gap-3">
              <StatusIndicator
                status={LIFECYCLE_KIND[camera.lifecycle.state]}
                label={LIFECYCLE_LABEL[camera.lifecycle.state]}
              />
              <StatusIndicator
                status={HEALTH_KIND[camera.health.status]}
                label={HEALTH_LABEL[camera.health.status]}
              />
            </span>
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          <Field label="Stream URL">
            <code className="break-all text-xs">{camera.streamUrl}</code>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Zone">{camera.zoneId}</Field>
            <Field label="Status">
              <Badge variant={camera.status === 'enabled' ? 'success' : 'neutral'}>
                {camera.status}
              </Badge>
            </Field>
            <Field label="Credentials">
              {camera.hasCredentials ? (
                <span className="inline-flex items-center gap-1 text-sm">
                  <KeyRound className="size-3" aria-hidden /> Vaulted
                </span>
              ) : (
                <span className="text-sm text-text-subtle">None</span>
              )}
            </Field>
            <Field label="Last checked">
              {camera.health.lastCheckedAt ? formatTimestamp(camera.health.lastCheckedAt) : '—'}
            </Field>
          </div>
          {camera.health.detail ? (
            <p className="text-sm text-status-warn">{camera.health.detail}</p>
          ) : null}

          {camera.metadata.manufacturer || camera.metadata.model ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Device
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Manufacturer">{camera.metadata.manufacturer ?? '—'}</Field>
                <Field label="Model">{camera.metadata.model ?? '—'}</Field>
                <Field label="Firmware">{camera.metadata.firmware ?? '—'}</Field>
                <Field label="Serial">{camera.metadata.serialNumber ?? '—'}</Field>
              </div>
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Lifecycle
            </h3>
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
                    <StatusIndicator
                      status={SEVERITY_KIND[change.severity]}
                      label={change.severity}
                    />
                    <span className="font-mono">{change.field}</span>
                    <span className="text-text-subtle">
                      {change.from ?? '(none)'} → {change.to ?? '(removed)'}
                    </span>
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
              <h3 className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Timeline
              </h3>
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
        </SheetBody>
        <SheetFooter className="justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!canUpdate || probeCamera.isPending}
              onClick={() =>
                probeCamera.mutate(camera.id, {
                  onSuccess: (report) => {
                    setProbeResult(report.probe ?? null);
                    setProbeUnavailable(report.unavailable ?? null);
                    if (report.unavailable) {
                      // A deployment gap, not a camera fault. Saying "test failed" here would send
                      // an installer to a working camera.
                      return;
                    }
                    toast.success(`Now ${LIFECYCLE_LABEL[report.lifecycle.state].toLowerCase()}`);
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
                      setCapabilityChanges(result.refreshed ? result.changes : null);
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
                    toast.success(`Health re-checked: ${HEALTH_LABEL[report.status]}`),
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
                      toast.success(
                        camera.status === 'enabled' ? 'Camera disabled' : 'Camera enabled',
                      ),
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
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Tri-state: an unmeasured signal reads "Not measured", never "No". */
function yesNo(value: boolean | undefined): string {
  if (value === undefined) return 'Not measured';
  return value ? 'Yes' : 'No';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}
