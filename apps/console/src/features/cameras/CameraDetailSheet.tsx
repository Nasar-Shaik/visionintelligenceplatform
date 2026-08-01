import { Activity, KeyRound, Trash2 } from 'lucide-react';
import type { Camera } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { formatTimestamp } from '@/lib/format';
import {
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
import { HEALTH_KIND, HEALTH_LABEL, analysisProfile } from './cameraPresentation';
import { useCheckCameraHealth, useSetCameraStatus } from './useCameras';

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
  const canUpdate = usePermission('camera:update');
  const canDelete = usePermission('camera:delete');

  if (!camera) return null;
  const profiles = camera.capabilities.streamProfiles;
  const analysed = analysisProfile(camera.capabilities);

  return (
    <Sheet open={camera !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{camera.name}</SheetTitle>
          <SheetDescription>
            <StatusIndicator
              status={HEALTH_KIND[camera.health.status]}
              label={HEALTH_LABEL[camera.health.status]}
            />
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
        </SheetBody>
        <SheetFooter className="justify-between">
          <div className="flex gap-2">
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}
