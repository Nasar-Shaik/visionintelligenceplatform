/**
 * Workspace health — **derived from the reads the workspace already made.**
 *
 * ⚠️ The obvious implementation probes seven services on every workspace load. That is seven
 * upstream calls added to the busiest screen in the product, to answer a question the screen has
 * already answered: the timeline came back with typed gaps, the panels came back with data or
 * errors, and the registry already records which capabilities have no producer at all.
 *
 * So health is a projection over evidence gathered anyway — the same discipline that keeps activity
 * logs, SLA status and audit trails derived (CONSTRAINTS §46), and the same call-budget discipline
 * the timeline follows (§54, §63).
 *
 * ⚠️ **A dependency nothing exercised reports `unknown`, never `ready`.** An unexercised dependency
 * and a working one look identical from here, and only one of them is a claim the platform can
 * make. That is the whole reason this file resolves states rather than defaulting them to green.
 */
import {
  INVESTIGATION_WORKSPACE_LAYOUT,
  type IncidentTimeline,
  type IncidentTimelineSource,
  type WorkspaceDependency,
  type WorkspaceDependencyHealth,
  type WorkspaceHealth,
  type WorkspaceDependencyState,
} from '@vip/contracts';

/**
 * Which dependencies are timeline sources, and under what name. ⚠️ Only four are: the timeline is
 * the free signal, not a universal one, and the three that are absent here have no producer to be
 * up or down in the first place.
 */
const TIMELINE_SOURCE: Partial<Record<WorkspaceDependency, IncidentTimelineSource>> = {
  events: 'events',
  evidence: 'evidence',
  notifications: 'notify',
};

/** Which panels each dependency feeds — so the surface points at what the operator can see. */
const PANELS: Record<WorkspaceDependency, string[]> = {
  events: ['related-events', 'timeline'],
  evidence: ['evidence-viewer', 'attachments', 'timeline'],
  playback: ['video-playback'],
  ai: ['ai-recommendations'],
  notifications: ['timeline'],
  jobs: [],
  search: [],
};

/**
 * Dependencies with **no producer in any deployment**. Read from the registry rather than restated,
 * so a panel that becomes available stops reporting `not-built` without anyone editing this file.
 */
function notBuilt(): Map<WorkspaceDependency, string> {
  const reasons = new Map<WorkspaceDependency, string>();
  const byPanel = new Map(INVESTIGATION_WORKSPACE_LAYOUT.panels.map((p) => [p.id, p]));

  const ai = byPanel.get('ai-recommendations');
  if (ai?.availability === 'deferred' && ai.unavailableReason !== undefined) {
    reasons.set('ai', ai.unavailableReason);
  }
  const saved = byPanel.get('saved-investigations');
  if (saved?.availability === 'deferred') {
    /* Saved work is served by search; its absence is why `search` is not built either. */
    reasons.set(
      'search',
      'Saved investigations and unified search are contract-frozen, not built.',
    );
  }
  /*
   * ⚠️ `playback` is **no longer listed here** — P-5.5 built the resolver, so it is a real
   * dependency that can be up or down, and reporting it as `not-built` would send an operator to
   * wait for a release when what they need is an engineer. It falls through to the evidence-derived
   * state below: playback resolves evidence, so if evidence is answering, so is playback.
   */
  reasons.set('jobs', 'Background jobs are contract-frozen; no worker runs them yet.');
  return reasons;
}

export interface HealthInputs {
  tenantId: string;
  /** The timeline, when one was fetched. Its typed gaps are the richest signal available. */
  timeline?: IncidentTimeline | undefined;
  /** Panel-level failures the workspace observed, keyed by dependency. */
  observed?: Partial<
    Record<WorkspaceDependency, { state: WorkspaceDependencyState; detail: string }>
  >;
  now: Date;
}

/**
 * Map a timeline gap onto a dependency state.
 *
 * ⚠️ `truncated` is `degraded`, not `ready`: the source answered, and it answered incompletely.
 * Reporting it as healthy is how "showing the most recent 200 events" becomes "these are the
 * events" in an operator's head.
 */
function stateFromGap(reason: string): WorkspaceDependencyState {
  switch (reason) {
    case 'forbidden':
      return 'forbidden';
    case 'unavailable':
      return 'unreachable';
    case 'truncated':
      return 'degraded';
    default:
      return 'unknown';
  }
}

export function deriveWorkspaceHealth(inputs: HealthInputs): WorkspaceHealth {
  const built = notBuilt();
  const observedAt = inputs.now.toISOString();
  const dependencies: WorkspaceDependencyHealth[] = [];

  const gapBySource = new Map(
    (inputs.timeline?.gaps ?? [])
      .filter((gap) => gap.reason !== 'not-requested')
      .map((gap) => [gap.source, gap]),
  );

  const all: WorkspaceDependency[] = [
    'events',
    'evidence',
    'playback',
    'ai',
    'notifications',
    'jobs',
    'search',
  ];

  for (const dependency of all) {
    const panels = PANELS[dependency];

    /*
     * ⚠️ Playback's health *is* evidence's health: the resolver is a route on the Evidence service
     * and resolves an evidence record. Probing it separately would be a second call to answer a
     * question the first already answered (§54).
     */
    if (dependency === 'playback') {
      const evidenceGap = gapBySource.get('evidence');
      dependencies.push({
        dependency,
        state: evidenceGap === undefined ? 'ready' : stateFromGap(evidenceGap.reason),
        ...(evidenceGap !== undefined
          ? { detail: `Playback resolves evidence: ${evidenceGap.detail}` }
          : {}),
        panels,
        observedAt,
      });
      continue;
    }

    /* 1. Nothing exists to be up or down. A release fixes it; a config change does not. */
    const missing = built.get(dependency);
    if (missing !== undefined) {
      dependencies.push({ dependency, state: 'not-built', detail: missing, panels });
      continue;
    }

    /* 2. Something the workspace actually observed. */
    const observed = inputs.observed?.[dependency];
    if (observed !== undefined) {
      dependencies.push({ ...observed, dependency, panels, observedAt });
      continue;
    }

    /*
     * 3. A typed gap from the timeline — the most precise signal, and free.
     *
     * ⚠️ Only four dependencies are timeline sources. The other three (playback, jobs, search) have
     * no producer at all and were already resolved as `not-built` above; mapping them onto a
     * timeline source would be inventing a signal the timeline never carried.
     */
    const timelineSource = TIMELINE_SOURCE[dependency];
    const gap = timelineSource === undefined ? undefined : gapBySource.get(timelineSource);
    if (gap !== undefined) {
      dependencies.push({
        dependency,
        state: stateFromGap(gap.reason),
        detail: gap.detail,
        panels,
        observedAt,
      });
      continue;
    }

    /* 4. The timeline consulted it and reported no gap: it answered. */
    if (timelineSource !== undefined && inputs.timeline?.sources.includes(timelineSource)) {
      dependencies.push({ dependency, state: 'ready', panels, observedAt });
      continue;
    }

    /*
     * 5. ⚠️ Nothing exercised it this session. `unknown`, with no `observedAt` — never `ready`,
     * because an unexercised dependency and a working one are indistinguishable from here.
     */
    dependencies.push({
      dependency,
      state: 'unknown',
      detail: 'Nothing in this session has read from it.',
      panels,
    });
  }

  return { tenantId: inputs.tenantId, dependencies, derivedAt: observedAt };
}
