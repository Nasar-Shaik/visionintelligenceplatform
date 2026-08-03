/**
 * P-5.3 panel bodies: evidence (real, against the Evidence context), the evidence chain, workspace
 * health, and the collaboration controls on comments and assignment.
 *
 * Kept beside `panels.tsx` rather than inside it because that file is already the registry; a
 * lookup table and four hundred lines of new components in one module is how a registry stops being
 * readable as a registry.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  CircleSlash,
  FileVideo,
  Link2,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react';
import type { EvidenceChainLink, IncidentStatus, WorkspaceDependencyHealth } from '@vip/contracts';
import { DEPENDENCY_STATE_RANK } from '@vip/contracts';
import { incidentsApi } from '@/lib/api/incidents';
import { evidenceApi } from '@/lib/api/evidence';
import { queryKeys } from '@/lib/queryKeys';
import { usePermission } from '@/app/hooks';
import { Button, EmptyState, QueryBoundary, Skeleton, TableSkeleton, Textarea } from '@/ui';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { PanelContext } from './panels';
import { deriveWorkspaceHealth } from './health';
import {
  allowedTransitions,
  TRANSITION_PERMISSION,
  useCollaboration,
  type WorkspaceTransition,
} from './useCollaboration';

const NO_INCIDENT = 'Select an incident from the queue to populate this panel.';

// ---------------------------------------------------------------------------------------------
// Evidence — the real integration (P-5.3)
// ---------------------------------------------------------------------------------------------

/**
 * ⚠️ Queried by `incidentId`, not by correlation. Both are indexed, but the correlation spine can
 * carry a **sibling incident's** evidence, and showing another incident's evidence as this one's is
 * wrong in the direction an investigator acts on.
 */
export function EvidencePanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useQuery({
    queryKey: queryKeys.evidence.list({ incidentId }),
    queryFn: () => evidenceApi.list({ incidentId, limit: 50 }),
    enabled: incidentId !== undefined,
  });

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined || query.data?.items.length === 0}
      skeleton={<Skeleton className="h-40 w-full" />}
      emptyState={
        <EmptyState
          icon={FileVideo}
          title={incidentId === undefined ? 'No incident selected' : 'No evidence captured'}
          description={
            incidentId === undefined
              ? NO_INCIDENT
              : 'Nothing was captured for this incident. Automatic capture is pending the media frame source.'
          }
        />
      }
    >
      <ul className="flex flex-col gap-2">
        {query.data?.items.map((item) => (
          <li key={item.id} className="rounded border border-border bg-surface-2 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-text">
                {item.metadata.label ?? `${item.kind} · ${item.media.contentType}`}
              </span>
              <span className="text-2xs uppercase text-text-subtle">{item.status}</span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-2xs text-text-subtle">
              <span className="tabular">{timeAgo(item.capturedAt)}</span>
              {/*
                ⚠️ The integrity hash is **displayed, never recomputed here**. A viewer that hashed
                the bytes client-side would be a second implementation of the platform's
                tamper-evidence, and any divergence between the two would be indistinguishable from
                tampering.
              */}
              {item.media.integrity.hash !== '' ? (
                <span
                  className="flex items-center gap-1 font-mono"
                  title={item.media.integrity.hash}
                >
                  <ShieldCheck className="size-3" aria-hidden />
                  {item.media.integrity.hash.slice(0, 12)}
                </span>
              ) : (
                <span className="italic">integrity not yet recorded</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------
// Evidence chain (rec 7)
// ---------------------------------------------------------------------------------------------

/** ⚠️ Each break reads differently, because each means a different thing to do about it. */
function breakLabel(link: EvidenceChainLink): string {
  switch (link.brokenBecause) {
    case 'retained-elsewhere':
      return 'aged out of retention';
    case 'archived':
      return 'archived';
    case 'never-produced':
      return 'never produced';
    case 'not-built':
      return 'not built yet';
    case 'forbidden':
      return 'you don’t have permission';
    case 'unavailable':
      return 'could not be reached';
    default:
      return 'unresolved';
  }
}

export function EvidenceChainPanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useQuery({
    queryKey: queryKeys.incidents.chain(incidentId ?? ''),
    queryFn: () => incidentsApi.chain(incidentId!),
    enabled: incidentId !== undefined,
  });

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined}
      skeleton={<TableSkeleton rows={6} cols={2} />}
      emptyState={
        <EmptyState icon={Link2} title="No incident selected" description={NO_INCIDENT} />
      }
    >
      <ol className="flex flex-col">
        {query.data?.links.map((link, index) => (
          <li key={link.stage} className="flex items-start gap-2">
            <div className="flex flex-col items-center self-stretch">
              <span
                className={cn(
                  'mt-1 size-2 flex-none rounded-full',
                  link.resolved ? 'bg-success' : 'bg-border-strong',
                )}
                aria-hidden
              />
              {index < (query.data?.links.length ?? 0) - 1 ? (
                <span
                  className={cn(
                    'w-px flex-1',
                    link.resolved ? 'bg-border-strong' : 'bg-transparent',
                  )}
                  /* ⚠️ A broken link draws no connector — the gap is visible, not implied. */
                  aria-hidden
                />
              ) : null}
            </div>
            <div className="flex-1 pb-3">
              <p className="text-xs capitalize text-text">{link.stage.replace('-', ' ')}</p>
              {link.resolved ? (
                <p className="truncate text-2xs text-text-subtle">
                  {link.label ?? link.ref}
                  {link.count !== undefined ? ` · ${link.count}` : ''}
                </p>
              ) : (
                <p className="text-2xs text-text-subtle">
                  <span className="text-warning">{breakLabel(link)}</span> — {link.detail}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------
// Workspace health (rec 8)
// ---------------------------------------------------------------------------------------------

const STATE_TONE: Record<string, string> = {
  unreachable: 'text-critical',
  degraded: 'text-warning',
  forbidden: 'text-warning',
  'not-configured': 'text-text-muted',
  'not-built': 'text-text-subtle',
  unknown: 'text-text-subtle',
  ready: 'text-success',
};

export function WorkspaceHealthPanel({ incidentId }: PanelContext) {
  const include = ['events', 'evidence', 'notify'] as const;
  /*
   * ⚠️ **Reads the timeline's cache; it does not fetch.** `enabled: false` means this panel adds
   * **zero** upstream calls — it projects over what the timeline panel already fetched. A health
   * surface that probed seven services on every workspace load would be the exact fan-out the
   * platform's call-budget discipline exists to prevent.
   */
  const timeline = useQuery({
    queryKey: queryKeys.incidents.timeline(incidentId ?? '', include),
    queryFn: () => incidentsApi.timeline(incidentId!, include),
    enabled: false,
  });

  const health = deriveWorkspaceHealth({
    tenantId: 'current',
    timeline: timeline.data,
    now: new Date(),
  });

  const sorted = [...health.dependencies].sort(
    (a, b) => DEPENDENCY_STATE_RANK[a.state] - DEPENDENCY_STATE_RANK[b.state],
  );

  return (
    <ul className="flex flex-col gap-1.5">
      {sorted.map((entry: WorkspaceDependencyHealth) => (
        <li key={entry.dependency} className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            {entry.state === 'ready' ? (
              <CheckCircle2 className="size-3 flex-none text-success" aria-hidden />
            ) : (
              <CircleSlash
                className={cn('size-3 flex-none', STATE_TONE[entry.state])}
                aria-hidden
              />
            )}
            <span className="text-xs capitalize text-text">{entry.dependency}</span>
            {/* ⚠️ Never colour alone — the state is spelled out (DESIGN_SYSTEM §12 rule 1). */}
            <span className={cn('ml-auto text-2xs', STATE_TONE[entry.state])}>
              {entry.state.replace('-', ' ')}
            </span>
          </div>
          {entry.detail !== undefined ? (
            <p className="pl-5 text-2xs text-text-subtle">{entry.detail}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Collaboration (P-5.3) — comments and assignment become writable
// ---------------------------------------------------------------------------------------------

export function CommentsPanel({ incidentId, unavailableReason }: PanelContext) {
  const [body, setBody] = useState('');
  const canComment = usePermission('incident:comment');
  const { addNote } = useCollaboration(incidentId);

  const query = useQuery({
    queryKey: queryKeys.incidents.detail(incidentId ?? ''),
    queryFn: () => incidentsApi.get(incidentId!),
    enabled: incidentId !== undefined,
  });
  const notes = query.data?.notes ?? [];
  /* ⚠️ A closed incident is sealed — the composer is absent, not disabled (CONSTRAINTS §57). */
  const sealed = query.data?.status === 'closed';

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      skeleton={<Skeleton className="h-16 w-full" />}
    >
      <div className="flex flex-col gap-2">
        {notes.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={incidentId === undefined ? 'No incident selected' : 'No comments'}
            description={
              incidentId === undefined
                ? NO_INCIDENT
                : 'Nobody has written anything on this incident.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="rounded border border-border bg-surface-2 p-2">
                <p className="whitespace-pre-wrap text-xs text-text">{note.body}</p>
                <p className="mt-1 text-2xs text-text-subtle">
                  {/* ⚠️ A pre-P-5.1 record cannot be honestly attributed — it says so. */}
                  {note.actor?.kind === 'unknown' ? 'unattributed' : (note.by ?? 'unknown')} ·{' '}
                  {timeAgo(note.at)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {incidentId !== undefined && canComment && !sealed ? (
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (body.trim() === '') return;
              addNote.mutate(
                { body: body.trim(), attachments: [] },
                /* ⚠️ Cleared only on success — a 409 must not eat what the operator wrote. */
                { onSuccess: () => setBody('') },
              );
            }}
          >
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Add a comment…"
              rows={2}
              aria-label="Add a comment"
            />
            <Button type="submit" size="sm" disabled={body.trim() === '' || addNote.isPending}>
              {addNote.isPending ? 'Adding…' : 'Comment'}
            </Button>
          </form>
        ) : null}
        {sealed ? (
          <p className="text-2xs text-text-subtle">
            This incident is closed. Nothing further can be appended — that is what &ldquo;retained
            for audit&rdquo; means.
          </p>
        ) : null}
      </div>
    </QueryBoundary>
  );
}

const TRANSITION_LABEL: Record<WorkspaceTransition, string> = {
  acknowledge: 'Acknowledge',
  investigate: 'Investigate',
  escalate: 'Escalate',
  resolve: 'Resolve',
  close: 'Close',
};

export function AssignmentPanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useQuery({
    queryKey: queryKeys.incidents.detail(incidentId ?? ''),
    queryFn: () => incidentsApi.get(incidentId!),
    enabled: incidentId !== undefined,
  });
  const { assign, transition } = useCollaboration(incidentId);
  const canAssign = usePermission('incident:assign');
  const status: IncidentStatus | undefined = query.data?.status;

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined}
      skeleton={<Skeleton className="h-12 w-full" />}
      emptyState={
        <EmptyState icon={Activity} title="No incident selected" description={NO_INCIDENT} />
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-text-subtle">Owner</span>
          <span className="text-text">{query.data?.assignee ?? 'unassigned'}</span>
        </div>

        {canAssign && status !== 'closed' ? (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="secondary"
              disabled={assign.isPending}
              onClick={() => assign.mutate({ assignee: 'me' })}
            >
              Assign to me
            </Button>
            {query.data?.assignee !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={assign.isPending}
                /* Un-assigning is a real operator action, expressed as an explicit null. */
                onClick={() => assign.mutate({ assignee: null })}
              >
                Unassign
              </Button>
            ) : null}
          </div>
        ) : null}

        {/*
          ⚠️ Only transitions the server would accept from this status are rendered, and only those
          the principal holds. A control the server refuses teaches an operator the product is
          unreliable — and a closed incident offers none at all.
        */}
        <TransitionControls
          status={status}
          pending={transition.isPending}
          onRun={(action) => transition.mutate({ action })}
        />
      </div>
    </QueryBoundary>
  );
}

function TransitionControls({
  status,
  pending,
  onRun,
}: {
  status: IncidentStatus | undefined;
  pending: boolean;
  onRun: (action: WorkspaceTransition) => void;
}) {
  const canAck = usePermission(TRANSITION_PERMISSION.acknowledge);
  const canInvestigate = usePermission(TRANSITION_PERMISSION.investigate);
  const canEscalate = usePermission(TRANSITION_PERMISSION.escalate);
  const canResolve = usePermission(TRANSITION_PERMISSION.resolve);
  const canClose = usePermission(TRANSITION_PERMISSION.close);

  if (status === undefined) return null;
  const held: Record<WorkspaceTransition, boolean> = {
    acknowledge: canAck,
    investigate: canInvestigate,
    escalate: canEscalate,
    resolve: canResolve,
    close: canClose,
  };
  const actions = allowedTransitions(status).filter((action) => held[action]);
  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {actions.map((action) => (
        <Button
          key={action}
          size="sm"
          variant={action === 'escalate' ? 'destructive' : 'secondary'}
          disabled={pending}
          onClick={() => onRun(action)}
        >
          {TRANSITION_LABEL[action]}
        </Button>
      ))}
    </div>
  );
}
