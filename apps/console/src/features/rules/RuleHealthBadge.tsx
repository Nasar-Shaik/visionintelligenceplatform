import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import type { RuleHealthStatus } from '@vip/contracts';
import { Badge } from '@/ui';
import { useRuleHealth } from './useRules';

const STATUS: Record<
  RuleHealthStatus,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  healthy: { label: 'Healthy', icon: CheckCircle2, className: 'text-success' },
  degraded: { label: 'Needs attention', icon: AlertTriangle, className: 'text-warning' },
  unhealthy: { label: 'Not working', icon: XCircle, className: 'text-destructive' },
  unknown: { label: 'Cannot be checked', icon: HelpCircle, className: 'text-muted-foreground' },
};

/**
 * How this rule is doing (P-4.2, Architect rec 2).
 *
 * **The score never appears alone.** Every point deducted is listed with its reason, because a bare
 * number is something people learn to ignore — and then a real problem hides behind a 78. `unknown` is
 * shown as its own state rather than a low score: a rule whose references could not be checked is not
 * an unhealthy rule, it is an unexamined one, and the two need different actions.
 */
export function RuleHealthPanel({ ruleId }: { ruleId: string }) {
  const health = useRuleHealth(ruleId);
  if (health.isPending || health.isError || !health.data) return null;

  const { status, score, findings } = health.data;
  const { label, icon: Icon, className } = STATUS[status];

  return (
    <section className="space-y-2" aria-label="Rule health">
      <div className="flex items-center gap-2">
        <Icon className={`size-4 ${className}`} aria-hidden />
        <span className="text-sm font-medium text-foreground">{label}</span>
        {status === 'unknown' ? null : <Badge variant="outline">{score} / 100</Badge>}
      </div>

      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing to report.</p>
      ) : (
        <ul className="space-y-1">
          {findings.map((finding) => (
            <li key={finding.code} className="flex items-start justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{finding.message}</span>
              {finding.deduction > 0 ? (
                <span className="shrink-0 text-xs text-text-subtle">−{finding.deduction}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
