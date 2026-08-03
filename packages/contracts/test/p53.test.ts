/**
 * P-5.3 — the contract additions.
 *
 * Each test pins a decision that would otherwise be a comment: a chain that cannot break is not
 * traceability, a dependency nothing exercised is not healthy, a self-contained bundle without a
 * custodian is regulated media with no owner, and a preview computed differently from the export is
 * a reassurance rather than a preview.
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_CHAIN_ORDER,
  EvidenceChain,
  EvidenceChainBreak,
  EvidenceChainStage,
  chainIsComplete,
} from '../src/incidents/chain.js';
import {
  DEPENDENCY_STATE_RANK,
  WorkspaceDependency,
  WorkspaceDependencyHealth,
  WorkspaceDependencyState,
  isActionable,
} from '../src/workspace/health.js';
import {
  WORKSPACE_PROFILES,
  WorkspaceProfileId,
  INVESTIGATION_WORKSPACE_LAYOUT,
} from '../src/workspace/workspace.js';
import { WorkspacePanelState, WorkspaceUiState } from '../src/workspace/state.js';
import {
  DemoScenario,
  OfflineInvestigationBundle,
  ReportPreview,
  WorkspaceNotification,
} from '../src/workspace/surfaces.js';
import { BRANDABLE_TOKENS, TenantBranding, UNBRANDABLE_TOKENS } from '../src/tenant/branding.js';
import { SearchFacet } from '../src/search/search.js';
import { WorkspaceUpdate } from '../src/stream/stream.js';
import {
  EvidenceViewAdjustment,
  PlaybackTimelineTrackKind,
  viewMode,
} from '../src/playback/viewer.js';
import { PlaybackAlignmentMethod, PlaybackClockAccuracy } from '../src/playback/playback.js';
import { IncidentRecommendationKind } from '../src/incidents/incident.js';

const at = '2026-08-03T00:00:00.000Z';

describe('EvidenceChain — a chain is only useful if it can break', () => {
  const base = {
    tenantId: 'tnt_a',
    incidentId: '11111111-1111-4111-8111-111111111111',
    correlationId: 'corr_1',
    derivedAt: at,
  };

  it('covers the eight stages the review named, in order', () => {
    expect([...EVIDENCE_CHAIN_ORDER]).toEqual([...EvidenceChainStage.options]);
    expect(EVIDENCE_CHAIN_ORDER[0]).toBe('camera');
    expect(EVIDENCE_CHAIN_ORDER.at(-1)).toBe('report');
  });

  /*
   * ⚠️ The rule. A customer-facing traceability feature that renders every break as a missing arrow
   * invites the conclusion that the platform lost something.
   */
  it('⚠️ refuses an unresolved link that does not say why', () => {
    const result = EvidenceChain.safeParse({
      ...base,
      links: [{ stage: 'evidence', resolved: false }],
      complete: false,
    });
    expect(result.success).toBe(false);
  });

  it('distinguishes the six ways a link breaks', () => {
    expect(EvidenceChainBreak.options).toEqual([
      'retained-elsewhere',
      'archived',
      'never-produced',
      'not-built',
      'forbidden',
      'unavailable',
    ]);
  });

  it('accepts a broken chain that explains itself', () => {
    const parsed = EvidenceChain.parse({
      ...base,
      links: [
        { stage: 'camera', resolved: true, ref: 'cam_1', label: 'Dock 3' },
        {
          stage: 'detection',
          resolved: false,
          brokenBecause: 'retained-elsewhere',
          detail: 'the triggering event aged out of the retention window',
        },
        {
          stage: 'export',
          resolved: false,
          brokenBecause: 'not-built',
          detail: 'export packaging is not implemented (TD-16)',
        },
      ],
      complete: false,
    });
    expect(parsed.links).toHaveLength(3);
  });

  it('derives completeness so the flag cannot disagree with the links', () => {
    expect(chainIsComplete([{ stage: 'camera', resolved: true }])).toBe(true);
    expect(
      chainIsComplete([
        { stage: 'camera', resolved: true },
        { stage: 'evidence', resolved: false, brokenBecause: 'never-produced', detail: 'none' },
      ]),
    ).toBe(false);
  });
});

describe('WorkspaceHealth — three kinds of "not working"', () => {
  it('covers the seven dependencies the review named', () => {
    expect(WorkspaceDependency.options).toEqual([
      'events',
      'evidence',
      'playback',
      'ai',
      'notifications',
      'jobs',
      'search',
    ]);
  });

  /*
   * ⚠️ Not-built, not-configured and unreachable lead to three different actions: wait for a
   * release, change a config, page someone. Collapsing them wastes all three.
   */
  it('⚠️ separates not-built, not-configured and unreachable', () => {
    for (const state of ['not-built', 'not-configured', 'unreachable'] as const) {
      expect(WorkspaceDependencyState.options).toContain(state);
    }
    expect(isActionable('not-built')).toBe(false); // a release fixes it, not the operator
    expect(isActionable('not-configured')).toBe(true);
    expect(isActionable('unreachable')).toBe(true);
    expect(isActionable('forbidden')).toBe(true);
  });

  /* ⚠️ A dependency nothing exercised is more interesting than one that worked. */
  it('⚠️ sorts unknown above ready', () => {
    expect(DEPENDENCY_STATE_RANK.unknown).toBeLessThan(DEPENDENCY_STATE_RANK.ready);
    expect(DEPENDENCY_STATE_RANK.unreachable).toBe(0);
  });

  it('carries no observation time when nothing exercised the dependency', () => {
    const parsed = WorkspaceDependencyHealth.parse({ dependency: 'ai', state: 'not-built' });
    expect(parsed.observedAt).toBeUndefined();
    expect(parsed.panels).toEqual([]);
  });
});

describe('workspace profiles — defaults, never policy', () => {
  it('covers every profile id', () => {
    expect(WORKSPACE_PROFILES.map((p) => p.id).sort()).toEqual(
      [...WorkspaceProfileId.options].sort(),
    );
  });

  /*
   * ⚠️ Exclusion, not inclusion. An inclusion list would silently hide every future panel from
   * every existing profile — the opposite of additive.
   */
  it('⚠️ lists panels to hide, so a new panel appears for every profile by default', () => {
    for (const profile of WORKSPACE_PROFILES) {
      expect(profile).toHaveProperty('hiddenPanels');
      expect(profile).not.toHaveProperty('visiblePanels');
    }
  });

  it('never hides a panel the registry says cannot be hidden', () => {
    const unhideable = new Set(
      INVESTIGATION_WORKSPACE_LAYOUT.panels.filter((p) => !p.hideable).map((p) => p.id),
    );
    for (const profile of WORKSPACE_PROFILES) {
      for (const hidden of profile.hiddenPanels) {
        expect(unhideable.has(hidden), `${profile.id} may not hide ${hidden}`).toBe(false);
      }
    }
  });
});

describe('layout versioning — two counters, and deliberately not three', () => {
  it('versions panel state per panel, so one reset does not discard the layout', () => {
    const parsed = WorkspacePanelState.parse({ panelId: 'timeline', panelVersion: 2 });
    expect(parsed.panelVersion).toBe(2);
    /* Absent means version 1 — every layout saved before the field existed keeps working. */
    expect(WorkspacePanelState.parse({ panelId: 'timeline' }).panelVersion).toBeUndefined();
  });

  /* ⚠️ A third counter would have to mean one of the two that exist, and then both must agree. */
  it('⚠️ has no migrationVersion', () => {
    const parsed = WorkspaceUiState.parse({
      schemaVersion: 1,
      tenantId: 'tnt_a',
      principalId: 'usr_1',
      layoutVersion: 1,
      migrationVersion: 3,
      updatedAt: at,
    });
    expect(parsed).not.toHaveProperty('migrationVersion');
  });
});

describe('offline bundle — somebody has to own a copy of regulated media', () => {
  const base = {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: 'tnt_a',
    incidentId: '11111111-1111-4111-8111-111111111111',
    incidentVersion: 3,
    createdBy: 'usr_1',
    createdAt: at,
  };

  it('accepts a reference bundle with no custodian — it carries no bytes', () => {
    expect(OfflineInvestigationBundle.safeParse({ ...base, mode: 'references' }).success).toBe(
      true,
    );
  });

  /*
   * ⚠️ A self-contained bundle leaves every retention policy and legal hold that governs the
   * original. From the moment it is written the platform cannot honour a purge request for it.
   */
  it('⚠️ refuses a self-contained bundle with no custodian and no expiry', () => {
    expect(OfflineInvestigationBundle.safeParse({ ...base, mode: 'self-contained' }).success).toBe(
      false,
    );
    expect(
      OfflineInvestigationBundle.safeParse({
        ...base,
        mode: 'self-contained',
        custodian: 'DI Okafor, Case 41221',
        expiresAt: '2027-08-03T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

describe('report preview — the same model the renderer consumes', () => {
  const model = {
    tenantId: 'tnt_a',
    title: 'Incident report',
    provenance: {
      incidentId: '11111111-1111-4111-8111-111111111111',
      incidentVersion: 7,
      correlationId: 'corr_1',
      generatedAt: at,
      generatedBy: 'usr_1',
    },
  };

  it('embeds the report model rather than a second summarising shape', () => {
    const parsed = ReportPreview.parse({
      model,
      presentation: {},
      embeddedEvidenceCount: 4,
      previewedAt: at,
    });
    expect(parsed.model.provenance.incidentVersion).toBe(7);
  });

  /* ⚠️ A number nobody measured, printed beside a download button, is planned around. */
  it('⚠️ leaves the size estimate absent rather than guessing', () => {
    const parsed = ReportPreview.parse({
      model,
      presentation: {},
      embeddedEvidenceCount: 0,
      previewedAt: at,
    });
    expect(parsed.estimatedSizeBytes).toBeUndefined();
  });
});

describe('tenant branding — one colour, and severity is not negotiable', () => {
  it('accepts a name, a storage key and an oklch accent', () => {
    const parsed = TenantBranding.parse({
      tenantId: 'tnt_a',
      companyName: 'Northgate Security',
      logoStorageKey: 'tnt_a/branding/logo.svg',
      primaryColor: 'oklch(0.62 0.16 250)',
      updatedAt: at,
    });
    expect(parsed.defaultTheme).toBe('dark');
  });

  /* A stored URL can be swapped, can track every page load, and breaks when the far end moves. */
  it('takes a storage key for the logo, never a URL', () => {
    const parsed = TenantBranding.parse({
      tenantId: 'tnt_a',
      companyName: 'X',
      updatedAt: at,
    });
    expect(parsed).not.toHaveProperty('logoUrl');
  });

  /*
   * ⚠️ A tenant that could restyle severity could make critical look calm, and an operator who
   * learns "red means act" at one site would be wrong at another.
   */
  it('⚠️ never lets branding touch a severity or status token', () => {
    for (const token of UNBRANDABLE_TOKENS) {
      expect(BRANDABLE_TOKENS as readonly string[]).not.toContain(token);
    }
    expect(BRANDABLE_TOKENS).toEqual(['color-brand', 'color-brand-muted', 'color-brand-border']);
  });

  it('refuses a hex accent — the platform speaks oklch', () => {
    expect(
      TenantBranding.safeParse({
        tenantId: 'tnt_a',
        companyName: 'X',
        primaryColor: '#3b82f6',
        updatedAt: at,
      }).success,
    ).toBe(false);
  });
});

describe('the remaining reservations', () => {
  /* ⚠️ A facet count is an aggregation, not a bounded page — G-4 applies to it too. */
  it('⚠️ lets a facet offer values without claiming counts it did not compute', () => {
    const parsed = SearchFacet.parse({
      kind: 'camera',
      entity: 'incident',
      counted: false,
      values: [{ value: 'cam_1', label: 'Dock 3' }],
      limitation: 'no aggregation index for camera on incidents',
    });
    expect(parsed.values[0]?.count).toBeUndefined();
  });

  /* ⚠️ A frame says something changed; it never carries the change. */
  it('⚠️ carries an id on a realtime update, never the record', () => {
    const parsed = WorkspaceUpdate.parse({
      kind: 'incident-changed',
      entity: 'incident',
      targetId: 'inc_1',
      incident: { title: 'stale copy' },
      at,
    });
    expect(parsed).not.toHaveProperty('incident');
  });

  it('flags every demo artefact on the record, not by naming convention', () => {
    const parsed = DemoScenario.parse({
      id: 'retail-theft',
      title: 'Retail theft',
      description: 'A walkthrough over recorded footage.',
      isDemo: true,
    });
    expect(parsed.isDemo).toBe(true);
    expect(DemoScenario.safeParse({ id: 'x', title: 'x', description: 'x' }).success).toBe(false);
  });

  it('addresses an in-app notification to one principal, never a tenant', () => {
    const parsed = WorkspaceNotification.parse({
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: 'tnt_a',
      kind: 'incident-assigned-to-you',
      principalId: 'usr_1',
      summary: 'Loitering at Dock 3 was assigned to you',
      at,
    });
    expect(parsed.principalId).toBe('usr_1');
    expect(parsed.readAt).toBeUndefined();
  });

  it('reserves the three additional AI recommendation categories, with no producer', () => {
    for (const kind of ['similar-cameras', 'similar-rules', 'similar-evidence']) {
      expect(IncidentRecommendationKind.options).toContain(kind);
    }
  });

  it('models missing footage as a first-class timeline track', () => {
    expect(PlaybackTimelineTrackKind.options).toContain('missing-footage');
  });

  /*
   * ⚠️ Drift is not offset. An offset is measured and correctable; drift is the residual after
   * correcting — a player may shift by the first and must not shift by the second.
   */
  it('⚠️ records the alignment method and keeps drift distinct from offset', () => {
    expect(PlaybackAlignmentMethod.options).toContain('shared-event');
    const parsed = PlaybackClockAccuracy.parse({
      confidence: 'device-clock',
      method: 'declared-timestamp',
      offsetSeconds: -2.5,
      estimatedDriftSeconds: 4,
    });
    expect(parsed.offsetSeconds).toBe(-2.5);
    expect(parsed.estimatedDriftSeconds).toBe(4);
  });

  /* ⚠️ The label follows the artefact out of the browser; a screenshot loses a badge. */
  it('⚠️ derives Original vs Enhanced from the adjustment itself', () => {
    expect(viewMode(undefined)).toBe('original');
    expect(viewMode(EvidenceViewAdjustment.parse({ zoom: 8 }))).toBe('original');
    expect(viewMode(EvidenceViewAdjustment.parse({ brightness: 1.5 }))).toBe('enhanced');
  });
});
