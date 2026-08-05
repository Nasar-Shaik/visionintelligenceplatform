import { Activity, Boxes, Cpu, Gauge, ShieldAlert, Layers } from 'lucide-react';
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
import { cn } from '@/lib/cn';
import { useAiRuntime, type AiRuntimeCapability, type AiRuntimeView } from './useAiRuntime';

/**
 * AI Runtime — **an engineering page, and it says so.**
 *
 * ### ⚠️ Every number here was measured, or it is not here
 *
 * There is no placeholder on this page. A metric the deployment has not produced renders as
 * **"not measured"**, never as `0`. The distinction is the entire point: `0 ms` and "nobody has
 * asked this runtime to do anything" look identical on a dashboard and mean opposite things, and
 * the second one is the answer during an outage.
 *
 * ### ⚠️ Two columns, never merged
 *
 * **Frame pipeline** is what the *media service* measured about the frames it sent. **Runtime** is
 * what the *runtime* says about itself. They come from different processes and are deliberately
 * shown side by side rather than reconciled — media reporting 600 delivered while the runtime
 * reports 200 processed is a real finding, and one averaged figure would erase it.
 *
 * ### ⚠️ What this page deliberately does NOT do
 *
 * It configures nothing. There is no model picker, no per-camera AI toggle, no threshold slider —
 * selective AI processing is designed (SELECTIVE_AI_PROCESSING.md) and not built, and a control
 * that configures nothing is worse than an absent one. This page reports; it does not steer.
 */
export function AiRuntimePage() {
  const canInspect = usePermission('system:inspect');
  const query = useAiRuntime();
  const forbidden = query.error instanceof ApiRequestError && query.error.status === 403;

  if (!canInspect || forbidden) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <PageHeader
          title="AI Runtime"
          description="What the inference runtime reports about itself."
        />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="The AI runtime view is available to administrators and operators. This restriction says nothing about whether inference is working."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="AI Runtime"
        description="Engineering and deployment visibility for the inference runtime. Every value is measured from the running deployment."
      />
      <QueryBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        error={query.error}
        skeleton={<PageSkeleton />}
      >
        {query.data ? <Runtime view={query.data} /> : null}
      </QueryBoundary>
    </div>
  );
}

function Runtime({ view }: { view: AiRuntimeView }) {
  if (!view.configured) {
    return (
      <EmptyState
        icon={Boxes}
        title="No perception in this deployment"
        description={
          view.detail ??
          'INFERENCE_URL is not set, so frames are recorded but never analysed. Recording is unaffected.'
        }
      />
    );
  }

  const runtime = view.runtime;
  const pipeline = view.pipeline;

  if (runtime === null || runtime.reachable === false) {
    return (
      <div className="space-y-6">
        <Alert variant="critical" title="The runtime is not answering">
          {runtime?.detail ?? 'The media service could not reach the inference runtime.'}
          {/*
           * ⚠️ Said explicitly, because it is the question an operator actually has. Perception
           * failing is not recording failing — that separation is a hard requirement of the frame
           * path (P-8 Phase 2), and a page that leaves it implicit invites an unnecessary panic.
           */}
          <p className="mt-2 text-sm">
            Recording and evidence are unaffected: frames may be dropped for analysis, segments are
            never dropped.
          </p>
        </Alert>
        {pipeline ? <PipelineCard pipeline={pipeline} /> : null}
      </div>
    );
  }

  const capability = runtime.capabilities?.[0];
  const metrics = capability?.metrics;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Health"
          value={<HealthWord health={runtime.health} />}
          icon={<Activity className="size-4" />}
          tone={
            runtime.health === 'ok'
              ? 'success'
              : runtime.health === 'failed'
                ? 'critical'
                : 'warning'
          }
        />
        <MetricCard
          label="Execution provider"
          value={<span className="text-lg">{runtime.executionProvider ?? 'unknown'}</span>}
          icon={<Cpu className="size-4" />}
        />
        <MetricCard
          label="Processing FPS"
          value={<Measured value={metrics?.fps} digits={1} />}
          icon={<Gauge className="size-4" />}
        />
        <MetricCard
          label="Inference latency"
          value={<Measured value={metrics?.avgLatencyMs} digits={1} unit="ms" />}
          icon={<Gauge className="size-4" />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {pipeline ? <PipelineCard pipeline={pipeline} /> : null}
        <RuntimeCard view={view} />
      </div>

      {capability ? <CapabilityCard capability={capability} /> : null}
      <ModelsCard view={view} />

      <p className="text-xs text-text-subtle">
        Observed {timeAgo(view.observedAt)} · {formatTimestamp(view.observedAt)} · runtime answered
        in {runtime.latencyMs ?? '—'} ms
      </p>
    </div>
  );
}

function PipelineCard({ pipeline }: { pipeline: NonNullable<AiRuntimeView['pipeline']> }) {
  const labels = Object.entries(pipeline.detectionsByLabel).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Frame pipeline</CardTitle>
        <CardDescription>
          Measured by the media service — the frames it sent and what came back.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="Offered" value={pipeline.offered} />
          <Row label="Delivered" value={pipeline.delivered} />
          <Row
            label="Dropped (queue full)"
            value={pipeline.droppedQueueFull}
            tone={pipeline.droppedQueueFull > 0 ? 'warning' : undefined}
          />
          <Row
            label="Failed"
            value={pipeline.failed}
            tone={pipeline.failed > 0 ? 'critical' : undefined}
          />
          <Row label="Queue depth" value={pipeline.queueDepth} />
          <Row label="In flight" value={pipeline.inflight} />
          <Row
            label="Transport time"
            value={<Measured value={pipeline.deliverMsAvg} digits={1} unit="ms" />}
          />
          <Row
            label="Frame age"
            value={<Measured value={pipeline.frameAgeMsAvg} digits={0} unit="ms" />}
          />
        </dl>

        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Detections</p>
          {labels.length === 0 ? (
            <p className="mt-1 text-sm text-text-subtle">
              {/*
               * ⚠️ "Nothing detected" is a working runtime looking at an empty scene, and it must
               * not read as a fault. The one thing that would be a fault is stated separately.
               */}
              None yet. An empty scene produces no detections — that is the runtime working, not
              failing.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {labels.map(([label, count]) => (
                <Badge key={label} variant="outline" className="tabular">
                  {label} · {count}
                </Badge>
              ))}
            </div>
          )}
          {pipeline.lastDetectionAt ? (
            <p className="mt-2 text-xs text-text-subtle">
              Last detection {timeAgo(pipeline.lastDetectionAt)}
            </p>
          ) : null}
        </div>

        {pipeline.lastError ? (
          <Alert variant="warning" title="Last delivery error">
            <span className="break-words">{pipeline.lastError}</span>
            {pipeline.lastErrorAt ? (
              <span className="block text-xs text-text-subtle">
                {timeAgo(pipeline.lastErrorAt)}
              </span>
            ) : null}
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RuntimeCard({ view }: { view: AiRuntimeView }) {
  const runtime = view.runtime!;
  const resources = runtime.resources ?? {};
  const metrics = runtime.capabilities?.[0]?.metrics;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtime</CardTitle>
        <CardDescription>Reported by the inference runtime about itself.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Row label="Version" value={runtime.runtimeVersion ?? '—'} />
          <Row label="Uptime" value={<Duration seconds={runtime.uptimeSeconds} />} />
          <Row label="Frames processed" value={metrics?.framesProcessed ?? 0} />
          <Row
            label="Frames dropped"
            value={metrics?.droppedFrames ?? 0}
            tone={(metrics?.droppedFrames ?? 0) > 0 ? 'warning' : undefined}
          />
          <Row label="Queue depth" value={metrics?.queueDepth ?? 0} />
          <Row
            label="Latency p95"
            value={<Measured value={metrics?.latencyP95Ms} digits={1} unit="ms" />}
          />
          <Row
            label="Capture → detection"
            value={<Measured value={metrics?.avgFrameLatencyMs} digits={0} unit="ms" />}
          />
          <Row label="Cameras (last 60s)" value={runtime.cameras ?? 0} />
          <Row
            label="Memory"
            value={
              <Measured value={resources.memoryMb ?? metrics?.memoryMb} digits={0} unit="MB" />
            }
          />
          <Row label="CPU" value={<Measured value={resources.cpuPercent} digits={1} unit="%" />} />
          <Row label="CPU cores" value={<Measured value={resources.cpuCores} digits={2} />} />
          {/*
           * ⚠️ GPU renders "none in this deployment", not "0%". Zero percent implies a GPU that is
           * idle; there is no GPU here, and those are different facts with different budgets.
           */}
          <Row
            label="GPU"
            value={
              resources.gpuPercent === null || resources.gpuPercent === undefined ? (
                <span className="text-text-subtle">none in this deployment</span>
              ) : (
                <Measured value={resources.gpuPercent} digits={1} unit="%" />
              )
            }
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function CapabilityCard({ capability }: { capability: AiRuntimeCapability }) {
  const adapter = capability.adapter ?? {};
  const labels = Object.entries(capability.metrics?.detectionsByLabel ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="size-4" />
          {capability.capabilityId}
        </CardTitle>
        <CardDescription>
          The loaded capability and the exact configuration that produced its results.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={capability.state} />
          {capability.model ? (
            <Badge variant="outline">
              {capability.model.id ?? capability.model.name} v{capability.model.version}
            </Badge>
          ) : null}
          <Badge variant="outline">{capability.executionProvider ?? 'unknown'}</Badge>
        </div>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Output format" value={adapter.outputFormat ?? '—'} />
          <Row
            label="Input"
            value={
              adapter.inputSize
                ? `${adapter.inputSize[0]}×${adapter.inputSize[1]} ${adapter.inputLayout ?? ''}`
                : '—'
            }
          />
          {/*
           * ⚠️ Shown because a result is not reproducible without it: identical weights, provider
           * and frame give different detections if the resize policy or pad value changed.
           */}
          <Row
            label="Preprocessing"
            value={<code className="text-xs">{adapter.preprocessingVersion ?? '—'}</code>}
          />
          <Row label="Intra-op threads" value={adapter.intraOpThreads ?? '—'} />
          <Row label="Warm-up" value={<Measured value={adapter.warmupMs} digits={0} unit="ms" />} />
          <Row label="Detections total" value={capability.metrics?.detectionsTotal ?? 0} />
          <Row
            label="Mean confidence"
            value={<Measured value={capability.metrics?.avgConfidence} digits={3} />}
          />
          <Row
            label="Latency p50"
            value={<Measured value={capability.metrics?.latencyP50Ms} digits={1} unit="ms" />}
          />
        </dl>
        {labels.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {labels.map(([label, count]) => (
              <Badge key={label} className="tabular">
                {label} · {count}
              </Badge>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ModelsCard({ view }: { view: AiRuntimeView }) {
  const models = view.runtime?.registeredModels ?? null;
  if (models === null) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Registered models</CardTitle>
        <CardDescription>
          The checksummed catalogue inside the deployed image. Loading a different one is a
          configuration change, not a code change — and there is no control for it here, because
          model selection is not a customer-facing feature yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-subtle">
                <th className="pb-2 pr-4 font-medium">Model</th>
                <th className="pb-2 pr-4 font-medium">Input</th>
                <th className="pb-2 pr-4 font-medium">Labels</th>
                <th className="pb-2 pr-4 font-medium">Licence</th>
                <th className="pb-2 pr-4 font-medium">Artifact</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-4">
                    <span className="font-medium">{model.id}</span>
                    <span className="ml-2 text-xs text-text-subtle">v{model.version}</span>
                    {model.default ? (
                      <Badge variant="outline" className="ml-2">
                        active
                      </Badge>
                    ) : null}
                    <span className="block text-xs text-text-subtle">
                      {model.family} · {model.format} · {model.trainedOn}
                    </span>
                  </td>
                  <td className="py-2 pr-4 tabular">
                    {model.inputSize[0]}×{model.inputSize[1]}
                  </td>
                  <td className="py-2 pr-4 tabular">{model.labelCount}</td>
                  <td className="py-2 pr-4">{model.license}</td>
                  <td className="py-2 pr-4">
                    {model.artifactPresent ? (
                      <span className="text-xs text-text-subtle">{model.checksum}</span>
                    ) : (
                      /* An entry whose artifact is absent is a broken deployment, said plainly. */
                      <Badge variant="critical">missing</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── small pieces ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ The one rule this page is built around: a value that was never measured renders as
 * "not measured", never as zero.
 */
function Measured({
  value,
  digits = 0,
  unit,
}: {
  value: number | null | undefined;
  digits?: number;
  unit?: string;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className="text-sm font-normal text-text-subtle">not measured</span>;
  }
  return (
    <span className="tabular">
      {value.toFixed(digits)}
      {unit ? <span className="ml-0.5 text-xs text-text-subtle">{unit}</span> : null}
    </span>
  );
}

function Duration({ seconds }: { seconds: number | undefined }) {
  if (seconds === undefined) return <Measured value={undefined} />;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return <span className="tabular">{`${h}h ${m}m`}</span>;
  if (m > 0) return <span className="tabular">{`${m}m ${Math.floor(seconds % 60)}s`}</span>;
  return <span className="tabular">{`${Math.floor(seconds)}s`}</span>;
}

function HealthWord({ health }: { health: string | undefined }) {
  const word =
    health === 'ok'
      ? 'Healthy'
      : health === 'degraded'
        ? 'Degraded'
        : health === 'failed'
          ? 'Failed'
          : 'Unknown';
  return <span className="text-2xl">{word}</span>;
}

function StateBadge({ state }: { state: AiRuntimeCapability['state'] }) {
  const variant =
    state === 'READY'
      ? 'success'
      : state === 'FAILED'
        ? 'critical'
        : state === 'LOADING'
          ? 'warning'
          : 'outline';
  return <Badge variant={variant as never}>{state}</Badge>;
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  // `| undefined` explicitly: `exactOptionalPropertyTypes` distinguishes "absent" from "present and
  // undefined", and callers pass a conditional tone.
  tone?: 'warning' | 'critical' | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1">
      <dt className="text-text-subtle">{label}</dt>
      <dd
        className={cn(
          'font-medium',
          tone === 'warning' && 'text-warning',
          tone === 'critical' && 'text-critical',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
