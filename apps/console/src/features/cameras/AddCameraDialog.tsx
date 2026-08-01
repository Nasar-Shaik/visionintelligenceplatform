import { useState } from 'react';
import type { CreateCameraInput } from '@vip/contracts';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@/ui';
import { DVR_TEMPLATES, dvrChannels } from './cameraPresentation';
import { useCreateCamera, useCreateCameras } from './useCameras';

/**
 * Manual onboarding (P-1) — one camera, or a whole DVR/NVR at once.
 *
 * Discovery covers the ONVIF estate. This covers everything else, which in the pilot market is most
 * of it: CP Plus units with ONVIF disabled, DVRs behind a router that multicast never reaches, and
 * the very common case of a customer handing over a spreadsheet of RTSP URLs.
 *
 * **Credentials are entered here and never appear again.** The service seals them on write and the
 * API only ever returns `hasCredentials`, so this form is the one and only place a password is typed.
 */
export function AddCameraDialog({
  open,
  onOpenChange,
  zoneId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zoneId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add cameras</DialogTitle>
          <DialogDescription>
            Add a single camera by stream URL, or every channel of a DVR/NVR in one step.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="single">
          <TabsList>
            <TabsTrigger value="single">Single camera</TabsTrigger>
            <TabsTrigger value="dvr">DVR / NVR channels</TabsTrigger>
          </TabsList>
          <TabsContent value="single">
            <SingleCameraForm zoneId={zoneId} onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="dvr">
            <DvrChannelForm zoneId={zoneId} onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SingleCameraForm({ zoneId, onDone }: { zoneId: string; onDone: () => void }) {
  const create = useCreateCamera();
  const [name, setName] = useState('');
  const [streamUrl, setStreamUrl] = useState('rtsp://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    // The contract rejects a credentialed URL outright; saying so here beats a 400 from the server.
    if (/^[a-z]+:\/\/[^/]*@/i.test(streamUrl)) {
      setError(
        'Remove the username and password from the URL and enter them below — credentials are vaulted separately and never stored in a URL.',
      );
      return;
    }
    const input: CreateCameraInput = {
      zoneId,
      name: name.trim(),
      protocol: 'rtsp',
      streamUrl: streamUrl.trim(),
      ...(username || password ? { credentials: { username, password } } : {}),
    };
    create.mutate(input, {
      onSuccess: () => {
        toast.success(`${input.name} added`);
        onDone();
      },
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not add the camera'),
    });
  };

  return (
    <div className="space-y-3 pt-3">
      <div className="space-y-1">
        <Label htmlFor="camera-name">Name</Label>
        <Input
          id="camera-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Front entrance"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="camera-url">Stream URL</Label>
        <Input
          id="camera-url"
          value={streamUrl}
          onChange={(e) => setStreamUrl(e.target.value)}
          placeholder="rtsp://10.0.0.64:554/Streaming/Channels/102"
          className="font-mono text-xs"
        />
        <p className="text-xs text-text-subtle">
          Prefer the sub-stream. Analysing a 4K main stream when a 640×360 sub-stream would do costs
          decode and inference budget on every frame.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="camera-user">Username</Label>
          <Input
            id="camera-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="camera-pass">Password</Label>
          <Input
            id="camera-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
      </div>
      {error ? <Alert variant="critical">{error}</Alert> : null}
      <DialogFooter>
        <Button onClick={submit} disabled={!name.trim() || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add camera'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function DvrChannelForm({ zoneId, onDone }: { zoneId: string; onDone: () => void }) {
  const createMany = useCreateCameras();
  const [namePrefix, setNamePrefix] = useState('Channel');
  const [baseUrl, setBaseUrl] = useState('rtsp://');
  const [templateId, setTemplateId] = useState<string>(DVR_TEMPLATES[0].id);
  const [customTemplate, setCustomTemplate] = useState('/channel/{channel}');
  const [channels, setChannels] = useState(8);

  const template =
    templateId === 'custom'
      ? customTemplate
      : (DVR_TEMPLATES.find((t) => t.id === templateId)?.template ?? '');

  const preview = dvrChannels({ namePrefix, zoneId, baseUrl, pathTemplate: template, channels });

  const submit = () => {
    createMany.mutate(preview, {
      onSuccess: (res) => {
        if (res.failed === 0) {
          toast.success(`Added ${res.created} channels`);
          onDone();
          return;
        }
        // Partial success: name the channels that failed rather than discarding the ones that worked.
        const failed = res.results.filter((r) => !r.created);
        toast.error(
          `Added ${res.created}; ${res.failed} failed — ${failed
            .slice(0, 3)
            .map((r) => r.name)
            .join(', ')}${failed.length > 3 ? '…' : ''}`,
        );
      },
      onError: () => toast.error('Could not add the channels'),
    });
  };

  return (
    <div className="space-y-3 pt-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="dvr-prefix">Name prefix</Label>
          <Input
            id="dvr-prefix"
            value={namePrefix}
            onChange={(e) => setNamePrefix(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="dvr-count">Channels</Label>
          <Input
            id="dvr-count"
            type="number"
            min={1}
            max={64}
            value={channels}
            onChange={(e) => setChannels(Math.max(1, Math.min(64, Number(e.target.value))))}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="dvr-base">Recorder address</Label>
        <Input
          id="dvr-base"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="rtsp://10.0.0.9:554"
          className="font-mono text-xs"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="dvr-template">Channel path</Label>
        <Select value={templateId} onValueChange={setTemplateId}>
          <SelectTrigger id="dvr-template">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DVR_TEMPLATES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {templateId === 'custom' ? (
          <Input
            aria-label="Custom channel path template"
            value={customTemplate}
            onChange={(e) => setCustomTemplate(e.target.value)}
            className="mt-1 font-mono text-xs"
          />
        ) : null}
        <p className="text-xs text-text-subtle">
          <code>{'{channel}'}</code> is replaced with the channel number.
        </p>
      </div>
      {preview.length > 0 ? (
        <div className="rounded-md border border-border bg-surface-2 p-2 font-mono text-xs text-muted-foreground">
          <div>{preview[0]!.streamUrl}</div>
          {preview.length > 1 ? <div>{preview[1]!.streamUrl}</div> : null}
          {preview.length > 2 ? (
            <div className="text-text-subtle">…and {preview.length - 2} more</div>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button onClick={submit} disabled={createMany.isPending || baseUrl.trim() === 'rtsp://'}>
          {createMany.isPending ? 'Adding…' : `Add ${preview.length} channels`}
        </Button>
      </DialogFooter>
    </div>
  );
}
