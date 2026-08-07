import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileVideo, Upload } from 'lucide-react';
import {
  Button,
  EmptyState,
  PageHeader,
  QueryBoundary,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from '@/ui';
import { formatTimestamp, timeAgo } from '@/lib/format';
import { useCameras } from '@/features/cameras/useCameras';
import { useInvestigations, useUploadInvestigation } from './useInvestigations';

/**
 * Offline video investigation — the list, and the upload that starts one.
 *
 * ⚠️ **The camera is chosen before the file, and it is required.** The camera carries the detection
 * zones and the rule scope, so an analysis bound to the wrong one is evaluated against the wrong
 * polygons and the wrong policy. The service refuses an unknown camera; the form refuses to let an
 * operator get that far.
 */
export function InvestigationsPage() {
  const query = useInvestigations({ limit: 50 });
  const cameras = useCameras();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cameraId, setCameraId] = useState('');
  const [stage, setStage] = useState<string | null>(null);
  const upload = useUploadInvestigation((s) => setStage(s));

  const onPick = (file: File | undefined): void => {
    if (file === undefined || cameraId === '') return;
    upload.mutate(
      { file, cameraId, label: file.name },
      { onSettled: () => setStage(null) },
    );
  };

  const cameraOptions = cameras.data?.cameras ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Investigations"
        description="Upload a recording and analyse it through the same pipeline your cameras use."
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="min-w-56">
          <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="camera">
            Camera
          </label>
          <Select value={cameraId} onValueChange={setCameraId}>
            <SelectTrigger id="camera" aria-label="Camera">
              <SelectValue placeholder="Choose a camera…" />
            </SelectTrigger>
            <SelectContent>
              {cameraOptions.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/*
            ⚠️ Said before the operator picks a file, not after the upload is refused. The camera is
            what carries the zones and the rules, so the wrong one produces a confident wrong answer.
          */}
          <p className="mt-1 text-xs text-muted-foreground">
            The camera decides which zones and rules the footage is judged against.
          </p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="video/mp4"
          className="hidden"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        <Button
          onClick={() => fileRef.current?.click()}
          disabled={cameraId === '' || upload.isPending}
        >
          <Upload className="mr-2 h-4 w-4" />
          {upload.isPending ? stageLabel(stage) : 'Upload a recording'}
        </Button>

        {/* ⚠️ Only MP4 is decodable today; the picker says so rather than failing at confirm. */}
        <p className="text-xs text-muted-foreground">MP4 only, up to 2 GB and 4 hours.</p>

        {upload.isError ? (
          <p className="w-full text-sm text-destructive" role="alert">
            {upload.error instanceof Error ? upload.error.message : 'The upload failed.'}
          </p>
        ) : null}
      </div>

      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        isEmpty={(query.data?.items.length ?? 0) === 0}
        skeleton={<TableSkeleton rows={5} />}
        emptyState={
          <EmptyState
            icon={FileVideo}
            title="No investigations yet"
            description="Upload a recording above to analyse it with the same runtime, tracking and rules your live cameras use."
          />
        }
      >
        <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Recording</TableHead>
                  <TableHead>Camera</TableHead>
                  <TableHead>Footage from</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(query.data?.items ?? []).map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link className="font-medium hover:underline" to={`/investigations/${a.id}`}>
                        {a.label ?? a.asset?.originalName ?? a.id}
                      </Link>
                    </TableCell>
                    <TableCell>{a.cameraName ?? a.cameraId}</TableCell>
                    {/*
                      ⭐ Footage time, not upload time — the two are routinely weeks apart and a
                      column that showed the wrong one would misdate every incident on the page.
                    */}
                    <TableCell title={`source: ${a.footageStartSource}`}>
                      {formatTimestamp(a.footageStartedAt)}
                    </TableCell>
                    <TableCell>{a.sessionCount}</TableCell>
                    <TableCell>{a.state}</TableCell>
                    <TableCell>{timeAgo(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
        </Table>
      </QueryBoundary>
    </div>
  );
}

/** ⚠️ Names the stage. One "uploading…" across all three hides a rejected codec behind a spinner. */
function stageLabel(stage: string | null): string {
  if (stage === 'creating') return 'Preparing…';
  if (stage === 'uploading') return 'Uploading…';
  if (stage === 'confirming') return 'Checking the file…';
  return 'Working…';
}
