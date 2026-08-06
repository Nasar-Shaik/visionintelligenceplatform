/**
 * The console must never offer a lifecycle move the server will refuse (P-8 Phase 7, ADR-0045).
 *
 * Two surfaces decide which buttons an operator sees — the incident queue and the investigation
 * workspace — and until this milestone each carried its own hand-written copy of the workflow state
 * machine, with a comment saying it *mirrored* one. Both copies were correct. Neither was checked.
 *
 * The queue now derives its actions from `INCIDENT_LIFECYCLE` and cannot drift. The workspace keeps
 * its own table **on purpose**, because it deliberately offers *less* than the server permits, and a
 * derived table could not express that. What it must never do is offer *more*: a button that 409s is
 * a promise the platform breaks in front of the person relying on it. That is what this file checks.
 */
import { describe, expect, it } from 'vitest';
import { INCIDENT_LIFECYCLE, IncidentStatus } from '@vip/contracts';
import { INCIDENT_STATUS, allowedActions } from './status';
import { allowedTransitions, type WorkspaceTransition } from '../workspace/useCollaboration';

/** Where each surface's action lands the incident. The one thing the tables must agree about. */
const QUEUE_TARGET = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  close: 'closed',
} as const;

const WORKSPACE_TARGET: Record<WorkspaceTransition, IncidentStatus> = {
  acknowledge: 'acknowledged',
  investigate: 'investigating',
  escalate: 'escalated',
  resolve: 'resolved',
  close: 'closed',
};

const ALL: IncidentStatus[] = IncidentStatus.options;

describe('incident lifecycle — the console never offers what the server refuses', () => {
  it('every action the queue offers is permitted by the frozen lifecycle', () => {
    for (const status of ALL) {
      for (const action of allowedActions(status)) {
        expect(
          INCIDENT_LIFECYCLE[QUEUE_TARGET[action]].reachableFrom,
          `queue offered ${action} from ${status}`,
        ).toContain(status);
      }
    }
  });

  it('every transition the workspace offers is permitted by the frozen lifecycle', () => {
    for (const status of ALL) {
      for (const transition of allowedTransitions(status)) {
        expect(
          INCIDENT_LIFECYCLE[WORKSPACE_TARGET[transition]].reachableFrom,
          `workspace offered ${transition} from ${status}`,
        ).toContain(status);
      }
    }
  });

  /**
   * ⚠️ The narrowing this test protects, asserted rather than described. The workspace withholds
   * `resolve` on an unacknowledged incident even though the server allows it. If someone later
   * derives that table from the contract "for consistency", this fails and says what was lost.
   */
  it('the workspace deliberately withholds resolve on a raised incident', () => {
    expect(INCIDENT_LIFECYCLE.resolved.reachableFrom).toContain('raised');
    expect(allowedTransitions('raised')).not.toContain('resolve');
    expect(allowedTransitions('raised')).toEqual(['acknowledge']);
  });

  it('a terminal incident is offered nothing, on either surface', () => {
    for (const status of ALL.filter((s) => INCIDENT_LIFECYCLE[s].terminal)) {
      expect(allowedActions(status), `queue on ${status}`).toEqual([]);
      expect(allowedTransitions(status), `workspace on ${status}`).toEqual([]);
    }
  });

  /**
   * ⚠️ Unreachable is not unrenderable. `dismissed` and `archived` are declared and emitted by
   * nothing (ADR-0045), and the console must still label them — a build pinned to this release will
   * meet records written by a later one, and a blank chip beside an incident is worse than a word the
   * operator has not seen before.
   */
  it('renders a label for every status, including the ones nothing emits yet', () => {
    for (const status of ALL) {
      expect(INCIDENT_STATUS[status]?.label, status).toBeTruthy();
    }
    expect(ALL.filter((s) => !INCIDENT_LIFECYCLE[s].reachable)).toEqual(['dismissed', 'archived']);
  });
});
