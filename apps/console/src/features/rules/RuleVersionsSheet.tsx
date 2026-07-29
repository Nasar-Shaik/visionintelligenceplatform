import { History } from 'lucide-react';
import type { RuleVersionRecord } from '@vip/contracts';
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
import { useRuleVersions } from './useRules';

const CHANGE_LABEL: Record<RuleVersionRecord['changeKind'], string> = {
  created: 'Created',
  updated: 'Updated',
  'lifecycle-changed': 'Lifecycle changed',
  deleted: 'Deleted',
};

/** Immutable audit trail for a rule — the versioned change history (contract `RuleVersionRecord`). */
export function RuleVersionsSheet({ ruleId }: { ruleId: string }) {
  const versions = useRuleVersions(ruleId);

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
            Every change to this rule, newest first — retained for audit.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <QueryBoundary
            isLoading={versions.isPending}
            isError={versions.isError}
            error={versions.error}
            isEmpty={(versions.data?.length ?? 0) === 0}
            skeleton={
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            }
            emptyState={<EmptyState icon={History} title="No history yet" />}
          >
            <ol className="space-y-3">
              {[...(versions.data ?? [])]
                .sort((a, b) => b.version - a.version)
                .map((record) => (
                  <li
                    key={`${record.ruleId}-${record.version}`}
                    className="rounded-md border border-border bg-surface-1 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">v{record.version}</Badge>
                        <span className="text-sm font-medium text-foreground">
                          {CHANGE_LABEL[record.changeKind]}
                        </span>
                      </div>
                      <time
                        className="text-xs text-text-subtle"
                        title={formatTimestamp(record.changedAt)}
                      >
                        {timeAgo(record.changedAt)}
                      </time>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {record.changedBy ? `by ${record.changedBy}` : 'by system'} ·{' '}
                      {record.snapshot.lifecycle}
                    </p>
                  </li>
                ))}
            </ol>
          </QueryBoundary>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
