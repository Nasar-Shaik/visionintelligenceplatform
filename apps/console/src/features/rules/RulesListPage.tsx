import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { Rule } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { formatTimestamp, timeAgo } from '@/lib/format';
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  PageHeader,
  QueryBoundary,
  SeverityBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
  toast,
} from '@/ui';
import { lifecyclePresentation } from './lifecycle';
import { useDeleteRule, useRules, useSetRuleLifecycle } from './useRules';

/** Rule catalog — list, enable/disable, edit, delete. Authoring lives in the editor (RuleEditorPage). */
export function RulesListPage() {
  const rules = useRules();
  const setLifecycle = useSetRuleLifecycle();
  const deleteRule = useDeleteRule();
  const canWrite = usePermission('rule:update');
  const canCreate = usePermission('rule:create');
  const canDelete = usePermission('rule:delete');

  const [pendingDelete, setPendingDelete] = useState<Rule | null>(null);

  const toggle = (rule: Rule) => {
    const next = rule.lifecycle === 'enabled' ? 'disabled' : 'enabled';
    setLifecycle.mutate(
      { id: rule.id, lifecycle: next },
      {
        onSuccess: () => toast.success(`Rule ${next === 'enabled' ? 'enabled' : 'disabled'}`),
        onError: () => toast.error('Could not update the rule'),
      },
    );
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    deleteRule.mutate(pendingDelete.id, {
      onSuccess: () => {
        toast.success('Rule deleted');
        setPendingDelete(null);
      },
      onError: () => toast.error('Could not delete the rule'),
    });
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <PageHeader
        title="Rules"
        description="Automation rules — IF an event matches, THEN raise an incident."
        actions={
          canCreate ? (
            <Button asChild size="sm">
              <Link to="/rules/new">
                <Plus />
                New rule
              </Link>
            </Button>
          ) : null
        }
      />

      <QueryBoundary
        isLoading={rules.isPending}
        isError={rules.isError}
        error={rules.error}
        isEmpty={(rules.data?.length ?? 0) === 0}
        skeleton={<TableSkeleton rows={6} cols={6} />}
        emptyState={
          <EmptyState
            icon={SlidersHorizontal}
            title="No rules yet"
            description="Create your first automation rule to start raising incidents from events."
            action={
              canCreate ? (
                <Button asChild size="sm">
                  <Link to="/rules/new">
                    <Plus />
                    New rule
                  </Link>
                </Button>
              ) : undefined
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Triggers</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.data?.map((rule) => {
              const life = lifecyclePresentation(rule.lifecycle);
              return (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Link
                      to={`/rules/${rule.id}`}
                      className="font-medium text-foreground hover:text-brand focus-ring rounded-sm"
                    >
                      {rule.name}
                    </Link>
                    {rule.description ? (
                      <p className="mt-0.5 max-w-md truncate text-xs text-text-subtle">
                        {rule.description}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={life.variant}>{life.label}</Badge>
                    <span className="ml-2 text-2xs text-text-subtle">v{rule.version}</span>
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={rule.severity} dot />
                  </TableCell>
                  <TableCell className="tabular text-muted-foreground">{rule.priority}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {rule.eventTypes.length > 0 ? (
                      <span className="tabular">
                        {rule.eventTypes.length} type{rule.eventTypes.length === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-text-subtle">Any event</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-muted-foreground"
                    title={formatTimestamp(rule.updatedAt)}
                  >
                    {timeAgo(rule.updatedAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {canWrite ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={setLifecycle.isPending && setLifecycle.variables?.id === rule.id}
                          onClick={() => toggle(rule)}
                        >
                          {rule.lifecycle === 'enabled' ? 'Disable' : 'Enable'}
                        </Button>
                      ) : null}
                      {canWrite ? (
                        <Button variant="ghost" size="icon" asChild aria-label="Edit rule">
                          <Link to={`/rules/${rule.id}`}>
                            <Pencil />
                          </Link>
                        </Button>
                      ) : null}
                      {canDelete ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete rule"
                          onClick={() => setPendingDelete(rule)}
                        >
                          <Trash2 className="text-critical" />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </QueryBoundary>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete rule</DialogTitle>
            <DialogDescription>
              Delete <span className="font-medium text-foreground">{pendingDelete?.name}</span>?
              This retires the rule from evaluation. The version history is retained for audit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              loading={deleteRule.isPending}
              onClick={confirmDelete}
            >
              Delete rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
