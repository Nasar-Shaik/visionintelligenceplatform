import { useMemo } from 'react';
import {
  AlertTriangle,
  CircleHelp,
  CircleSlash,
  Package,
  RefreshCw,
  ShieldAlert,
  Sliders,
  XCircle,
} from 'lucide-react';
import {
  SYSTEM_STATE_RANK,
  type SystemComponent,
  type SystemComponentKind,
  type SystemComponentState,
} from '@vip/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { timeAgo, formatTimestamp } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  QueryBoundary,
  Skeleton,
} from '@/ui';
import { cn } from '@/lib/cn';
import { useSystemHealth } from './useSystemHealth';

/**
 * System Health — **what the deployment can honestly be said to be doing right now.**
 *
 * ### ⚠️ The goal is not a wall of green ticks
 *
 * A dashboard that reports "healthy" because a process answered is worse than no dashboard: it is a
 * claim, made by us, that a customer will rely on at the moment it matters. So every row here traces
 * back to evidence, and the seven states are kept apart because they lead to four different actions
 * — wait for a release, change a config, grant a role, page someone.
 *
 * ### ⚠️ Why nothing here says "All systems operational"
 *
 * That sentence is only true if every component is `ready`, and `unknown` is not `ready`. A
 * component nothing has exercised and a working one look identical from here, and only one of them
 * is a claim we are entitled to make. The summary line counts what is actually known and says so.
 *
 * ### The three sections answer three different questions
 *
 * - **Services** — is the platform's own software answering? Asked directly, through readiness.
 * - **Infrastructure** — are the things it depends on working? ⚠️ **Derived** from what the services
 *   report about their own dependencies; nothing here opens a socket to MongoDB. That is both
 *   cheaper and truer: it reports the database *as the platform experiences it*.
 * - **Capabilities** — what does this release not do? Facts a probe cannot discover, so an operator
 *   asking "why is there no email alert?" reads the answer instead of filing a defect.
 */
export function SystemHealthPage() {
  const canInspect = usePermission('system:inspect');
  const query = useSystemHealth();

  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;

  if (!canInspect || forbidden) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-6">
        <PageHeader title="System Health" description="What the platform reports about itself." />
        {/*
         * ⚠️ "You may not see this" and "nothing is wrong" are different sentences, and only one of
         * them is true here. A health page that rendered empty for an unauthorized viewer would be
         * read as an all-clear by the person least able to check.
         */}
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="System health is available to administrators and operators. Your account can use the rest of the console normally — this restriction says nothing about whether the platform is healthy."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
      <PageHeader
        title="System Health"
        description="What the platform reports about itself — and what it cannot report on."
      />

      {/*
       * ⚠️ `isError` is deliberately conditioned on there being **no reading at all**.
       *
       * Measured against the deployment by stopping the gateway with the page open: the whole
       * report was replaced by "Couldn't load · Request failed (502)". Every row gone — during the
       * exact outage this page exists to report, and the operator loses the last thing the platform
       * managed to say about itself. A reading from twenty seconds ago is not current, but it is
       * the only context there is, and it is far better than a blank page.
       *
       * So a failed refresh keeps the report and adds a banner naming its age. The bare error state
       * is reserved for the case where nothing has ever loaded, where there is genuinely nothing to
       * show.
       */}
      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError && query.data === undefined}
        error={query.error}
        skeleton={
          <div className="space-y-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        }
      >
        {query.data ? (
          <Report
            components={query.data.components}
            derivedAt={query.data.derivedAt}
            isFetching={query.isFetching}
            staleSince={query.isError ? query.data.derivedAt : null}
            onRefresh={() => void query.refetch()}
          />
        ) : null}
      </QueryBoundary>
    </div>
  );
}

function Report({
  components,
  derivedAt,
  isFetching,
  staleSince,
  onRefresh,
}: {
  components: SystemComponent[];
  derivedAt: string;
  isFetching: boolean;
  /** Set when the last refresh failed: the rows below are this old, and are no longer current. */
  staleSince: string | null;
  onRefresh: () => void;
}) {
  const sections = useMemo(() => group(components), [components]);
  const summary = useMemo(() => summarize(components), [components]);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {staleSince === null ? summary.headline : `Last known: ${summary.headline}`}
            </p>
            <p className="mt-1 text-xs text-text-subtle">
              {staleSince === null ? 'Assembled' : 'Last read'} {timeAgo(derivedAt)} ·{' '}
              <time dateTime={derivedAt}>{formatTimestamp(derivedAt)}</time>
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onRefresh} loading={isFetching}>
            <RefreshCw className="size-3.5" aria-hidden />
            Refresh
          </Button>
        </CardContent>
      </Card>

      {/*
       * ⚠️ The most important banner on the page, because it is the only one that qualifies every
       * other thing on it. Everything below is a reading from the past, and saying so is the
       * difference between an old report and a wrong one.
       */}
      {staleSince !== null ? (
        <Alert variant="critical">
          <span className="font-medium">This report could not be refreshed.</span> Everything below
          is the reading from {timeAgo(staleSince)} and is no longer current — the platform may have
          changed since, and the fact that it cannot be reached is itself worth acting on.
        </Alert>
      ) : null}

      {summary.actionable.length > 0 ? (
        <Alert variant={summary.critical ? 'critical' : 'warning'}>
          <span className="font-medium">
            {summary.actionable.length === 1
              ? '1 component needs attention:'
              : `${summary.actionable.length} components need attention:`}
          </span>{' '}
          {summary.actionable.map((c) => c.label).join(', ')}.
        </Alert>
      ) : null}

      <Section
        title="Services"
        description="The platform's own processes, asked directly. ⚠️ Readiness, not liveness — a liveness probe answers “ok” for as long as the process can answer at all, so it cannot report a broken dependency."
        components={sections.service}
      />
      <Section
        title="Infrastructure"
        description="Derived from what the services report about their own dependencies — nothing here is probed from your browser or from the gateway. A dependency no service checks is not listed, because its absence is not evidence about it."
        components={sections.infrastructure}
      />
      <Section
        title="Capabilities"
        description="What this release does and does not contain. These are facts about the version you are running, not about this morning, so no probe can discover them."
        components={sections.capability}
      />
    </div>
  );
}

function Section({
  title,
  description,
  components,
}: {
  title: string;
  description: string;
  components: SystemComponent[];
}) {
  if (components.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {components.map((component) => (
            <ComponentRow key={component.id} component={component} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ComponentRow({ component }: { component: SystemComponent }) {
  const failed = component.checks.filter((c) => c.status === 'fail');
  return (
    <li className="flex flex-col gap-1.5 px-5 py-3.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StateDot state={component.state} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{component.label}</p>
          {/*
           * ⚠️ Every state except `ready` owes the operator a sentence. "Events: unavailable" is a
           * colour; "did not answer within 2000 ms" is something to act on.
           */}
          {component.detail ? (
            <p className="mt-0.5 text-xs text-text-subtle">{component.detail}</p>
          ) : null}
          {failed.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {failed.map((check) => (
                <li key={check.name} className="text-2xs text-critical">
                  {check.name}
                  {check.detail ? ` — ${check.detail}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
        <StateBadge state={component.state} />
        {component.latencyMs !== undefined ? (
          <span className="text-2xs tabular-nums text-text-subtle">{component.latencyMs} ms</span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * ⚠️ **The word, not only the colour.** Seven states cannot be told apart by hue — three of them are
 * some shade of "not working" and two of those are nobody's fault. Colour is the secondary channel
 * here, which is also what keeps the page usable for a colour-blind operator (DESIGN_SYSTEM §7).
 */
const STATE_LABEL: Record<SystemComponentState, string> = {
  ready: 'Healthy',
  degraded: 'Degraded',
  unreachable: 'Unavailable',
  'not-configured': 'Not configured',
  'not-built': 'Not built',
  forbidden: 'Forbidden',
  unknown: 'Unknown',
};

const STATE_TONE: Record<SystemComponentState, string> = {
  ready: 'bg-status-ok',
  degraded: 'bg-warning',
  unreachable: 'bg-critical',
  'not-configured': 'bg-text-muted',
  'not-built': 'bg-border-strong',
  forbidden: 'bg-warning',
  unknown: 'bg-border-strong',
};

const STATE_BADGE: Record<SystemComponentState, 'neutral' | 'outline' | 'critical' | 'warning'> = {
  ready: 'outline',
  degraded: 'warning',
  unreachable: 'critical',
  'not-configured': 'outline',
  'not-built': 'outline',
  forbidden: 'warning',
  unknown: 'outline',
};

const STATE_ICON: Partial<Record<SystemComponentState, typeof XCircle>> = {
  unreachable: XCircle,
  degraded: AlertTriangle,
  'not-configured': Sliders,
  'not-built': Package,
  forbidden: CircleSlash,
  unknown: CircleHelp,
};

function StateDot({ state }: { state: SystemComponentState }) {
  const Icon = STATE_ICON[state];
  if (Icon) return <Icon className="mt-0.5 size-4 shrink-0 text-text-subtle" aria-hidden />;
  return (
    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', STATE_TONE[state])} aria-hidden />
  );
}

function StateBadge({ state }: { state: SystemComponentState }) {
  return <Badge variant={STATE_BADGE[state]}>{STATE_LABEL[state]}</Badge>;
}

function group(components: SystemComponent[]): Record<SystemComponentKind, SystemComponent[]> {
  const empty: Record<SystemComponentKind, SystemComponent[]> = {
    service: [],
    infrastructure: [],
    capability: [],
  };
  for (const component of components) empty[component.kind].push(component);
  /*
   * Within a section: what an operator can act on first, then alphabetically so the list does not
   * reshuffle under them on every poll. ⚠️ `unknown` outranks `ready` — a component nothing reports
   * on is the one whose failure has not been discovered yet.
   */
  for (const kind of Object.keys(empty) as SystemComponentKind[]) {
    empty[kind].sort(
      (a, b) =>
        SYSTEM_STATE_RANK[a.state] - SYSTEM_STATE_RANK[b.state] || a.label.localeCompare(b.label),
    );
  }
  return empty;
}

/**
 * ⚠️ The headline never claims more than the rows support.
 *
 * "All systems operational" requires every component to be `ready`. A single `unknown` makes that
 * sentence false, and the difference between "everything is fine" and "everything we can see is
 * fine" is the entire difference between this page and a decoration.
 */
function summarize(components: SystemComponent[]) {
  const observable = components.filter((c) => c.kind !== 'capability');
  const actionable = observable.filter(
    (c) => c.state === 'unreachable' || c.state === 'degraded' || c.state === 'forbidden',
  );
  const unknown = observable.filter((c) => c.state === 'unknown');
  const critical = actionable.some((c) => c.state === 'unreachable');

  let headline: string;
  if (actionable.length > 0) {
    headline = critical
      ? 'Part of the platform is not answering.'
      : 'The platform is answering, but not fully.';
  } else if (unknown.length > 0) {
    headline =
      unknown.length === 1
        ? 'Everything that reports in is healthy. 1 component reports nothing, so nothing is claimed about it.'
        : `Everything that reports in is healthy. ${unknown.length} components report nothing, so nothing is claimed about them.`;
  } else {
    headline =
      observable.length === 1
        ? 'The one component that reports in is healthy.'
        : `All ${observable.length} components report healthy.`;
  }
  return { headline, actionable, unknown, critical };
}
