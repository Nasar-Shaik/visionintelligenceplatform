/**
 * Workspace health (P-5.3, Architect rec 8) — **"unavailable services should be explained rather
 * than silently hiding panels"**, made into one surface.
 *
 * ### ⚠️ It is derived from reads the workspace already made — it is not a probe fan-out
 *
 * The obvious implementation asks seven services whether they are up, on every workspace load. That
 * is seven upstream calls added to the busiest screen in the product, to answer a question the
 * screen has *already answered* four times over: the timeline came back with typed gaps, the panels
 * came back with data or errors, and the registry already says which capabilities have no producer.
 *
 * Health is therefore a **projection over evidence the workspace collected anyway** — the same
 * discipline that keeps activity logs, SLA status and audit trails derived (CONSTRAINTS §46), and
 * the same call-budget discipline the timeline itself follows (§54, §63).
 *
 * ### ⚠️ Three states, because three different things are true
 *
 * A dependency that is *not built*, one that is *not configured in this deployment*, and one that
 * is *down right now* are three different facts leading to three different actions — wait for a
 * release, change a config, page someone. Collapsing them into "unavailable" is the failure the
 * fourth render state exists to prevent, applied one level up.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/** Everything the workspace depends on. **Extends additively.** */
export const WorkspaceDependency = z.enum([
  'events',
  'evidence',
  'playback',
  'ai',
  'notifications',
  'jobs',
  'search',
]);
export type WorkspaceDependency = z.infer<typeof WorkspaceDependency>;

/**
 * ⚠️ The distinction the whole surface exists for.
 *
 * - `ready` — answered, this session.
 * - `not-built` — **no producer exists in any deployment.** A release fixes it. The AI advisor and
 *   the playback session resolver are here today.
 * - `not-configured` — built, but this deployment did not wire it. A config change fixes it.
 * - `degraded` — answered, but partially: truncated results, a slow source.
 * - `unreachable` — configured and did not answer. Page someone.
 * - `forbidden` — working fine; **this principal may not read it.** A role grant fixes it, and
 *   reporting it as `unreachable` sends an operator to an engineer for a permissions question.
 * - `unknown` — ⚠️ nothing in this session exercised it, so there is **nothing to report**. Never
 *   rendered as healthy: an unexercised dependency and a working one look identical from here, and
 *   only one of them is a claim we can make.
 */
export const WorkspaceDependencyState = z.enum([
  'ready',
  'not-built',
  'not-configured',
  'degraded',
  'unreachable',
  'forbidden',
  'unknown',
]);
export type WorkspaceDependencyState = z.infer<typeof WorkspaceDependencyState>;

export const WorkspaceDependencyHealth = z.object({
  dependency: WorkspaceDependency,
  state: WorkspaceDependencyState,
  /**
   * ⚠️ Required for every state except `ready` — the sentence an operator reads. "Evidence:
   * degraded" is a colour; "showing the most recent 200 items" is an answer.
   */
  detail: z.string().min(1).max(300).optional(),
  /** Which panels are affected, so the surface points at what the operator can see. */
  panels: z.array(z.string().min(1)).max(20).default([]),
  /** When this was last observed. Absent ⇒ `unknown` — nothing has exercised it. */
  observedAt: IsoDateTime.optional(),
});
export type WorkspaceDependencyHealth = z.infer<typeof WorkspaceDependencyHealth>;

/**
 * The workspace's own view of what is answering.
 *
 * ⚠️ **`derivedAt` and `observedAt` are different instants on purpose.** The report is assembled
 * now; each observation happened when a panel actually read. A single timestamp would imply
 * everything was checked at once, which is exactly the probe fan-out this design avoids.
 */
export const WorkspaceHealth = z.object({
  tenantId: TenantId,
  dependencies: z.array(WorkspaceDependencyHealth).default([]),
  derivedAt: IsoDateTime,
});
export type WorkspaceHealth = z.infer<typeof WorkspaceHealth>;

/**
 * Rank for display: the states an operator can act on come first, and `ready` last.
 *
 * ⚠️ `unknown` sorts **above** `ready`. A dependency nothing exercised is more interesting than one
 * that worked, because it is the one whose failure has not been discovered yet.
 */
export const DEPENDENCY_STATE_RANK: Record<WorkspaceDependencyState, number> = {
  unreachable: 0,
  degraded: 1,
  forbidden: 2,
  'not-configured': 3,
  'not-built': 4,
  unknown: 5,
  ready: 6,
};

/** Is this a state an operator or an administrator can do something about? */
export function isActionable(state: WorkspaceDependencyState): boolean {
  return (
    state === 'unreachable' ||
    state === 'degraded' ||
    state === 'forbidden' ||
    state === 'not-configured'
  );
}
