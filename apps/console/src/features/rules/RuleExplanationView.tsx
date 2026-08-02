import { CheckCircle2, XCircle } from 'lucide-react';
import type { ConditionTrace, RuleExplanation, StageTrace } from '@vip/contracts';
import { Badge } from '@/ui';

const STAGE_LABEL: Record<string, string> = {
  lifecycle: 'Enabled',
  scope: 'Location scope',
  prefilter: 'Event type',
  condition: 'Condition',
  window: 'Window threshold',
  matched: 'Matched',
};

function Stage({ ok, label, decisive }: { ok: boolean; label: string; decisive: boolean }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="size-4 text-success" aria-hidden />
      ) : (
        <XCircle className="size-4 text-destructive" aria-hidden />
      )}
      <span className={ok ? 'text-foreground' : 'font-medium text-foreground'}>{label}</span>
      {decisive ? <Badge variant="outline">decided here</Badge> : null}
    </li>
  );
}

/**
 * The stage list, from the server's own tree (P-4.1).
 *
 * The client used to re-derive which stage decided from the `stages` booleans, which meant the same
 * ordering rule existed in two places and could disagree the first time either changed. The server now
 * marks the decisive node, so this renders rather than re-decides.
 */
function StageList({ tree }: { tree: readonly StageTrace[] }) {
  return (
    <ul className="space-y-1" aria-label="Evaluation stages">
      {tree
        // The lifecycle stage is always true in an authoring dry-run; showing it is noise.
        .filter((node) => node.stage !== 'lifecycle')
        .map((node) => (
          <Stage
            key={node.stage}
            ok={node.passed}
            label={STAGE_LABEL[node.stage] ?? node.stage}
            decisive={node.decisive}
          />
        ))}
    </ul>
  );
}

/**
 * One node of the condition tree.
 *
 * Failing branches are open and passing ones are collapsed: an author looking at a rule that did not
 * fire wants the failure, and the ten leaves that matched are noise on the way to it.
 */
function Trace({ trace, depth = 0 }: { trace: ConditionTrace; depth?: number }) {
  return (
    <li style={{ marginLeft: depth * 12 }}>
      <div className="flex items-start gap-2 text-sm">
        {trace.passed ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
        )}
        <span className={trace.passed ? 'text-muted-foreground' : 'text-foreground'}>
          {trace.reason}
        </span>
      </div>
      {trace.children && !trace.passed ? (
        <ul className="mt-1 space-y-1">
          {trace.children.map((child, index) => (
            <Trace key={index} trace={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Why the rule did or did not fire (P-4).
 *
 * The headline is the **stage that decided**, not a list of everything that happened. A rule scoped
 * to the wrong site and with a failing condition should send its author to the scope; showing both
 * equally invites them to fix the one that would not have helped.
 */
export function RuleExplanationView({ explanation }: { explanation: RuleExplanation }) {
  const { stages } = explanation;
  /*
   * Defaulted rather than assumed. The contract defaults `tree` to `[]` on parse, but this component
   * renders whatever the API returned — and a service deployed before P-4.1 returns an explanation
   * with no tree at all. Reading `.length` off that is a blank panel exactly when someone is trying to
   * find out why their rule did not fire.
   */
  const tree = explanation.tree ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">
          {explanation.matched ? 'Fired' : `Did not fire — ${STAGE_LABEL[explanation.decidedBy]}`}
        </span>
        {': '}
        <span className="text-muted-foreground">{explanation.summary}</span>
      </p>

      {tree.length > 0 ? (
        <StageList tree={tree} />
      ) : (
        // A service that predates the tree still explains itself — one fewer reason not to deploy.
        <ul className="space-y-1" aria-label="Evaluation stages">
          <Stage
            ok={stages.scopePassed}
            label="Location scope"
            decisive={explanation.decidedBy === 'scope'}
          />
          <Stage
            ok={stages.prefilterPassed}
            label="Event type"
            decisive={explanation.decidedBy === 'prefilter'}
          />
          <Stage
            ok={stages.conditionPassed}
            label="Condition"
            decisive={explanation.decidedBy === 'condition'}
          />
          <Stage
            ok={stages.windowPassed}
            label="Window threshold"
            decisive={explanation.decidedBy === 'window'}
          />
        </ul>
      )}

      {explanation.condition ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Condition detail</p>
          <ul className="space-y-1">
            <Trace trace={explanation.condition} />
          </ul>
        </div>
      ) : null}
    </div>
  );
}
