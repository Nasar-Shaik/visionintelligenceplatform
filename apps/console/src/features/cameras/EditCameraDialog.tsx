import { useEffect, useState } from 'react';
import type { Camera, UpdateCameraInput } from '@vip/contracts';
import { ApiRequestError } from '@/lib/api/http';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  toast,
} from '@/ui';
import { useUpdateCamera } from './useCameras';

/**
 * Edit one camera.
 *
 * ### ⚠️ Why this dialog did not exist before P-6.6
 *
 * `PATCH /cameras/:id` has been implemented since P-1 and the console's client has called it since
 * P2-1 — through a hook nothing imported. A camera could be created, probed, disabled, retired and
 * deleted from the console, and its name could not be corrected. That is the audit finding this
 * dialog closes, and it is why the milestone starts with an inventory rather than a design.
 *
 * ### ⚠️ Two operators, one camera
 *
 * Measured on the deployment: without a concurrency token both administrators received HTTP 200 and
 * one edit was thrown away. This dialog sends the `updatedAt` of the record it opened with, so the
 * server can refuse the second write. **A conflict is not an error message and a shrug** — the
 * dialog keeps what was typed, says who changed the record and when, and offers to reload it, so the
 * operator can reapply their change instead of retyping it into a record they have not seen.
 */
export function EditCameraDialog({
  camera,
  open,
  onOpenChange,
}: {
  camera: Camera;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateCamera(camera.id);
  const [name, setName] = useState(camera.name);
  const [streamUrl, setStreamUrl] = useState(camera.streamUrl);
  const [manufacturer, setManufacturer] = useState(camera.metadata.manufacturer ?? '');
  const [model, setModel] = useState(camera.metadata.model ?? '');
  const [describedAs, setDescribedAs] = useState(camera.metadata.location ?? '');
  const [tags, setTags] = useState(camera.metadata.tags.join(', '));
  const [notes, setNotes] = useState(camera.metadata.notes ?? '');
  const [codec, setCodec] = useState(camera.capture.codec ?? '');
  const [resolution, setResolution] = useState(camera.capture.resolution ?? '');
  const [fps, setFps] = useState(camera.capture.fps?.toString() ?? '');
  const [conflict, setConflict] = useState<string | null>(null);

  /* Re-seed when a different camera is opened, or when the record is reloaded after a conflict. */
  useEffect(() => {
    if (!open) return;
    setName(camera.name);
    setStreamUrl(camera.streamUrl);
    setManufacturer(camera.metadata.manufacturer ?? '');
    setModel(camera.metadata.model ?? '');
    setDescribedAs(camera.metadata.location ?? '');
    setTags(camera.metadata.tags.join(', '));
    setNotes(camera.metadata.notes ?? '');
    setCodec(camera.capture.codec ?? '');
    setResolution(camera.capture.resolution ?? '');
    setFps(camera.capture.fps?.toString() ?? '');
    setConflict(null);
  }, [open, camera]);

  const submit = () => {
    const patch: UpdateCameraInput = {
      name: name.trim(),
      streamUrl: streamUrl.trim(),
      capture: {
        ...camera.capture,
        ...(codec ? { codec: codec as 'h264' | 'h265' } : {}),
        ...(resolution.trim() ? { resolution: resolution.trim() } : {}),
        ...(fps.trim() ? { fps: Number(fps) } : {}),
      },
      metadata: {
        ...camera.metadata,
        ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(describedAs.trim() ? { location: describedAs.trim() } : {}),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
    };

    update.mutate(
      { patch, expectedUpdatedAt: camera.updatedAt },
      {
        onSuccess: () => {
          toast.success(`${patch.name ?? camera.name} saved`);
          onOpenChange(false);
        },
        onError: (error) => {
          /*
           * ⚠️ 409 is not a failure of the operator's work — it is the platform refusing to throw
           * somebody else's away. It gets its own treatment, in the dialog, with what was typed
           * still in the fields.
           */
          if (error instanceof ApiRequestError && error.status === 409) {
            setConflict(error.message);
            return;
          }
          toast.error(
            error instanceof ApiRequestError ? error.message : 'The camera could not be saved',
          );
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {camera.name}</DialogTitle>
          <DialogDescription>
            Changes are recorded on the camera&rsquo;s timeline with who made them and when.
          </DialogDescription>
        </DialogHeader>

        {conflict ? (
          <Alert variant="critical">
            <span className="font-medium">Somebody else changed this camera.</span> {conflict} Your
            edits are still here — reload the camera and apply them again so neither change is lost.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="camera-name">Name</Label>
            <Input id="camera-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="camera-url">Stream URL</Label>
            <Input
              id="camera-url"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
              className="font-mono text-xs"
            />
            {/* ⚠️ The scheme is immutable — the service refuses a URL whose scheme is not the
                camera's protocol, so say it here rather than after a failed save. */}
            <p className="mt-1 text-xs text-text-subtle">
              Must stay {camera.protocol.toUpperCase()} — the protocol is fixed at onboarding.
            </p>
          </div>
          <div>
            <Label htmlFor="camera-manufacturer">Manufacturer</Label>
            <Input
              id="camera-manufacturer"
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="camera-model">Model</Label>
            <Input id="camera-model" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="camera-codec">Codec</Label>
            <Input
              id="camera-codec"
              value={codec}
              onChange={(e) => setCodec(e.target.value)}
              placeholder="h264 or h265"
            />
          </div>
          <div>
            <Label htmlFor="camera-resolution">Resolution</Label>
            <Input
              id="camera-resolution"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="1920x1080"
            />
          </div>
          <div>
            <Label htmlFor="camera-fps">Frame rate</Label>
            <Input
              id="camera-fps"
              value={fps}
              onChange={(e) => setFps(e.target.value)}
              placeholder="fps"
              inputMode="numeric"
            />
          </div>
          <div>
            <Label htmlFor="camera-described">Described as</Label>
            <Input
              id="camera-described"
              value={describedAs}
              onChange={(e) => setDescribedAs(e.target.value)}
              placeholder="Third aisle, facing the tills"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="camera-tags">Tags</Label>
            <Input
              id="camera-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="entrance, high-value, night-shift"
            />
            <p className="mt-1 text-xs text-text-subtle">Comma separated. Searchable.</p>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="camera-notes">Notes</Label>
            <Textarea
              id="camera-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What an engineer arriving at this camera should know."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={update.isPending || name.trim() === ''}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
