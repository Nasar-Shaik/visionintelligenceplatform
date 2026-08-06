import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, GitBranch, Hash, Layers, Telescope } from 'lucide-react';
import type { IncidentTransition } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { ApiRequestError } from '@/lib/api/http';
import { formatTimestamp, shortId, timeAgo } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  Label,
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SeverityBadge,
  Skeleton,
  Textarea,
  Timeline,
  toast,
} from '@/ui';
import type { TimelineItem } from '@/ui';
import { LoiteringEvidence } from '@/features/loitering/LoiteringEvidence';
import { useCameraName } from '@/features/cameras/useCameras';
import { INCIDENT_STATUS, allowedActions } from './status';
import {
  useAcknowledgeIncident,
  useCloseIncident,
  useIncident,
  useResolveIncident,
} from './useIncidents';

function historyToTimeline(history: IncidentTransition[]): TimelineItem[] {
  return [...history]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .map((t, i) => ({
      id: `${t.to}-${t.at}-${i}`,
      title: INCIDENT_STATUS[t.to].label,
      at: t.at,
      description: (
        <span>
          {t.by ? `by ${t.by}` : 'by system'}
          {t.note ? ` · ${t.note}` : ''}
        </span>
      ),
    }));
}

function MetaRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Camera;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="size-3.5 text-text-subtle" aria-hidden />
      <span className="text-text-subtle">{label}</span>
      <span className="tabular text-muted-foreground">{value}</span>
    </div>
  );
}

interface IncidentDetailSheetProps {
  incidentId: string | null;
  onClose: () => void;
}

/** Right-side incident detail drawer — lifecycle timeline + operator transitions (ack/resolve/close). */
export function IncidentDetailSheet({ incidentId, onClose }: IncidentDetailSheetProps) {
  const query = useIncident(incidentId ?? undefined);
  /* The camera an operator recognises, not the row id. See `useCameraName`. */
  const cameraName = useCameraName();
  const acknowledge = useAcknowledgeIncident();
  const resolve = useResolveIncident();
  const close = useCloseIncident();
  const canAck = usePermission('incident:ack');
  const canResolve = usePermission('incident:resolve');

  const [resolution, setResolution] = useState('');

  // Reset the resolution note whenever a different incident is opened.
  useEffect(() => setResolution(''), [incidentId]);

  const incident = query.data;
  const pending = acknowledge.isPending || resolve.isPending || close.isPending;

  const runAck = () => {
    if (!incident) return;
    acknowledge.mutate(
      { id: incident.id, input: {} },
      {
        onSuccess: () => toast.success('Incident acknowledged'),
        onError: () => toast.error('Could not acknowledge'),
      },
    );
  };
  const runResolve = () => {
    if (!incident) return;
    resolve.mutate(
      { id: incident.id, input: resolution.trim() ? { resolution: resolution.trim() } : {} },
      {
        onSuccess: () => toast.success('Incident resolved'),
        onError: () => toast.error('Could not resolve'),
      },
    );
  };
  const runClose = () => {
    if (!incident) return;
    close.mutate(
      { id: incident.id, input: {} },
      {
        onSuccess: () => toast.success('Incident closed'),
        onError: () => toast.error('Could not close'),
      },
    );
  };

  const actions = incident ? allowedActions(incident.status) : [];
  const showResolveNote = incident !== undefined && actions.includes('resolve') && canResolve;

  return (
    <Sheet open={incidentId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="max-w-lg">
        <SheetHeader>
          {incident ? (
            <>
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <SeverityBadge severity={incident.severity} />
                <Badge variant={INCIDENT_STATUS[incident.status].variant}>
                  {INCIDENT_STATUS[incident.status].label}
                </Badge>
                <span className="text-2xs text-text-subtle">v{incident.version}</span>
              </div>
              <SheetTitle className="pr-8">{incident.title}</SheetTitle>
            </>
          ) : (
            <SheetTitle>Incident</SheetTitle>
          )}
        </SheetHeader>

        <SheetBody className="space-y-5">
          {query.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : query.isError ? (
            <Alert variant="critical">
              {query.error instanceof ApiRequestError && query.error.status === 404
                ? 'This incident no longer exists.'
                : 'Could not load the incident.'}
            </Alert>
          ) : incident ? (
            <>
              <div className="grid gap-2 rounded-md border border-border bg-surface-2/40 p-3">
                <MetaRow
                  icon={Camera}
                  label="Camera"
                  value={cameraName(incident.triggeredBy.cameraId) ?? '—'}
                />
                <MetaRow icon={GitBranch} label="Rule" value={incident.source.ruleName} />
                <MetaRow icon={Layers} label="Matched" value={String(incident.matchedCount)} />
                <MetaRow
                  icon={Hash}
                  label="Correlation"
                  value={shortId(incident.correlationId, 12)}
                />
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-text-subtle">Raised</span>
                  <span
                    className="text-muted-foreground"
                    title={formatTimestamp(incident.raisedAt)}
                  >
                    {timeAgo(incident.raisedAt)}
                  </span>
                </div>
              </div>

              {incident.resolution ? (
                <div className="rounded-md border border-success-border bg-success-muted/40 p-3 text-xs text-foreground">
                  <span className="font-medium">Resolution: </span>
                  {incident.resolution}
                </div>
              ) : null}

              {/*
               * P-8 Phase 7 — why a dwell rule raised this, with its timeline and evidence links.
               * ⚠️ Renders nothing at all for an incident from a stateless rule: absent detail is
               * absent, not an empty section implying an analysis that found nothing.
               */}
              <LoiteringEvidence
                explanation={incident.explanation}
                timeline={incident.timeline}
                evidence={incident.evidence}
                confidence={incident.detectionConfidence}
              />

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-subtle">
                  Lifecycle
                </p>
                <Timeline items={historyToTimeline(incident.history)} />
              </div>

              {showResolveNote ? (
                <div className="space-y-1.5">
                  <Label htmlFor="resolution">Resolution note (optional)</Label>
                  <Textarea
                    id="resolution"
                    rows={2}
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    placeholder="What was done to handle this?"
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </SheetBody>

        {incident ? (
          <SheetFooter>
            {/*
              ⚠️ The route into the Investigation Workspace, and the reason it exists.

              `/workspace/:incidentId` has been routed since P-5.2 and **nothing in the product
              linked to it**: no navigation entry, no action here. Five milestones of playback,
              timeline, bookmarks, evidence chain and metadata were reachable only by typing a URL,
              which means that to a customer they did not exist. Found by driving the operator
              workflow end to end in a browser rather than by reading the router.

              It leads the footer because investigating is what an operator does *before* deciding
              to acknowledge or resolve — the destructive-ish lifecycle actions stay on the right.
            */}
            <Button asChild variant="secondary" size="sm">
              <Link to={`/workspace/${incident.id}`}>
                <Telescope className="mr-1 size-3.5" aria-hidden />
                Open investigation
              </Link>
            </Button>
            <div className="flex-1" />
            {actions.includes('acknowledge') && canAck ? (
              <Button variant="outline" size="sm" loading={acknowledge.isPending} onClick={runAck}>
                Acknowledge
              </Button>
            ) : null}
            {actions.includes('resolve') && canResolve ? (
              <Button size="sm" loading={resolve.isPending} disabled={pending} onClick={runResolve}>
                Resolve
              </Button>
            ) : null}
            {actions.includes('close') && canResolve ? (
              <Button size="sm" loading={close.isPending} onClick={runClose}>
                Close incident
              </Button>
            ) : null}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
