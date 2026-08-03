/**
 * Collaboration mutations — notes, assignment and lifecycle transitions from the workspace.
 *
 * ### ⚠️ A 409 is the feature, not an error
 *
 * Every incident write is guarded by `version`, and P-5.0 widened that guard to cover notes
 * specifically so that two operators commenting at the same instant get a conflict rather than one
 * silently losing their words. That only pays off if the client **tells the operator what
 * happened** instead of retrying: an automatic retry would re-apply a note written against a state
 * that has since changed — for example a resolution note landing on an incident somebody else just
 * escalated.
 *
 * So a 409 refetches the incident, keeps the operator's text, and says the record moved.
 *
 * ### ⚠️ A transition that is not legal from here is not offered
 *
 * `ALLOWED_FROM` lives in the workflow domain and the server is the authority. The client mirrors
 * it only to decide what to *render* — never to decide what is permitted. A control the server
 * would refuse is a control that teaches an operator the product is unreliable.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AssignIncidentInput,
  Incident,
  IncidentStatus,
  AddIncidentNoteInput,
} from '@vip/contracts';
import { incidentsApi } from '@/lib/api/incidents';
import { ApiRequestError } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';
import { toast } from '@/ui';

/** Lifecycle actions the workspace offers. Mirrors the workflow domain; the server decides. */
export type WorkspaceTransition = 'acknowledge' | 'investigate' | 'escalate' | 'resolve' | 'close';

/**
 * Which transitions are legal from a status, mirrored from `services/workflow/domain/incident-state`.
 *
 * ⚠️ **`closed` maps to nothing, deliberately.** A closed incident is sealed (CONSTRAINTS §57) —
 * offering any control on one would promise an operation the server refuses, and "retained for
 * audit" is only true if the record stops changing.
 */
const ALLOWED_FROM: Record<IncidentStatus, WorkspaceTransition[]> = {
  raised: ['acknowledge'],
  acknowledged: ['investigate', 'escalate', 'resolve'],
  investigating: ['escalate', 'resolve'],
  escalated: ['investigate', 'resolve'],
  resolved: ['close'],
  closed: [],
};

export function allowedTransitions(status: IncidentStatus): WorkspaceTransition[] {
  return ALLOWED_FROM[status];
}

/** The permission each transition needs, so a control is hidden rather than shown and refused. */
export const TRANSITION_PERMISSION: Record<WorkspaceTransition, string> = {
  acknowledge: 'incident:ack',
  investigate: 'incident:investigate',
  escalate: 'incident:escalate',
  resolve: 'incident:resolve',
  close: 'incident:close',
};

function isConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

export function useCollaboration(incidentId: string | undefined) {
  const queryClient = useQueryClient();

  /**
   * Invalidate everything derived from the incident.
   *
   * ⚠️ All five, together. The timeline, activity, SLA and chain are **derivations** of the record
   * — leaving one keyed on a stale version is how a workspace shows a resolved incident with an
   * open SLA clock beside it, and the operator has no way to tell which panel is lying.
   */
  const invalidate = async (): Promise<void> => {
    if (incidentId === undefined) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.incidents.detail(incidentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.incidents.activity(incidentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.incidents.sla(incidentId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.incidents.chain(incidentId) }),
      queryClient.invalidateQueries({ queryKey: ['incidents', 'timeline', incidentId] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.incidents.all() }),
    ]);
  };

  function onError(error: unknown, verb: string): void {
    if (isConflict(error)) {
      /*
       * ⚠️ Refetch and tell them. Not a retry: re-applying a write against a state that has since
       * moved is how a resolution note lands on an incident somebody else just escalated.
       */
      void invalidate();
      toast.error('This incident changed while you were working', {
        description:
          'It has been refreshed. Your text is still here — please review and try again.',
      });
      return;
    }
    if (error instanceof ApiRequestError && error.status === 403) {
      toast.error(`You don’t have permission to ${verb} this incident`);
      return;
    }
    toast.error(`Could not ${verb} the incident`, {
      description: error instanceof Error ? error.message : undefined,
    });
  }

  const addNote = useMutation({
    mutationFn: (input: AddIncidentNoteInput) => incidentsApi.addNote(incidentId!, input),
    onSuccess: async () => {
      await invalidate();
      toast.success('Comment added');
    },
    onError: (error) => onError(error, 'comment on'),
  });

  const assign = useMutation({
    mutationFn: (input: AssignIncidentInput) => incidentsApi.assign(incidentId!, input),
    onSuccess: async (incident: Incident) => {
      await invalidate();
      toast.success(
        incident.assignee === undefined
          ? 'Incident unassigned'
          : `Assigned to ${incident.assignee}`,
      );
    },
    onError: (error) => onError(error, 'assign'),
  });

  const transition = useMutation({
    mutationFn: ({ action, note }: { action: WorkspaceTransition; note?: string }) => {
      const body = note !== undefined && note !== '' ? { note } : {};
      switch (action) {
        case 'acknowledge':
          return incidentsApi.acknowledge(incidentId!, body);
        case 'investigate':
          return incidentsApi.investigate(incidentId!, body);
        case 'escalate':
          return incidentsApi.escalate(incidentId!, body);
        case 'resolve':
          return incidentsApi.resolve(incidentId!, note !== undefined ? { resolution: note } : {});
        case 'close':
          return incidentsApi.close(incidentId!, body);
      }
    },
    onSuccess: async (incident: Incident) => {
      await invalidate();
      toast.success(`Incident ${incident.status}`);
    },
    onError: (error) => onError(error, 'update'),
  });

  return { addNote, assign, transition, invalidate };
}
