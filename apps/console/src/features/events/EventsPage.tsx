import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, Rows2, Rows3 } from 'lucide-react';
import type { EventPriority } from '@vip/contracts';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { setDensity } from '@/store/uiSlice';
import { formatTimestamp, shortId, timeAgo } from '@/lib/format';
import { SEVERITY_ORDER } from '@/lib/severity';
import {
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
} from '@/ui';
import { useCameraName } from '@/features/cameras/useCameras';
import { useEventsInfinite } from './useEvents';

/** Event timeline — URL-backed filters (severity + search), density toggle, cursor pagination. */
export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const dispatch = useAppDispatch();
  const density = useAppSelector((s) => s.ui.density);

  const q = params.get('q') ?? '';
  const severity = params.get('severity') ?? 'all';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  /* The camera an operator recognises, not the row id — the same resolver the queue uses. */
  const cameraName = useCameraName();
  const query = useEventsInfinite({ limit: 50 });
  const events = useMemo(() => query.data?.pages.flatMap((p) => p.events) ?? [], [query.data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return events.filter((e) => {
      if (severity !== 'all' && e.priority !== severity) return false;
      if (!needle) return true;
      return [e.type, e.cameraId, e.zoneId, e.correlationId]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [events, q, severity]);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <PageHeader title="Events" description="Detections and system events across your tenant." />

      <FilterBar
        search={q}
        onSearchChange={(v) => setParam('q', v)}
        searchPlaceholder="Search type, camera, zone, correlation id…"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => dispatch(setDensity(density === 'compact' ? 'comfortable' : 'compact'))}
            aria-label={`Switch to ${density === 'compact' ? 'comfortable' : 'compact'} density`}
          >
            {density === 'compact' ? <Rows3 /> : <Rows2 />}
            {density === 'compact' ? 'Comfortable' : 'Compact'}
          </Button>
        }
      >
        <Select value={severity} onValueChange={(v) => setParam('severity', v)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITY_ORDER.map((s) => (
              <SelectItem key={s} value={s}>
                {s[0]?.toUpperCase()}
                {s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        isEmpty={filtered.length === 0}
        skeleton={<TableSkeleton rows={8} cols={6} />}
        emptyState={
          <EmptyState
            icon={Activity}
            title="No events match"
            description={events.length === 0 ? 'No events recorded yet.' : 'Try clearing filters.'}
          />
        }
      >
        <Table density={density}>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Camera</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Correlation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => (
              <TableRow key={e.id}>
                <TableCell
                  className="whitespace-nowrap text-muted-foreground"
                  title={formatTimestamp(e.occurredAt)}
                >
                  {timeAgo(e.occurredAt)}
                </TableCell>
                <TableCell className="font-medium text-foreground">{e.type}</TableCell>
                <TableCell className="text-muted-foreground">
                  {cameraName(e.cameraId) ?? '—'}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={e.priority as EventPriority} dot />
                </TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {e.confidence !== undefined ? `${Math.round(e.confidence * 100)}%` : '—'}
                </TableCell>
                <TableCell className="tabular text-text-subtle" title={e.correlationId}>
                  {e.correlationId ? shortId(e.correlationId) : '—'}
                </TableCell>
              </TableRow>
            ))}
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
