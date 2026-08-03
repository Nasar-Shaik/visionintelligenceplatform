import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateRuleInput,
  EventEnvelope,
  RuleLifecycleState,
  UpdateRuleInput,
} from '@vip/contracts';
import { rulesApi } from '@/lib/api/rules';
import { queryKeys } from '@/lib/queryKeys';

/** All rules for the tenant (server state). */
export function useRules() {
  return useQuery({ queryKey: queryKeys.rules.list(), queryFn: () => rulesApi.list() });
}

/** A single rule by id (enabled only when an id is present — the editor's create mode passes none). */
export function useRule(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.rules.detail(id ?? ''),
    queryFn: () => rulesApi.get(id as string),
    enabled: Boolean(id),
  });
}

/** Immutable version/audit trail for a rule. */
export function useRuleVersions(id: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.rules.detail(id ?? ''), 'versions'] as const,
    queryFn: () => rulesApi.versions(id as string),
    enabled: Boolean(id),
  });
}

/**
 * The rule's history as actions (P-4.1) — what the timeline renders.
 *
 * Distinct from `useRuleVersions`, which returns the raw immutable snapshots. Both read the same
 * records; this one is the reading a person wants.
 */
export function useRuleAudit(id: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.rules.detail(id ?? ''), 'audit'] as const,
    queryFn: () => rulesApi.audit(id as string),
    enabled: Boolean(id),
  });
}

/** Restore an earlier version's content. Creates a new version — nothing in the history is lost. */
export function useRollbackRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => rulesApi.rollback(id, version),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.rules.all() }),
  });
}

/** What changed between two versions (P-4.2). Only fetched when a reviewer asks for a comparison. */
export function useRuleDiff(id: string, from: number | undefined, to: number | undefined) {
  return useQuery({
    queryKey: [...queryKeys.rules.detail(id), 'diff', from, to] as const,
    queryFn: () => rulesApi.diff(id, from as number, to as number),
    enabled: Boolean(id) && from !== undefined && to !== undefined,
  });
}

/** The rule's operational health (P-4.2) — a score that always travels with its reasons. */
export function useRuleHealth(id: string | undefined) {
  return useQuery({
    queryKey: [...queryKeys.rules.detail(id ?? ''), 'health'] as const,
    queryFn: () => rulesApi.health(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuleInput) => rulesApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.rules.all() }),
  });
}

export function useUpdateRule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateRuleInput) => rulesApi.update(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.rules.all() }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rulesApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.rules.all() }),
  });
}

/** Lifecycle toggle (enable ⇄ disable, etc.) — a targeted patch that bumps the version server-side. */
export function useSetRuleLifecycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lifecycle }: { id: string; lifecycle: RuleLifecycleState }) =>
      rulesApi.update(id, { lifecycle }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.rules.all() }),
  });
}

/** Dry-run a saved rule against a sample event — read-only, never emits or mutates state. */
export function useDryRunRule(id: string) {
  return useMutation({ mutationFn: (event: EventEnvelope) => rulesApi.dryRun(id, event) });
}
