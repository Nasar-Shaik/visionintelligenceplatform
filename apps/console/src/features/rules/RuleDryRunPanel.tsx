import { useState } from 'react';
import { CheckCircle2, FlaskConical, XCircle } from 'lucide-react';
import { EventEnvelope } from '@vip/contracts';
import { ApiRequestError } from '@/lib/api/http';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Textarea,
} from '@/ui';
import { useDryRunRule } from './useRules';

const SAMPLE_EVENT = JSON.stringify(
  {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'perception.person.detected',
    category: 'perception',
    schemaVersion: '1.0.0',
    tenantId: 'tenant-demo',
    cameraId: 'cam-1',
    zoneId: 'zone-a',
    occurredAt: '2026-07-29T12:00:00.000Z',
    ingestedAt: '2026-07-29T12:00:00.100Z',
    producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
    confidence: 0.92,
    priority: 'high',
  },
  null,
  2,
);

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="size-4 text-success" aria-hidden />
      ) : (
        <XCircle className="size-4 text-text-subtle" aria-hidden />
      )}
      <span className={ok ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
    </li>
  );
}

/**
 * Dry-run the *saved* rule against a sample event — read-only (no emission, no state). Gives authors
 * step-by-step feedback (pre-filter → condition → window) and shows the incident candidate that would
 * be raised. Note: evaluates the last-saved rule, so save edits before re-running.
 */
export function RuleDryRunPanel({ ruleId }: { ruleId: string }) {
  const dryRun = useDryRunRule(ruleId);
  const [text, setText] = useState(SAMPLE_EVENT);
  const [parseError, setParseError] = useState<string | null>(null);

  const run = () => {
    setParseError(null);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      setParseError('Sample event is not valid JSON.');
      return;
    }
    const parsed = EventEnvelope.safeParse(raw);
    if (!parsed.success) {
      setParseError('Sample does not match the EventEnvelope schema.');
      return;
    }
    dryRun.mutate(parsed.data);
  };

  const result = dryRun.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-brand" aria-hidden />
          Dry run
        </CardTitle>
        <CardDescription>
          Test the last-saved rule against a sample event. No incident is ever raised.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="dry-run-event">Sample event (EventEnvelope JSON)</Label>
          <Textarea
            id="dry-run-event"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </div>

        {parseError ? <Alert variant="critical">{parseError}</Alert> : null}
        {dryRun.isError ? (
          <Alert variant="critical">
            {dryRun.error instanceof ApiRequestError
              ? dryRun.error.message
              : 'Dry run failed. Try again.'}
          </Alert>
        ) : null}

        <Button size="sm" onClick={run} loading={dryRun.isPending}>
          Run dry run
        </Button>

        {result ? (
          <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">Result</span>
              <Badge variant={result.matched ? 'success' : 'neutral'}>
                {result.matched ? 'Matched' : 'No match'}
              </Badge>
            </div>
            <ul className="space-y-1">
              <Check ok={result.evaluation.prefilterPassed} label="Pre-filter passed" />
              <Check ok={result.evaluation.conditionPassed} label="Condition passed" />
              <Check ok={result.evaluation.windowPassed} label="Window threshold met" />
            </ul>
            {result.candidate ? (
              <p className="text-xs text-muted-foreground">
                Would raise:{' '}
                <span className="font-medium text-foreground">{result.candidate.title}</span> (
                {result.candidate.severity})
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
