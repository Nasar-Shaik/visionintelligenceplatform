import { Radio, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { formatTimestamp, timeAgo } from '@/lib/format';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  MetricCard,
  PageHeader,
  PageSkeleton,
  QueryBoundary,
} from '@/ui';
import { useEventBridge, type EventBridgeStats } from './useEventBridge';

/**
 * Event Bridge — what perception is publishing to the event platform (P-8 Phase 5).
 *
 * ### ⚠️ Four different reasons a frame does not become an event, shown as four numbers
 *
 * `rejected`, `suppressed`, `dropped` and `out of order` are **not the same thing**, and only one of
 * them is a fault:
 *
 *   - **rejected** — the result failed contract validation and was refused at the producer;
 *   - **suppressed** — it carried no detections, so there were no events to produce;
 *   - **dropped** — a camera's queue was full, which is policy under pressure;
 *   - **out of order** — a newer frame from that camera had already gone out.
 *
 * One combined "not published" number would make a healthy busy system look identical to a broken
 * one. Only **failed** — every attempt exhausted — is a fault, and it is the only one styled as one.
 *
 * ### ⚠️ "Not measured" is a real state, and so is an unknown broker
 *
 * A publisher that has published nothing reports `null` latency and an **unknown** broker — never
 * `0 ms` and never "up". Publishing nothing does not demonstrate a working broker, and rendering
 * that as healthy is exactly the failure ADR-0039 exists to prevent.
 *
 * ### ⚠️ This page configures nothing
 *
 * No start, stop, flush, drain or retry control. Publishing is a consequence of frames arriving,
 * and a "flush queue" button would act on a queue already draining as fast as the broker allows.
 * Per-camera enable/disable is Camera Processing Assignment, which is not built.
 */
export function EventBridgePage() {
  const canRead = usePermission('system:inspect');
  const query = useEventBridge();
  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <PageHeader title="Event bridge" description="What perception publishes to the platform." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="The event bridge is available to roles holding system:inspect."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="Event bridge"
        description="Every value is measured from the running deployment. Nothing here is configurable."
      />
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        skeleton={<PageSkeleton />}
      >
        {query.data === undefined ? null : query.data.enabled ? (
          <Bridge stats={query.data} />
        ) : (
          <EmptyState
            icon={Radio}
            title="The event bridge is not enabled here"
            description={
              query.data.detail ??
              'Frames are analysed but nothing is published, which is a valid deployment.'
            }
          />
        )}
      </QueryBoundary>
    </div>
  );
}

/** ⚠️ `null` renders as "Not measured", never as a number. */
function measured(value: number | null | undefined, format: (v: number) => string) {
  if (value === null || value === undefined) return { text: 'Not measured', measured: false };
  return { text: format(value), measured: true };
}

const asMs = (v: number) => `${v.toFixed(2)} ms`;
const asRate = (v: number) => `${v.toFixed(2)}/s`;

function Bridge({ stats }: { stats: EventBridgeStats }) {
  const latency = measured(stats.publishMsAvg, asMs);
  const throughput = measured(stats.throughputPerSecond, asRate);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Published" value={String(stats.published)} />
        <MetricCard label="Events produced" value={String(stats.detectionsPublished)} />
        <MetricCard label="Queue depth" value={String(stats.queueDepth)} />
        <MetricCard label="Throughput" value={throughput.text} />
      </div>

      <BrokerState stats={stats} />

      <Card>
        <CardHeader>
          <CardTitle>Delivery</CardTitle>
          <CardDescription>What the bridge did with each inference result.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Offered" value={String(stats.offered)} />
            <Stat label="Published" value={String(stats.published)} />
            <Stat label="Publish time" value={latency.text} measured={latency.measured} />
            <Stat
              label="Delayed"
              value={String(stats.delayed)}
              hint="Waited beyond the delay budget before going out."
            />
            <Stat
              label="Retries"
              value={String(stats.retries)}
              hint="Attempts after the first. Bounded — see the publisher."
            />
            <Stat label="In flight" value={String(stats.inflight)} />
            <Stat label="Active cameras" value={String(stats.activeCameras)} />
            <Stat
              label="Failed"
              value={String(stats.failed)}
              tone={stats.failed > 0 ? 'bad' : 'normal'}
              hint="Exhausted every attempt. ⚠️ The only fault on this page."
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Not published</CardTitle>
          <CardDescription>
            Four different reasons, kept apart because only one of them is a problem.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat
              label="Rejected"
              value={String(stats.rejected)}
              tone={stats.rejected > 0 ? 'warn' : 'normal'}
              hint="Failed contract validation and was refused here, rather than dead-lettered downstream."
            />
            <Stat
              label="Suppressed"
              value={String(stats.suppressed)}
              hint="No detections, so there were no events to produce. Not an error."
            />
            <Stat
              label="Dropped"
              value={String(stats.droppedQueueFull)}
              hint="A camera's queue was full. Deliberate policy — recording outranks publishing."
            />
            <Stat
              label="Out of order"
              value={String(stats.droppedOutOfOrder)}
              hint="A newer frame from that camera had already been published. Expected under concurrency."
            />
          </dl>
          <p className="mt-4 text-xs text-text-subtle">
            ⚠️ <strong>Only &ldquo;failed&rdquo; is a fault.</strong> Suppressed and out-of-order
            are normal; dropped is the bridge protecting recording under pressure. Combining these
            into one &ldquo;not published&rdquo; figure would make a healthy busy system look
            identical to a broken one.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Versions</CardTitle>
          <CardDescription>
            ⚠️ Reported, not editable — these are deployment facts, and a control here would
            configure nothing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Publisher" value={stats.publisherVersion} />
            <Stat
              label="Payload schema"
              value={stats.payloadSchemaVersion ?? 'Not observed'}
              measured={stats.payloadSchemaVersion !== undefined}
              hint="The DetectionResult version seen on the wire — reported, never assumed."
            />
            <Stat
              label="Last published"
              value={stats.lastPublishedAt === undefined ? 'Never' : timeAgo(stats.lastPublishedAt)}
              measured={stats.lastPublishedAt !== undefined}
              {...(stats.lastPublishedAt === undefined
                ? {}
                : { hint: formatTimestamp(stats.lastPublishedAt) })}
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * ⚠️ Three states, not two. "Not yet attempted" is neither up nor down, and collapsing it into
 * either one is a claim the deployment has not earned.
 */
function BrokerState({ stats }: { stats: EventBridgeStats }) {
  if (stats.brokerStatus === 'down') {
    return (
      <Alert variant="critical" title="The broker is not reachable">
        The last publish attempt failed after every retry, so events are being lost.
        {stats.lastError === undefined ? null : <> Last error: {stats.lastError}.</>}
        {stats.lastErrorAt === undefined ? null : <> ({timeAgo(stats.lastErrorAt)})</>}{' '}
        <strong>Recording is unaffected</strong> — the bridge drops events rather than applying
        back-pressure to the process that writes evidence.
      </Alert>
    );
  }
  if (stats.brokerStatus === 'unknown') {
    return (
      <Alert variant="info" title="The broker has not been contacted yet">
        Nothing has been published since this service started, so the bridge cannot say whether the
        broker is reachable. ⚠️ This is deliberately not shown as healthy — publishing nothing does
        not demonstrate a working broker.
      </Alert>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm text-text-subtle">
      <Badge variant="success">Broker reachable</Badge>
      <span>The last publish was acknowledged.</span>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  measured: isMeasured = true,
  tone = 'normal',
}: {
  label: string;
  value: string;
  hint?: string;
  measured?: boolean;
  tone?: 'normal' | 'warn' | 'bad';
}) {
  const toneClass =
    tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-foreground';
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className={isMeasured ? `tabular text-sm ${toneClass}` : 'text-sm text-text-subtle'}>
        {value}
      </dd>
      {hint ? <p className="mt-0.5 text-2xs text-text-subtle">{hint}</p> : null}
    </div>
  );
}
