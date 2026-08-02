import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import type { RuleIssueSeverity, RuleValidationReport } from '@vip/contracts';
import { Alert, Badge, Button } from '@/ui';
import { rulesApi } from '@/lib/api/rules';
import { queryKeys } from '@/lib/queryKeys';

const SEVERITY_ICON: Record<RuleIssueSeverity, typeof XCircle> = {
  error: XCircle,
  warning: AlertTriangle,
  info: HelpCircle,
};

const SEVERITY_CLASS: Record<RuleIssueSeverity, string> = {
  error: 'text-destructive',
  warning: 'text-warning',
  info: 'text-muted-foreground',
};

/** Human words for the reference kinds. A code is for a log; this is for a person. */
const KIND_LABEL: Record<string, string> = {
  location: 'Location',
  camera: 'Camera',
  'event-type': 'Event type',
  category: 'Category',
  behavior: 'Behavior',
  composite: 'Composite',
  schedule: 'Schedule',
  output: 'Output',
  action: 'Action',
};

/**
 * What is wrong with this rule, before it goes live (P-4).
 *
 * The distinction this panel exists to make visible is **valid** versus **verified**. A rule whose
 * location check could not run is not a rule that passed — the service refuses to enable it, and an
 * author who is not told why will conclude the button is broken.
 */
export function RuleValidationPanel({ ruleId }: { ruleId: string }) {
  const query = useQuery({
    queryKey: queryKeys.rules.validation(ruleId),
    queryFn: () => rulesApi.validation(ruleId),
  });

  const report: RuleValidationReport | undefined = query.data;

  return (
    <section className="space-y-3" aria-label="Validation">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Validation</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? 'Checking…' : 'Re-check'}
        </Button>
      </div>

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Checking references…</p>
      ) : null}

      {report ? (
        <>
          {report.valid ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" aria-hidden />
              Every reference checks out. This rule can be enabled.
            </p>
          ) : null}

          {!report.verified ? (
            <Alert variant="warning">
              Some references could not be checked because the owning service was unavailable. A
              rule is never activated on a check that did not run — try again once it is reachable.
            </Alert>
          ) : null}

          {report.issues.length > 0 ? (
            <ul className="space-y-2">
              {report.issues.map((issue, index) => {
                const Icon = SEVERITY_ICON[issue.severity];
                return (
                  <li key={`${issue.code}-${index}`} className="flex items-start gap-2 text-sm">
                    <Icon
                      className={`mt-0.5 size-4 shrink-0 ${SEVERITY_CLASS[issue.severity]}`}
                      aria-hidden
                    />
                    <span className="flex-1">
                      {issue.message}
                      {issue.ref ? (
                        <code className="ml-1 text-xs text-muted-foreground">{issue.ref}</code>
                      ) : null}
                    </span>
                    <Badge variant="outline">{KIND_LABEL[issue.kind] ?? issue.kind}</Badge>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Checked {report.checked.map((kind) => KIND_LABEL[kind] ?? kind).join(', ') || 'nothing'}{' '}
            · version {report.ruleVersion}
          </p>
        </>
      ) : null}
    </section>
  );
}
