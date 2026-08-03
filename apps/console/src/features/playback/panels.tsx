/**
 * Workspace panels for playback (P-5.5) — the three that replace `not-built` placeholders:
 * the **player**, the **bookmarks** list, and the **evidence metadata** sheet.
 *
 * Every one renders the four states the design system requires — loading (shape-matched skeleton),
 * content, empty, and ⚠️ **unavailable**, which is the platform-specific one: "nothing is here" and
 * "we could not find out" must never look the same.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Evidence } from '@vip/contracts';
import { Bookmark, FileVideo, Fingerprint, ShieldCheck, Trash2 } from 'lucide-react';
import { evidenceApi } from '@/lib/api/evidence';
import { queryKeys } from '@/lib/queryKeys';
import { ApiRequestError } from '@/lib/api/http';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  QueryBoundary,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/ui';
import { timeAgo } from '@/lib/format';
import { useCan } from '@/app/hooks';
import { EvidencePlayer, PlayerSkeleton } from './EvidencePlayer';
import { PlaybackTimeline } from './PlaybackTimeline';
import { useBookmarkMutations, useBookmarks, usePlaybackSession } from './usePlayback';
import { useEvidenceSelection } from './selection';

interface PanelProps {
  incidentId: string | undefined;
  unavailableReason: string | undefined;
}

const NO_INCIDENT = 'Select an incident from the queue to populate this panel.';

/** The incident's evidence, shared by the player and the metadata panel. */
function useIncidentEvidence(incidentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.evidence.list({ incidentId }),
    queryFn: () => evidenceApi.list({ incidentId, limit: 50 }),
    enabled: incidentId !== undefined,
  });
}

/**
 * Turn an API failure into the sentence an operator can act on.
 *
 * ⚠️ A 409 from the playback route means the item exists and cannot be played — purged, expired,
 * still pending. That is **information**, and rendering it as a generic error would send somebody
 * to an engineer for a retention answer.
 */
function playbackUnavailableReason(error: unknown): string | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  if (error.status === 409) return error.message;
  if (error.status === 403) return 'You don’t have permission to open this evidence.';
  if (error.status === 404) return 'This evidence record no longer exists.';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------------------------

export function PlaybackPanel({ incidentId, unavailableReason }: PanelProps) {
  const evidence = useIncidentEvidence(incidentId);
  const { selectedEvidenceId, select, seekTo, requestSeek } = useEvidenceSelection();
  const [position, setPosition] = useState(0);
  const bookmarks = useBookmarks(incidentId);
  const { add } = useBookmarkMutations(incidentId);
  const can = useCan();
  const canComment = can('incident:comment');

  const items = useMemo(() => evidence.data?.items ?? [], [evidence.data]);
  /* Default to the first available item, so opening the workspace shows footage rather than a prompt. */
  const active = useMemo(
    () =>
      items.find((item) => item.id === selectedEvidenceId) ??
      items.find((i) => i.status === 'available'),
    [items, selectedEvidenceId],
  );

  useEffect(() => {
    if (active !== undefined && selectedEvidenceId !== active.id) select(active.id);
  }, [active, selectedEvidenceId, select]);

  const session = usePlaybackSession(
    active?.id,
    incidentId !== undefined ? `investigating incident ${incidentId}` : undefined,
  );

  const reason =
    unavailableReason ?? (session.isError ? playbackUnavailableReason(session.error) : undefined);

  return (
    <QueryBoundary
      unavailableReason={reason}
      /*
       * ⚠️ `active !== undefined` matters. A **disabled** query reports `isPending` forever in
       * TanStack Query, so gating the skeleton on `session.isPending` alone leaves an incident with
       * no evidence showing a loading shimmer that never resolves — the empty state would never be
       * reached. Loading means "a request is in flight", not "no data yet".
       */
      isLoading={
        incidentId !== undefined &&
        (evidence.isPending || (active !== undefined && session.isPending))
      }
      isError={session.isError && reason === undefined}
      error={session.error}
      isEmpty={incidentId === undefined || items.length === 0}
      skeleton={<PlayerSkeleton />}
      emptyState={
        <EmptyState
          icon={FileVideo}
          title={incidentId === undefined ? 'No incident selected' : 'No recording to play'}
          description={
            incidentId === undefined
              ? NO_INCIDENT
              : 'No evidence was captured for this incident, so there is nothing to play. Automatic capture is pending the media frame source.'
          }
        />
      }
    >
      {session.data !== undefined && active !== undefined ? (
        <div className="flex flex-col gap-3">
          {/* Source switcher — only when there is a choice to make. */}
          {items.length > 1 ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Evidence items">
              {items.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="sm"
                  variant={item.id === active.id ? 'secondary' : 'ghost'}
                  aria-pressed={item.id === active.id}
                  disabled={item.status !== 'available'}
                  onClick={() => select(item.id)}
                  className="h-7 text-xs"
                >
                  {item.metadata.label ?? item.kind}
                </Button>
              ))}
            </div>
          ) : null}

          <EvidencePlayer
            session={session.data}
            seekToSeconds={seekTo}
            onPositionChange={setPosition}
            {...(canComment
              ? {
                  onBookmark: (offsetSeconds: number) => {
                    const at = new Date(
                      Date.parse(session.data.startedAt) + offsetSeconds * 1000,
                    ).toISOString();
                    add.mutate({
                      source: { kind: 'evidence', id: active.id },
                      at,
                      label: `Moment at ${new Date(at).toLocaleTimeString()}`,
                      visibility: 'private',
                    });
                  },
                }
              : {})}
          />

          <PlaybackTimeline
            session={session.data}
            positionSeconds={position}
            bookmarks={bookmarks.data?.items ?? []}
            onSeek={requestSeek}
          />

          {/*
            ⚠️ Bookmarks live **inside** the player panel rather than in one of their own. The
            frozen registry has seventeen panel ids and none of them is `bookmarks`; adding one
            would be a contract change, and the freeze is explicit that only a real implementation
            problem justifies that. This is not one — a bookmark list belongs beside the transport
            it is navigating anyway, which is where an operator looks for it.
          */}
          <BookmarkStrip incidentId={incidentId} />
        </div>
      ) : null}
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------------------------

export function BookmarksPanel({ incidentId, unavailableReason }: PanelProps) {
  const bookmarks = useBookmarks(incidentId);
  const { add, remove } = useBookmarkMutations(incidentId);
  const { selectedEvidenceId, requestSeek } = useEvidenceSelection();
  const session = usePlaybackSession(selectedEvidenceId);
  const can = useCan();
  const canComment = can('incident:comment');
  const [label, setLabel] = useState('');

  /*
   * ⚠️ A 409 here means the deployment has no bookmark store — a *configuration* answer, rendered
   * as unavailable with the server's own sentence rather than as an error nobody can action.
   */
  const reason =
    unavailableReason ??
    (bookmarks.error instanceof ApiRequestError && bookmarks.error.status === 409
      ? bookmarks.error.message
      : undefined);

  return (
    <QueryBoundary
      unavailableReason={reason}
      isLoading={incidentId !== undefined && bookmarks.isPending}
      isError={bookmarks.isError && reason === undefined}
      error={bookmarks.error}
      isEmpty={incidentId === undefined || bookmarks.data?.items.length === 0}
      skeleton={<Skeleton className="h-24 w-full" />}
      emptyState={
        <EmptyState
          icon={Bookmark}
          title={incidentId === undefined ? 'No incident selected' : 'No bookmarks yet'}
          description={
            incidentId === undefined
              ? NO_INCIDENT
              : 'Save a moment from the player to mark it here. Bookmarks are private to you unless you share them.'
          }
        />
      }
    >
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1">
          {bookmarks.data?.items.map((bookmark) => (
            <li
              key={bookmark.id}
              className="group flex items-center gap-2 rounded border border-border bg-surface-2 px-2 py-1.5"
            >
              <Bookmark className="size-3 shrink-0 text-warning" aria-hidden />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-xs text-text hover:underline"
                onClick={() => {
                  if (session.data === undefined) return;
                  requestSeek(
                    (Date.parse(bookmark.at) - Date.parse(session.data.startedAt)) / 1000,
                  );
                }}
              >
                {bookmark.label}
              </button>
              <span className="shrink-0 text-2xs tabular-nums text-text-subtle">
                {new Date(bookmark.at).toLocaleTimeString()}
              </span>
              {bookmark.visibility === 'tenant' ? (
                <Badge className="shrink-0 text-2xs">Shared</Badge>
              ) : null}
              {canComment ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${bookmark.label}`}
                  className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => remove.mutate(bookmark.id)}
                >
                  <Trash2 className="size-3" aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>

        {canComment && session.data !== undefined ? (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (label.trim() === '' || selectedEvidenceId === undefined) return;
              add.mutate(
                {
                  source: { kind: 'evidence', id: selectedEvidenceId },
                  at: session.data!.startedAt,
                  label: label.trim(),
                  visibility: 'private',
                },
                /* ⚠️ Clears only on success — a failed save must not lose what they typed. */
                { onSuccess: () => setLabel('') },
              );
            }}
          >
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Label this moment…"
              aria-label="Bookmark label"
              className="h-7 text-xs"
            />
            <Button type="submit" size="sm" className="h-7" disabled={label.trim() === ''}>
              Save
            </Button>
          </form>
        ) : null}
      </div>
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------
// Evidence metadata
// ---------------------------------------------------------------------------------------------

function MetadataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-xs text-text">{children}</dd>
    </div>
  );
}

export function EvidenceMetadataPanel({ incidentId, unavailableReason }: PanelProps) {
  const evidence = useIncidentEvidence(incidentId);
  const { selectedEvidenceId } = useEvidenceSelection();
  const item: Evidence | undefined = useMemo(
    () =>
      evidence.data?.items.find((candidate) => candidate.id === selectedEvidenceId) ??
      evidence.data?.items[0],
    [evidence.data, selectedEvidenceId],
  );

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && evidence.isPending}
      isError={evidence.isError}
      error={evidence.error}
      isEmpty={incidentId === undefined || item === undefined}
      skeleton={<Skeleton className="h-32 w-full" />}
      emptyState={
        <EmptyState
          icon={Fingerprint}
          title={incidentId === undefined ? 'No incident selected' : 'No evidence to describe'}
          description={incidentId === undefined ? NO_INCIDENT : 'Nothing was captured to describe.'}
        />
      }
    >
      {item !== undefined ? (
        <dl className="divide-y divide-border">
          <MetadataRow label="Kind">{item.kind}</MetadataRow>
          <MetadataRow label="Captured">
            <time dateTime={item.capturedAt}>{new Date(item.capturedAt).toLocaleString()}</time>
          </MetadataRow>
          {item.interval ? (
            <MetadataRow label="Duration">{item.interval.durationSeconds}s</MetadataRow>
          ) : null}
          <MetadataRow label="Format">
            <span className="font-mono">{item.media.contentType}</span>
            {item.media.codec ? <span className="font-mono"> · {item.media.codec}</span> : null}
          </MetadataRow>
          <MetadataRow label="Size">
            {(item.media.integrity.sizeBytes / 1024).toFixed(0)} kB
          </MetadataRow>
          <MetadataRow label="Status">{item.status}</MetadataRow>
          {item.source.cameraId ? (
            <MetadataRow label="Camera">{item.source.cameraId}</MetadataRow>
          ) : null}
          <MetadataRow label="Retention">
            {item.retention.legalHold
              ? 'Legal hold'
              : (item.retention.retainUntil ?? 'Retained indefinitely')}
          </MetadataRow>
          <div className="pt-2">
            <dt className="mb-1 text-2xs uppercase tracking-wide text-text-subtle">Integrity</dt>
            <dd>
              {/*
                ⚠️ Displayed, **never recomputed here**. A viewer that hashed the bytes client-side
                would be a second implementation of the platform's tamper-evidence, and any
                divergence between the two would be indistinguishable from tampering.
              */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 font-mono text-2xs text-text-muted">
                    <ShieldCheck className="size-3 text-status-ok" aria-hidden />
                    <span className="truncate">
                      {item.media.integrity.algorithm}:{item.media.integrity.hash.slice(0, 24)}…
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-64 break-all font-mono text-2xs">
                    {item.media.integrity.hash}
                  </p>
                  <p className="mt-1 text-2xs text-text-subtle">
                    Recorded at registration. The console displays it; it never recomputes it.
                  </p>
                </TooltipContent>
              </Tooltip>
            </dd>
          </div>
          {item.metadata.tags.length > 0 ? (
            <div className="pt-2">
              <dt className="mb-1 text-2xs uppercase tracking-wide text-text-subtle">Tags</dt>
              <dd className="flex flex-wrap gap-1">
                {item.metadata.tags.map((tag) => (
                  <Badge key={tag} className="text-2xs">
                    {tag}
                  </Badge>
                ))}
              </dd>
            </div>
          ) : null}
          <div className="pt-2 text-2xs text-text-subtle">Registered {timeAgo(item.createdAt)}</div>
        </dl>
      ) : null}
    </QueryBoundary>
  );
}

/**
 * The bookmark list as it appears under the player.
 *
 * ⚠️ Renders its own four states inline rather than through `QueryBoundary`, because it is a
 * *section* of a panel and not a panel: replacing the whole player with a bookmark skeleton while
 * bookmarks load would be a worse answer than showing the footage and filling the strip in.
 */
function BookmarkStrip({ incidentId }: { incidentId: string | undefined }) {
  const bookmarks = useBookmarks(incidentId);
  const { add, remove } = useBookmarkMutations(incidentId);
  const { selectedEvidenceId, requestSeek } = useEvidenceSelection();
  const session = usePlaybackSession(selectedEvidenceId);
  const can = useCan();
  const canComment = can('incident:comment');
  const [label, setLabel] = useState('');

  const unavailable =
    bookmarks.error instanceof ApiRequestError && bookmarks.error.status === 409
      ? bookmarks.error.message
      : undefined;

  return (
    <section aria-label="Bookmarks" className="rounded-md border border-border bg-surface-2 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <Bookmark className="size-3 text-warning" aria-hidden />
        <h3 className="text-2xs font-medium uppercase tracking-wide text-text-muted">Bookmarks</h3>
        {bookmarks.data ? (
          <span className="text-2xs tabular-nums text-text-subtle">
            {bookmarks.data.items.length}
          </span>
        ) : null}
      </div>

      {unavailable !== undefined ? (
        /* ⚠️ Unavailable, not empty. See `WorkspaceDependencyState` for why they must differ. */
        <p className="text-2xs text-text-subtle" data-testid="bookmarks-unavailable">
          {unavailable}
        </p>
      ) : bookmarks.isPending ? (
        <Skeleton className="h-6 w-full" />
      ) : bookmarks.data?.items.length === 0 ? (
        <p className="text-2xs text-text-subtle">
          No bookmarks yet — save a moment from the player to mark it here.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {bookmarks.data?.items.map((bookmark) => (
            <li key={bookmark.id} className="group flex items-center gap-1">
              <button
                type="button"
                data-testid="bookmark-jump"
                className="rounded border border-border bg-surface-3 px-1.5 py-0.5 text-2xs text-text hover:border-brand hover:text-brand"
                onClick={() => {
                  if (session.data === undefined) return;
                  requestSeek(
                    (Date.parse(bookmark.at) - Date.parse(session.data.startedAt)) / 1000,
                  );
                }}
              >
                {bookmark.label}
              </button>
              {canComment ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${bookmark.label}`}
                  className="size-5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => remove.mutate(bookmark.id)}
                >
                  <Trash2 className="size-3" aria-hidden />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canComment && session.data !== undefined && unavailable === undefined ? (
        <form
          className="mt-1.5 flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim() === '' || selectedEvidenceId === undefined) return;
            add.mutate(
              {
                source: { kind: 'evidence', id: selectedEvidenceId },
                at: session.data!.startedAt,
                label: label.trim(),
                visibility: 'private',
              },
              /* ⚠️ Clears only on success — a failed save must not lose what they typed. */
              { onSuccess: () => setLabel('') },
            );
          }}
        >
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Label this moment…"
            aria-label="Bookmark label"
            className="h-6 text-2xs"
          />
          <Button type="submit" size="sm" className="h-6 text-2xs" disabled={label.trim() === ''}>
            Save
          </Button>
        </form>
      ) : null}
    </section>
  );
}
