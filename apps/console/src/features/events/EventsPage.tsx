import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, FlaskConical, Rows2, Rows3 } from 'lucide-react';
import type { EventEnvelope, EventPriority } from '@vip/contracts';
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
import { shortTrack } from '@/features/investigations/overlay';
import { useEventsInfinite } from './useEvents';

/**
 * The subject a row describes.
 *
 * ⚠️ **`subjects[0]`, matching every other reader in the platform** — the timeline projection, the
 * rule engine's aggregation key and the overlay all take the first subject. Picking a different one
 * here would show a track id and a box belonging to a different person than the confidence beside
 * them, and the row would look entirely plausible.
 */
function subjectOf(event: EventEnvelope): Partial<EventEnvelope['subjects'][number]> {
  /*
   * ⛔ **Optional-chained even though the contract marks `subjects` required.** A system event
   * carries none, and a document written before the field existed has none either — and this list
   * renders every event in the tenant. One envelope without subjects would otherwise throw inside
   * `map` and blank the entire page, which is a catastrophic failure mode for a missing rectangle.
   */
  return event.subjects?.[0] ?? {};
}

/** Event timeline — URL-backed filters (severity + search), density toggle, cursor pagination. */
export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const dispatch = useAppDispatch();
  const density = useAppSelector((s) => s.ui.density);

  const q = params.get('q') ?? '';
  const severity = params.get('severity') ?? 'all';
  /*
   * ⭐ **One analysis run's events** (P-8.6). Offline events are excluded from every unfiltered read
   * — that is ADR-0047 and it is correct, because an investigation of last month's footage must not
   * land in the queue an operator is being dispatched from. Naming a run is how you reach them, and
   * it is index-backed (`tenant_analysisSession_time`).
   */
  const analysisSessionId = params.get('analysisSessionId') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  /* The camera an operator recognises, not the row id — the same resolver the queue uses. */
  const cameraName = useCameraName();
  const query = useEventsInfinite({
    limit: 50,
    ...(analysisSessionId === '' ? {} : { analysisSessionId }),
  });
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
      <PageHeader
        title="Events"
        description={
          analysisSessionId === ''
            ? 'Detections and system events across your tenant.'
            : 'Every event one analysis run persisted.'
        }
      />

      {/*
        ⛔ **A filtered feed says it is filtered.** Without this the page looks like the live event
        stream while showing footage that may be weeks old — the single most misleading thing an
        events list can do to an operator on shift.
      */}
      {analysisSessionId === '' ? null : (
        <div
          className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-brand/40 bg-brand/5 p-3 text-sm"
          data-testid="analysis-filter-banner"
        >
          <FlaskConical className="h-4 w-4 shrink-0 text-brand" aria-hidden />
          <span>
            Showing <strong>offline analysis</strong> events from run{' '}
            <span className="tabular">{shortId(analysisSessionId)}</span>. These are findings from a
            recording — <strong>not live activity</strong>, and nobody is being dispatched to them.
          </span>
          <Button size="sm" variant="outline" onClick={() => setParam('analysisSessionId', '')}>
            Back to live events
          </Button>
        </div>
      )}

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
              {/* ⭐ P-8.6: stored on every event since P-8 Phase 2, shown on no screen until now. */}
              <TableHead>Track</TableHead>
              <TableHead>Box (x, y, w, h)</TableHead>
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
                <TableCell className="tabular text-muted-foreground" title={subjectOf(e).trackId}>
                  {subjectOf(e).trackId === undefined ? '—' : shortTrack(subjectOf(e).trackId!)}
                </TableCell>
                <TableCell className="text-2xs tabular text-text-subtle">
                  {subjectOf(e).bbox === undefined
                    ? '—'
                    : subjectOf(e).bbox!.map((n) => n.toFixed(3)).join(', ')}
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
