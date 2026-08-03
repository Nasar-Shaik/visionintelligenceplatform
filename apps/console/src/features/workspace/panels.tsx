/**
 * The fifteen panels.
 *
 * Every one of them renders through `QueryBoundary`, so every one has **all four states** —
 * unavailable, loading, empty, content (DESIGN_SYSTEM v2 §11). The panel body never decides whether
 * it is available: that comes from the registry, through `ResolvedPanel.unavailableReason`, and is
 * passed straight in. A panel cannot accidentally render Empty where the contract says Unavailable.
 */
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Link2, Sparkles } from 'lucide-react';
import type {
  Incident,
  IncidentTimeline,
  IncidentTimelineGap,
  WorkspacePanelId,
} from '@vip/contracts';
import { incidentsApi } from '@/lib/api/incidents';
import { eventsApi } from '@/lib/api/events';
import { queryKeys } from '@/lib/queryKeys';
import { EmptyState, QueryBoundary, SeverityBadge, Skeleton, TableSkeleton } from '@/ui';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/cn';
import { INCIDENT_STATUS } from '@/features/incidents/status';
import {
  AssignmentPanel as AssignmentPanelP53,
  CommentsPanel as CommentsPanelP53,
  EvidenceChainPanel,
  EvidencePanel as EvidencePanelP53,
  WorkspaceHealthPanel,
} from './panels-p53';

export interface PanelContext {
  incidentId: string | undefined;
  unavailableReason: string | undefined;
  onSelectIncident: (id: string) => void;
  filters: Record<string, unknown>;
  setFilters: (filters: Record<string, unknown>) => void;
}

const NO_INCIDENT = 'Select an incident from the queue to populate this panel.';

/** Shared: a panel that needs an incident but has none selected is *empty*, not unavailable. */
function useIncident(incidentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.incidents.detail(incidentId ?? ''),
    queryFn: () => incidentsApi.get(incidentId!),
    enabled: incidentId !== undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Left region
// ---------------------------------------------------------------------------------------------

function IncidentQueuePanel({ incidentId, onSelectIncident, filters }: PanelContext) {
  const query = useQuery({
    queryKey: queryKeys.incidents.list(filters),
    queryFn: () => incidentsApi.list({ limit: 50, ...filters }),
  });

  return (
    <QueryBoundary
      isLoading={query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={query.data?.items.length === 0}
      skeleton={<TableSkeleton rows={8} cols={2} />}
      emptyState={
        <EmptyState
          icon={AlertTriangle}
          title="Nothing in the queue"
          description="No incident matches the current filters."
        />
      }
    >
      <ul className="flex flex-col gap-1">
        {query.data?.items.map((incident) => (
          <li key={incident.id}>
            <button
              type="button"
              onClick={() => onSelectIncident(incident.id)}
              aria-current={incident.id === incidentId}
              className={cn(
                'focus-ring flex w-full flex-col gap-1 rounded border-l-2 px-2 py-1.5 text-left',
                incident.id === incidentId
                  ? 'border-l-brand bg-surface-3'
                  : 'border-l-transparent hover:bg-surface-2',
              )}
            >
              <span className="flex items-center gap-2">
                <SeverityBadge severity={incident.severity} />
                <span className="truncate text-xs text-text">{incident.title}</span>
              </span>
              <span className="flex items-center gap-2 text-2xs text-text-subtle">
                <span className="capitalize">{INCIDENT_STATUS[incident.status].label}</span>
                <span className="tabular">{timeAgo(incident.raisedAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </QueryBoundary>
  );
}

function FiltersPanel({ filters, setFilters }: PanelContext) {
  const statuses = ['raised', 'acknowledged', 'investigating', 'escalated', 'resolved', 'closed'];
  const active = filters['status'] as string | undefined;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs uppercase tracking-wide text-text-subtle">Status</p>
      <div className="flex flex-wrap gap-1">
        {statuses.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilters(active === status ? {} : { ...filters, status })}
            aria-pressed={active === status}
            className={cn(
              'focus-ring rounded-sm border px-2 py-0.5 text-2xs capitalize',
              active === status
                ? 'border-brand-border bg-brand-muted text-text'
                : 'border-border text-text-muted hover:text-text',
            )}
          >
            {status}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Centre region
// ---------------------------------------------------------------------------------------------
function PlaybackPanel({ unavailableReason }: PanelContext) {
  return (
    <QueryBoundary
      unavailableReason={
        unavailableReason ??
        'Playback contracts are frozen; no service resolves a playback session yet. This is not "no footage".'
      }
      isLoading={false}
      isError={false}
      skeleton={null}
    >
      {null}
    </QueryBoundary>
  );
}

/** How a timeline gap reads to an operator. Each reason is a different fact. */
function gapLabel(gap: IncidentTimelineGap): string {
  switch (gap.reason) {
    case 'forbidden':
      return `${gap.source}: you don’t have permission to read this context`;
    case 'unavailable':
      return `${gap.source}: could not be reached`;
    case 'truncated':
      return `${gap.source}: showing the most recent entries only`;
    case 'not-requested':
      return `${gap.source}: not requested`;
  }
}

function TimelinePanel({ incidentId, unavailableReason }: PanelContext) {
  const include = ['events', 'evidence', 'notify'] as const;
  const query = useQuery({
    queryKey: queryKeys.incidents.timeline(incidentId ?? '', include),
    queryFn: () => incidentsApi.timeline(incidentId!, include),
    enabled: incidentId !== undefined,
  });

  const timeline: IncidentTimeline | undefined = query.data;
  /* ⚠️ `not-requested` is filtered out: we asked for all three, so it cannot occur, and showing a
   * caveat for something nobody omitted is noise that trains operators to ignore the caveats. */
  const gaps = timeline?.gaps.filter((gap) => gap.reason !== 'not-requested') ?? [];

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined}
      skeleton={<TableSkeleton rows={4} cols={2} />}
      emptyState={
        <EmptyState icon={AlertTriangle} title="No incident selected" description={NO_INCIDENT} />
      }
    >
      <div className="flex flex-col gap-2">
        {gaps.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded border border-dashed border-border p-2">
            {gaps.map((gap) => (
              <li key={`${gap.source}-${gap.reason}`} className="text-2xs text-text-subtle">
                ⚠ {gapLabel(gap)}
              </li>
            ))}
          </ul>
        ) : null}
        <ol className="flex flex-col gap-1.5">
          {timeline?.entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2 text-xs">
              <span className="mt-1 size-1.5 flex-none rounded-full bg-border-strong" aria-hidden />
              <span className="flex-1">
                <span className="text-text">{entry.summary}</span>
                <span className="ml-2 text-2xs text-text-subtle">
                  {entry.source} · {timeAgo(entry.at)}
                  {entry.actor ? ` · ${entry.actor.kind}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------
// Right region
// ---------------------------------------------------------------------------------------------

function DetailsPanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useIncident(incidentId);
  const sla = useQuery({
    queryKey: queryKeys.incidents.sla(incidentId ?? ''),
    queryFn: () => incidentsApi.sla(incidentId!),
    enabled: incidentId !== undefined,
  });

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined}
      skeleton={<Skeleton className="h-24 w-full" />}
      emptyState={
        <EmptyState icon={AlertTriangle} title="No incident selected" description={NO_INCIDENT} />
      }
    >
      <dl className="flex flex-col gap-2 text-xs">
        <Row label="Title" value={query.data?.title} />
        <Row label="Status" value={query.data?.status} />
        <Row label="Severity" value={query.data?.severity} />
        <Row label="Rule" value={query.data?.source.ruleName} />
        <Row label="Camera" value={query.data?.triggeredBy.cameraId ?? '—'} />
        <Row label="Correlation" value={query.data?.correlationId} mono />
        {/*
         * ⚠️ `unknown` is rendered as "not measured", never as a pass. A dashboard that cannot tell
         * an unmeasured incident from a compliant one reports 98% compliance for a deployment that
         * never set an SLA.
         */}
        <Row
          label="SLA"
          value={
            sla.data === undefined
              ? '—'
              : sla.data.state === 'unknown'
                ? 'not measured'
                : sla.data.state
          }
        />
      </dl>
    </QueryBoundary>
  );
}

function RuleExplanationPanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useIncident(incidentId);
  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined}
      skeleton={<Skeleton className="h-16 w-full" />}
      emptyState={
        <EmptyState icon={AlertTriangle} title="No incident selected" description={NO_INCIDENT} />
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        <p className="text-text">
          <span className="text-text-muted">Rule </span>
          {query.data?.source.ruleName}
          <span className="text-text-subtle"> v{query.data?.source.ruleVersion}</span>
        </p>
        <p className="text-text-muted">
          Matched {query.data?.matchedCount} event
          {query.data?.matchedCount === 1 ? '' : 's'} · triggered by{' '}
          <span className="font-mono text-2xs">{query.data?.triggeredBy.eventType}</span>
        </p>
      </div>
    </QueryBoundary>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | undefined;
  mono?: boolean | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className={cn('truncate text-text', mono === true && 'font-mono text-2xs')}>
        {value ?? '—'}
      </dd>
    </div>
  );
}
function AttachmentsPanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useIncident(incidentId);
  const attachments = query.data?.notes.flatMap((note) => note.attachments) ?? [];
  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined || attachments.length === 0}
      skeleton={<Skeleton className="h-12 w-full" />}
      emptyState={
        <EmptyState
          icon={Link2}
          title={incidentId === undefined ? 'No incident selected' : 'Nothing attached'}
          description={
            incidentId === undefined ? NO_INCIDENT : 'No evidence or links reference this incident.'
          }
        />
      }
    >
      <ul className="flex flex-col gap-1 text-xs">
        {attachments.map((attachment) => (
          <li key={attachment.ref} className="flex items-center gap-2">
            <span className="rounded-sm border border-border px-1 text-2xs text-text-subtle">
              {attachment.kind}
            </span>
            <span className="truncate text-text">{attachment.label ?? attachment.ref}</span>
          </li>
        ))}
      </ul>
    </QueryBoundary>
  );
}

/**
 * ⚠️ The panel this whole mechanism exists for. It never renders "no recommendations": no model
 * emits an `IncidentRecommendation`, so the honest statement is that nothing has analysed the
 * incident. The reason comes from the registry, not from here.
 */
function AiRecommendationsPanel({ unavailableReason }: PanelContext) {
  return (
    <QueryBoundary
      unavailableReason={unavailableReason ?? 'No AI advisor is configured.'}
      isLoading={false}
      isError={false}
      skeleton={<Sparkles className="size-4" aria-hidden />}
    >
      {null}
    </QueryBoundary>
  );
}

// ---------------------------------------------------------------------------------------------
// Bottom region
// ---------------------------------------------------------------------------------------------

function RelatedEventsPanel({ incidentId, unavailableReason }: PanelContext) {
  const incident = useIncident(incidentId);
  const correlationId = incident.data?.correlationId;
  const query = useQuery({
    queryKey: queryKeys.events.list({ correlationId }),
    queryFn: () => eventsApi.list({ correlationId, limit: 25 }),
    enabled: correlationId !== undefined,
  });

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={correlationId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined || query.data?.events.length === 0}
      skeleton={<TableSkeleton rows={3} cols={3} />}
      emptyState={
        <EmptyState
          icon={AlertTriangle}
          title={incidentId === undefined ? 'No incident selected' : 'No related events'}
          description={
            incidentId === undefined
              ? NO_INCIDENT
              : 'Nothing else shares this incident’s correlation id.'
          }
        />
      }
    >
      <ul className="flex flex-col gap-1 text-xs">
        {query.data?.events.map((event) => (
          <li key={event.id} className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-2xs text-text">{event.type}</span>
            <span className="text-2xs text-text-subtle">{timeAgo(event.occurredAt)}</span>
          </li>
        ))}
      </ul>
    </QueryBoundary>
  );
}

function RelatedIncidentsPanel({ incidentId, unavailableReason, onSelectIncident }: PanelContext) {
  const incident = useIncident(incidentId);
  const correlationId = incident.data?.correlationId;
  const query = useQuery({
    queryKey: queryKeys.incidents.list({ correlationId }),
    queryFn: () => incidentsApi.list({ correlationId, limit: 25 }),
    enabled: correlationId !== undefined,
  });
  const others = query.data?.items.filter((item: Incident) => item.id !== incidentId) ?? [];

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={correlationId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined || others.length === 0}
      skeleton={<TableSkeleton rows={3} cols={2} />}
      emptyState={
        <EmptyState
          icon={AlertTriangle}
          title={incidentId === undefined ? 'No incident selected' : 'No related incidents'}
          description={
            incidentId === undefined ? NO_INCIDENT : 'No other incident shares this correlation id.'
          }
        />
      }
    >
      <ul className="flex flex-col gap-1 text-xs">
        {others.map((other) => (
          <li key={other.id}>
            <button
              type="button"
              onClick={() => onSelectIncident(other.id)}
              className="focus-ring w-full truncate rounded px-1 text-left text-text hover:bg-surface-2"
            >
              {other.title}
            </button>
          </li>
        ))}
      </ul>
    </QueryBoundary>
  );
}

function AuditTrailPanel({ incidentId, unavailableReason }: PanelContext) {
  const query = useQuery({
    queryKey: queryKeys.incidents.activity(incidentId ?? ''),
    queryFn: () => incidentsApi.activity(incidentId!),
    enabled: incidentId !== undefined,
  });

  return (
    <QueryBoundary
      unavailableReason={unavailableReason}
      isLoading={incidentId !== undefined && query.isPending}
      isError={query.isError}
      error={query.error}
      isEmpty={incidentId === undefined}
      skeleton={<TableSkeleton rows={4} cols={3} />}
      emptyState={
        <EmptyState icon={AlertTriangle} title="No incident selected" description={NO_INCIDENT} />
      }
    >
      <ul className="flex flex-col gap-1 text-xs">
        {query.data?.entries.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className="flex items-center justify-between gap-2">
            <span className="truncate text-text">{entry.summary}</span>
            <span className="whitespace-nowrap text-2xs text-text-subtle">
              {entry.actor?.kind ?? 'unknown'} · {timeAgo(entry.at)}
            </span>
          </li>
        ))}
      </ul>
    </QueryBoundary>
  );
}

/**
 * ⚠️ A panel with a frozen contract and no store. It is registered as `deferred` in the layout, so
 * the registry supplies the reason and this component never has to claim there are none.
 */
function SavedInvestigationsPanel({ unavailableReason }: PanelContext) {
  return (
    <QueryBoundary
      unavailableReason={unavailableReason ?? 'Saved investigations are not implemented yet.'}
      isLoading={false}
      isError={false}
      skeleton={null}
    >
      {null}
    </QueryBoundary>
  );
}

/**
 * The registry of panel bodies.
 *
 * ⚠️ Keyed by `WorkspacePanelId`, so **adding a panel to the contract without a body here is a
 * TypeScript error**, not a blank rectangle discovered by a customer.
 */
export const PANEL_BODIES: Record<WorkspacePanelId, (context: PanelContext) => ReactElement> = {
  'incident-queue': IncidentQueuePanel,
  'saved-investigations': SavedInvestigationsPanel,
  filters: FiltersPanel,
  'workspace-health': WorkspaceHealthPanel,
  // P-5.3 — the evidence panel now reads the Evidence context rather than deriving from notes.
  'evidence-viewer': EvidencePanelP53,
  'video-playback': PlaybackPanel,
  timeline: TimelinePanel,
  'incident-details': DetailsPanel,
  'rule-explanation': RuleExplanationPanel,
  'evidence-chain': EvidenceChainPanel,
  // P-5.3 — these two became writable.
  assignments: AssignmentPanelP53,
  comments: CommentsPanelP53,
  attachments: AttachmentsPanel,
  'ai-recommendations': AiRecommendationsPanel,
  'related-events': RelatedEventsPanel,
  'related-incidents': RelatedIncidentsPanel,
  'audit-trail': AuditTrailPanel,
};
