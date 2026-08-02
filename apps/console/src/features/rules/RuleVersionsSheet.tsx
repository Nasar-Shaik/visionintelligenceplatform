import { History, Undo2 } from 'lucide-react';
import type { RuleAuditEntry } from '@vip/contracts';
import { formatTimestamp, timeAgo } from '@/lib/format';
import {
  Badge,
  Button,
  EmptyState,
  QueryBoundary,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Skeleton,
} from '@/ui';
import { useRuleAudit, useRollbackRule } from './useRules';

const ACTION_LABEL: Record<RuleAuditEntry['action'], string> = {
  created: 'Created',
  updated: 'Edited',
  enabled: 'Enabled',
  disabled: 'Disabled',
  archived: 'Archived',
  restored: 'Restored',
  'rolled-back': 'Rolled back',
  deleted: 'Deleted',
};

/** Actions that changed what the rule does are worth emphasising over the ones that changed its state. */
const CONTENT_ACTIONS = new Set<RuleAuditEntry['action']>(['created', 'updated', 'rolled-back']);

/**
 * A rule's history (P-4.1, Architect recs 7 + 12).
 *
 * Reads as a **timeline of actions**, not a list of states: "Enabled", "Rolled back to v3" rather than
 * "lifecycle-changed". The entries are derived server-side from the same immutable versions the
 * platform has always written, so there is one record of what happened and this is a reading of it.
 *
 * Restoring an earlier version creates a **new** version. Nothing in the history is ever removed,
 * which is what makes the trail usable in an investigation: the mistake and the correction are both
 * there.
 */
export function RuleVersionsSheet({ ruleId }: { ruleId: string }) {
  const audit = useRuleAudit(ruleId);
  const rollback = useRollbackRule(ruleId);
  const current = audit.data?.[0]?.version;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <History />
          Version history
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription>
            Every change to this rule, newest first — retained for audit. Restoring an earlier
            version adds a new one; nothing is removed.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {rollback.isError ? (
            <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground">
              {rollback.error instanceof Error ? rollback.error.message : 'Could not restore.'}
            </p>
          ) : null}
          <QueryBoundary
            isLoading={audit.isPending}
            isError={audit.isError}
            error={audit.error}
            isEmpty={(audit.data?.length ?? 0) === 0}
            skeleton={
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            }
            emptyState={<EmptyState icon={History} title="No history yet" />}
          >
            <ol className="space-y-3">
              {(audit.data ?? []).map((entry) => (
                <li
                  key={`${entry.ruleId}-${entry.version}`}
                  className="rounded-md border border-border bg-surface-1 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">v{entry.version}</Badge>
                      <span className="text-sm font-medium text-foreground">
                        {ACTION_LABEL[entry.action]}
                      </span>
                    </div>
                    <time className="text-xs text-text-subtle" title={formatTimestamp(entry.at)}>
                      {timeAgo(entry.at)}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.actor ? `by ${entry.actor}` : 'by system'} · {entry.summary}
                  </p>
                  {/*
                   * Restore is offered only for versions that changed what the rule *does*. Restoring
                   * "the content as of when it was disabled" is a confusing thing to offer, because
                   * lifecycle is deliberately not part of what a restore moves.
                   */}
                  {CONTENT_ACTIONS.has(entry.action) && entry.version !== current ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={rollback.isPending}
                      onClick={() => rollback.mutate(entry.version)}
                    >
                      <Undo2 />
                      Restore this version
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          </QueryBoundary>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
