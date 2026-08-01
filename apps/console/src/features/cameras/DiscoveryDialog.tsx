import { useState } from 'react';
import { Check, RadioTower, ScanSearch } from 'lucide-react';
import type { CreateCameraInput, DiscoveredCamera } from '@vip/contracts';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@/ui';
import { capabilitySummary } from './cameraPresentation';
import { useCreateCameras, useDiscoverCameras } from './useCameras';

/**
 * ONVIF discovery and onboarding (P-1).
 *
 * Three deliberate behaviours, each of them the difference between a tool an installer trusts and
 * one they stop using:
 *
 *  - **Already-onboarded devices are shown, greyed, not hidden.** Re-scanning a half-configured site
 *    must let someone see that the four cameras missing from their list are the four already added —
 *    not four that failed to answer.
 *  - **"Could not run" is never rendered as "found nothing".** A blocked multicast sends an installer
 *    to their network; an empty result sends them to their cameras. Conflating them wastes an
 *    afternoon at the wrong end of the building.
 *  - **A device that half-answered is still listed, with its warning.** Bad credentials or a partially
 *    disabled ONVIF stack mean the camera exists and is worth onboarding manually; dropping it would
 *    say it is not on the network.
 */
export function DiscoveryDialog({
  open,
  onOpenChange,
  zoneId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zoneId: string;
}) {
  const discover = useDiscoverCameras();
  const onboard = useCreateCameras();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [timeoutSeconds, setTimeoutSeconds] = useState(3);

  const result = discover.data;
  const devices = result?.devices ?? [];
  const onboardable = devices.filter((d) => !d.alreadyOnboarded && d.suggestedStreamUrl);

  const scan = () => {
    setSelected(new Set());
    discover.mutate(
      { timeoutSeconds },
      {
        onError: () => toast.error('The scan could not be started'),
      },
    );
  };

  const toggle = (endpoint: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(endpoint)) next.delete(endpoint);
      else next.add(endpoint);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(
      selected.size === onboardable.length
        ? new Set()
        : new Set(onboardable.map((d) => d.endpoint)),
    );
  };

  const submit = () => {
    const cameras: CreateCameraInput[] = onboardable
      .filter((d) => selected.has(d.endpoint))
      .map(toCreateInput(zoneId));
    if (cameras.length === 0) return;
    onboard.mutate(cameras, {
      onSuccess: (res) => {
        if (res.failed === 0) {
          toast.success(`Onboarded ${res.created} camera${res.created === 1 ? '' : 's'}`);
          onOpenChange(false);
          return;
        }
        // Partial success is a real outcome, not an error — name what failed rather than rolling back.
        toast.error(`Onboarded ${res.created}; ${res.failed} could not be added`);
      },
      onError: () => toast.error('Could not onboard the selected cameras'),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Discover cameras</DialogTitle>
          <DialogDescription>
            Probes the local network for ONVIF devices. Multicast does not cross a router, so this
            finds cameras on this segment only.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2 pb-2">
          <div className="w-40 space-y-1">
            <Label htmlFor="discovery-timeout">Listen for (seconds)</Label>
            <Input
              id="discovery-timeout"
              type="number"
              min={1}
              max={30}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            />
          </div>
          <Button onClick={scan} disabled={discover.isPending}>
            <ScanSearch className="size-4" aria-hidden />
            {discover.isPending ? 'Scanning…' : 'Scan'}
          </Button>
        </div>

        {result?.unavailable ? (
          <Alert variant="warning" title="Discovery could not run">
            <p>{result.unavailable}</p>
            <p className="mt-1 text-muted-foreground">
              This is a network or configuration problem, not an empty estate — cameras may still be
              reachable. Add them by stream URL in the meantime.
            </p>
          </Alert>
        ) : null}

        {discover.isSuccess && !result?.unavailable && devices.length === 0 ? (
          <EmptyState
            icon={RadioTower}
            title="No devices answered"
            description="No ONVIF device replied on this segment. Check that ONVIF is enabled on the cameras, and that this host is on the same VLAN."
          />
        ) : null}

        {devices.length > 0 ? (
          <div className="max-h-96 overflow-y-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select all discoverable cameras"
                      checked={onboardable.length > 0 && selected.size === onboardable.length}
                      onChange={selectAll}
                      disabled={onboardable.length === 0}
                    />
                  </TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => (
                  <DeviceRow
                    key={device.endpoint}
                    device={device}
                    checked={selected.has(device.endpoint)}
                    onToggle={() => toggle(device.endpoint)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={selected.size === 0 || onboard.isPending}>
            {onboard.isPending
              ? 'Adding…'
              : `Add ${selected.size} camera${selected.size === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceRow({
  device,
  checked,
  onToggle,
}: {
  device: DiscoveredCamera;
  checked: boolean;
  onToggle: () => void;
}) {
  const selectable = !device.alreadyOnboarded && Boolean(device.suggestedStreamUrl);
  const label = [device.metadata.manufacturer, device.metadata.model].filter(Boolean).join(' ');
  return (
    <TableRow className={device.alreadyOnboarded ? 'opacity-60' : undefined}>
      <TableCell>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={!selectable}
          aria-label={`Select ${label || device.endpoint}`}
        />
      </TableCell>
      <TableCell>
        <div className="font-medium">{label || 'Unidentified device'}</div>
        {device.metadata.firmware ? (
          <div className="text-xs text-text-subtle">Firmware {device.metadata.firmware}</div>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs">{device.address ?? device.endpoint}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {capabilitySummary(device.capabilities) || '—'}
      </TableCell>
      <TableCell>
        {device.alreadyOnboarded ? (
          <Badge variant="outline">
            <Check className="size-3" aria-hidden /> Already added
          </Badge>
        ) : device.warning ? (
          <span className="text-xs text-status-warn">{device.warning}</span>
        ) : !device.suggestedStreamUrl ? (
          <span className="text-xs text-text-subtle">No stream URL — add manually</span>
        ) : (
          <Badge variant="outline">Ready</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}

/**
 * A discovered device → a `CreateCameraInput`.
 *
 * Capabilities are carried across verbatim, which is the whole point of discovery: the runtime then
 * **reads** them instead of probing the device on every session start. Credentials are NOT carried —
 * the suggested URL never contains any, and an operator supplies them per camera afterwards.
 */
export function toCreateInput(zoneId: string) {
  return (device: DiscoveredCamera): CreateCameraInput => ({
    zoneId,
    name:
      [device.metadata.manufacturer, device.metadata.model].filter(Boolean).join(' ') ||
      (device.address ?? 'Discovered camera'),
    protocol: 'rtsp',
    streamUrl: device.suggestedStreamUrl as string,
    capabilities: device.capabilities,
    metadata: device.metadata,
  });
}
