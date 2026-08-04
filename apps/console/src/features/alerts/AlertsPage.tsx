import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, Inbox, RotateCw, TriangleAlert, X } from 'lucide-react';
import { usePermission } from '@/app/hooks';
import { formatTimestamp, shortId, timeAgo } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FilterBar,
  PageHeader,
  QueryBoundary,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SeverityBadge,
  TableSkeleton,
  toast,
} from '@/ui';
import { CHANNEL_LABEL, DELIVERY_STATUS } from './delivery';
import { ackableDeliveries, groupIntoInbox, inboxCounts, type InboxEntry } from './inbox';
import { useAckNotification, useNotificationsInfinite } from './useNotifications';

/**
 * The operator's inbox (P-6.5) — **not a notification list.**
 *
 * ### What changed, and why it is not cosmetic
 *
 * This screen was a **delivery log**: one row per channel per incident, answering the question an
 * engineer asks — *did the webhook POST succeed?* An operator opening it asks a different question:
 * *what needs me?* One incident that fanned out to three channels is one thing to deal with, and a
 * screen that lists it three times teaches people to skim the screen that exists to stop them
 * skimming.
 *
 * So the log is grouped by incident, triaged by whether anybody has taken it, and every entry links
 * to the incident it belongs to. ⚠️ **The per-channel records are not deleted** — they expand
 * underneath, because "the webhook to the customer's SOC never fired" is still something somebody
 * has to know.
 *
 * ### ⚠️ Two questions, deliberately not collapsed
 *
 * - **Has anyone dealt with this?** — the queue, and the number on the bell.
 * - **Did every channel deliver?** — shown beside it, and **not** cleared by acknowledging. An
 *   operator taking an incident says nothing about whether the customer's own system was told.
 *
 * Merging them would either hide delivery failures behind an acknowledgement or leave handled
 * incidents in the queue because a webhook is misconfigured. Both produce a queue nobody trusts.
 *
 * ### Live without polling harder
 *
 * The shell's SSE connection already invalidates this cache on the `alerts` topic, so a new alert
 * arrives without waiting for the poll. The 20-second interval underneath it is the fallback for a
 * dropped stream, not the primary path — ⚠️ one source of truth, not two.
 */
const POLL = { refetchInterval: 20_000 };

type Triage = 'attention' | 'acknowledged' | 'all';

const TRIAGE_LABEL: Record<Triage, string> = {
  attention: 'Needs attention',
  acknowledged: 'Acknowledged',
  all: 'Everything',
};

export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const triage = (params.get('triage') as Triage | null) ?? 'attention';
  const incidentId = params.get('incidentId');

  const canAck = usePermission('notification:ack');
  const ack = useAckNotification();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value !== null && value !== 'attention') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  /*
   * ⚠️ The triage filter is applied **server-side**, through `acknowledged`. Fetching everything and
   * filtering here would answer correctly for the rows that happen to be loaded and silently wrongly
   * for the rest — which is exactly how an unread count becomes a lie.
   */
  const query = useNotificationsInfinite(
    {
      limit: 50,
      ...(triage === 'attention' ? { acknowledged: false } : {}),
      ...(triage === 'acknowledged' ? { acknowledged: true } : {}),
      ...(incidentId ? { incidentId } : {}),
    },
    POLL,
  );

  const deliveries = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const entries = useMemo(() => groupIntoInbox(deliveries), [deliveries]);
  const counts = useMemo(() => inboxCounts(entries), [entries]);

  /**
   * Acknowledge every delivery on this entry that a recipient can acknowledge.
   *
   * ⚠️ Scoped to **one incident**, never "acknowledge all". Clearing a queue of twenty alerts an
   * operator has not read is the single fastest way to make an inbox worthless, and the control that
   * offers it is the one that gets used at the end of a shift.
   */
  const acknowledge = (entry: InboxEntry) => {
    const targets = ackableDeliveries(entry);
    if (targets.length === 0) return;
    setAcking(entry.incidentId);
    void Promise.allSettled(targets.map((n) => ack.mutateAsync({ id: n.id, input: {} })))
      .then((results) => {
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed === 0) {
          toast.success(
            targets.length === 1
              ? 'Alert acknowledged'
              : `Acknowledged ${targets.length} deliveries for this incident`,
          );
        } else {
          /* ⚠️ Partial failure is reported as partial, never rounded up to success. */
          toast.error(`${failed} of ${targets.length} could not be acknowledged`);
        }
      })
      .finally(() => setAcking(null));
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        title="Inbox"
        description="Every incident the platform tried to tell someone about — and whether anyone has taken it."
      />

      <FilterBar>
        <Select value={triage} onValueChange={(v) => setParam('triage', v)}>
          <SelectTrigger className="w-48" id="triage" aria-label="Triage filter">
            <SelectValue placeholder="Needs attention" />
          </SelectTrigger>
          <SelectContent>
            {(['attention', 'acknowledged', 'all'] as Triage[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TRIAGE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {incidentId ? (
          <Button variant="outline" size="sm" onClick={() => setParam('incidentId', null)}>
            <X />
            Incident {shortId(incidentId, 8)}
          </Button>
        ) : null}
        <span className="ml-auto text-xs tabular-nums text-text-subtle">
          {entries.length === 0
            ? null
            : `${entries.length} incident${entries.length === 1 ? '' : 's'}${
                query.hasNextPage ? '+' : ''
              }`}
        </span>
      </FilterBar>

      {/*
       * ⚠️ Delivery failures get their own banner, above the queue and outside it. They are not
       * "one of the alerts" — they are the alerts that never arrived, and they are an
       * administrator's problem rather than an operator's.
       */}
      {counts.withFailedDelivery > 0 ? (
        <Alert variant="warning" className="mb-4">
          <span className="font-medium">
            {counts.withFailedDelivery === 1
              ? '1 incident had a delivery that never arrived.'
              : `${counts.withFailedDelivery} incidents had a delivery that never arrived.`}
          </span>{' '}
          Acknowledging an alert does not fix this — the channel itself needs attention.
        </Alert>
      ) : null}

      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        isEmpty={entries.length === 0}
        skeleton={<TableSkeleton rows={6} cols={4} />}
        emptyState={
          <EmptyState
            icon={triage === 'attention' ? Inbox : Bell}
            title={triage === 'attention' ? 'Nothing is waiting' : 'No alerts'}
            description={
              triage === 'attention'
                ? 'Every alert the platform has raised has been acknowledged. New ones appear here as they arrive.'
                : incidentId
                  ? 'No alerts match these filters.'
                  : 'Alerts appear here when an incident is raised.'
            }
          />
        }
      >
        <ul className="divide-y divide-border rounded-lg border border-border">
          {entries.map((entry) => (
            <InboxRow
              key={entry.incidentId}
              entry={entry}
              canAck={canAck}
              busy={acking === entry.incidentId}
              expanded={expanded === entry.incidentId}
              onToggle={() => setExpanded(expanded === entry.incidentId ? null : entry.incidentId)}
              onAcknowledge={() => acknowledge(entry)}
            />
          ))}
        </ul>

        {query.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function InboxRow({
  entry,
  canAck,
  busy,
  expanded,
  onToggle,
  onAcknowledge,
}: {
  entry: InboxEntry;
  canAck: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
}) {
  const ackable = ackableDeliveries(entry).length;
  return (
    <li className={cn('px-4 py-3', !entry.acknowledged && 'bg-surface-2/40')}>
      <div className="flex flex-wrap items-start gap-3">
        <SeverityBadge severity={entry.severity} dot />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/*
             * ⚠️ Unacknowledged entries are bold. An inbox where everything looks the same is a
             * list, and the whole point of this screen is that the eye lands on what is waiting.
             */}
            <p
              className={cn(
                'truncate text-sm text-foreground',
                entry.acknowledged ? 'font-normal' : 'font-semibold',
              )}
            >
              {entry.title}
            </p>
            {entry.failed.length > 0 ? (
              <span className="inline-flex items-center gap-1 text-2xs text-warning">
                <TriangleAlert className="size-3.5" aria-hidden />
                {entry.failed.length} delivery
                {entry.failed.length === 1 ? '' : ' failures'} failed
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-text-subtle">
            <time dateTime={entry.at} title={formatTimestamp(entry.at)}>
              {timeAgo(entry.at)}
            </time>
            {' · '}
            {entry.reached === 0
              ? 'reached no channel'
              : `reached ${entry.reached} of ${entry.deliveries.length} channel${
                  entry.deliveries.length === 1 ? '' : 's'
                }`}
            {entry.acknowledged ? (
              <>
                {' · '}
                <span className="text-status-ok">
                  taken{entry.ackedBy ? ` by ${entry.ackedBy}` : ''}
                  {entry.ackedAt ? ` ${timeAgo(entry.ackedAt)}` : ''}
                </span>
              </>
            ) : null}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/*
           * ⚠️ Every entry links to the incident. An alert that cannot be opened is a notification;
           * an alert you can act on is an inbox item, and the whole workflow starts here.
           */}
          <Button asChild variant="ghost" size="sm">
            <Link to={`/workspace/${entry.incidentId}`}>Open incident</Link>
          </Button>
          {canAck && !entry.acknowledged && ackable > 0 ? (
            <Button variant="outline" size="sm" loading={busy} onClick={onAcknowledge}>
              Acknowledge
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-label={expanded ? 'Hide delivery detail' : 'Show delivery detail'}
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden />
            ) : (
              <ChevronRight className="size-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {expanded ? (
        <ul className="mt-3 space-y-1.5 border-l-2 border-border pl-4">
          {entry.deliveries.map((delivery) => {
            const state = DELIVERY_STATUS[delivery.status];
            return (
              <li key={delivery.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={state.variant}>{state.label}</Badge>
                <span className="text-muted-foreground">{CHANNEL_LABEL[delivery.channelType]}</span>
                {delivery.attempts > 1 ? (
                  <span className="inline-flex items-center gap-0.5 tabular-nums text-2xs text-text-subtle">
                    <RotateCw className="size-3" aria-hidden />
                    {delivery.attempts}
                  </span>
                ) : null}
                {/*
                 * ⚠️ The reason, on the screen. A failed delivery whose cause is only in a service
                 * log is a failure nobody can act on — and "a failed delivery is visible in the
                 * console, with the reason" is a release exit criterion, not a nicety.
                 */}
                {delivery.lastError ? (
                  <span
                    className="min-w-0 flex-1 truncate text-critical"
                    title={delivery.lastError}
                  >
                    {delivery.lastError}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
