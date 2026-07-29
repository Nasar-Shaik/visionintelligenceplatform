import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell, RotateCw, X } from 'lucide-react';
import type { NotificationStatus } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { formatTimestamp, shortId, timeAgo } from '@/lib/format';
import {
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
  toast,
} from '@/ui';
import { CHANNEL_LABEL, DELIVERY_STATUS, canAckStatus } from './delivery';
import { useAckNotification, useNotificationsInfinite } from './useNotifications';

const STATUSES: NotificationStatus[] = ['pending', 'sent', 'delivered', 'failed', 'acked'];
const POLL = { refetchInterval: 20_000 };

/** Alert delivery log — every notification the Alert Engine sent per channel, with recipient ack. */
export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'all';
  const incidentId = params.get('incidentId');

  const canAck = usePermission('notification:ack');
  const ack = useAckNotification();

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const query = useNotificationsInfinite(
    {
      limit: 50,
      ...(status !== 'all' ? { status: status as NotificationStatus } : {}),
      ...(incidentId ? { incidentId } : {}),
    },
    POLL,
  );
  const notifications = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );

  const runAck = (id: string) => {
    ack.mutate(
      { id, input: {} },
      {
        onSuccess: () => toast.success('Alert acknowledged'),
        onError: () => toast.error('Could not acknowledge'),
      },
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <PageHeader
        title="Alerts"
        description="Notification delivery log — one record per channel per incident."
      />

      <FilterBar>
        <Select value={status} onValueChange={(v) => setParam('status', v)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Delivery status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {DELIVERY_STATUS[s].label}
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
      </FilterBar>

      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        isEmpty={notifications.length === 0}
        skeleton={<TableSkeleton rows={8} cols={6} />}
        emptyState={
          <EmptyState
            icon={Bell}
            title="No alerts"
            description={
              status !== 'all' || incidentId
                ? 'No alerts match these filters.'
                : 'Delivered alerts appear here when an incident is raised.'
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {notifications.map((n) => {
              const delivery = DELIVERY_STATUS[n.status];
              const at = n.deliveredAt ?? n.sentAt ?? n.createdAt;
              return (
                <TableRow key={n.id}>
                  <TableCell>
                    <SeverityBadge severity={n.severity} dot />
                  </TableCell>
                  <TableCell className="font-medium text-foreground">{n.title}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {CHANNEL_LABEL[n.channelType]}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant={delivery.variant}>{delivery.label}</Badge>
                      {n.attempts > 1 ? (
                        <span className="tabular inline-flex items-center gap-0.5 text-2xs text-text-subtle">
                          <RotateCw className="size-3" aria-hidden />
                          {n.attempts}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-muted-foreground"
                    title={formatTimestamp(at)}
                  >
                    {timeAgo(at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {n.status === 'acked' ? (
                      <span className="text-2xs text-text-subtle">
                        {n.ackedBy ? `by ${n.ackedBy}` : 'acked'}
                      </span>
                    ) : canAck && canAckStatus(n.status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={ack.isPending && ack.variables?.id === n.id}
                        onClick={() => runAck(n.id)}
                      >
                        Acknowledge
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {query.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </QueryBoundary>
    </div>
  );
}
