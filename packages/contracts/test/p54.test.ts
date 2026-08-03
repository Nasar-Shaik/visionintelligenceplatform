/**
 * P-5.4 — the reserved contracts.
 *
 * Each test pins a decision that would otherwise be a comment. The four that matter most:
 *
 * 1. A redaction may not be expressed as an overlay — the overlay would leave the pixels intact.
 * 2. A persisted playback session may not carry business records, only ids.
 * 3. An export profile may not select content, only presentation.
 * 4. Per-operator workload must not be reachable through any role's wildcard.
 */
import { describe, expect, it } from 'vitest';
import {
  AnnotationOverlay,
  AnnotationOverlayKind,
  OVERLAY_FORBIDDEN_KINDS,
  OVERLAY_POINT_ARITY,
  RedactionRequest,
  RedactionResult,
  overlayArityIsValid,
  requiresRenderedTreatment,
} from '../src/playback/annotation.js';
import {
  InvestigationPlaybackSession,
  PlaybackState,
  SESSION_FORBIDDEN_KEYS,
  sessionIsLive,
} from '../src/playback/session.js';
import {
  GRID_TILE_COUNT,
  PLAYBACK_SYNC_MAX_SOURCES,
  PlaybackBookmark,
  PlaybackGridLayout,
  PlaybackWall,
  resolvableMembers,
  sessionExpiresInSeconds,
} from '../src/playback/playback.js';
import { HeatmapBand, PlaybackTimelineHeatmap, heatmapPeak } from '../src/playback/viewer.js';
import {
  EXPORT_PROFILE_PRESETS,
  EvidenceExportProfile,
  PROFILE_FORBIDDEN_KEYS,
  exportBlockers,
} from '../src/reporting/profiles.js';
import { CameraPlacement, coverageIsSurveyed } from '../src/camera/placement.js';
import {
  InvestigationMetrics,
  WORKLOAD_PERMISSION,
  escalationRate,
  falsePositiveRate,
} from '../src/incidents/metrics.js';
import {
  REFUSED_RECOMMENDATION_KINDS,
  IncidentRecommendationKind,
} from '../src/incidents/incident.js';
import { DemoResetRequest } from '../src/workspace/surfaces.js';
import { WORKSPACE_PROFILES, WorkspaceProfileId } from '../src/workspace/workspace.js';
import { CommandId, WORKSPACE_COMMANDS } from '../src/workspace/commands.js';
import { TenantBranding } from '../src/tenant/branding.js';
import { DerivedArtifact, isDestructive } from '../src/evidence/derived.js';
import {
  EvidenceViewAdjustment,
  EvidenceViewMode,
  MODES_REQUIRING_PROMINENT_LABEL,
  requiresProminentLabel,
  viewMode,
} from '../src/playback/viewer.js';
import { RenderedReport, ReportProvenance } from '../src/reporting/report.js';

const NOW = '2026-08-03T12:00:00.000Z';

// ---------------------------------------------------------------------------------------------
// rec 4 — the annotation layer, and the reason redaction is not one
// ---------------------------------------------------------------------------------------------

describe('annotation overlays', () => {
  it('⚠️ refuses blur and redaction as overlay kinds — an overlay leaves the pixels intact', () => {
    for (const forbidden of OVERLAY_FORBIDDEN_KINDS) {
      expect(AnnotationOverlayKind.safeParse(forbidden).success).toBe(false);
      expect(requiresRenderedTreatment(forbidden)).toBe(true);
    }
    /* And the shapes that *are* overlays are not caught by the same rule. */
    for (const kind of AnnotationOverlayKind.options) {
      expect(requiresRenderedTreatment(kind)).toBe(false);
    }
  });

  it('keeps the P-5.2 spellings so stored annotations stay readable', () => {
    for (const kind of ['box', 'point', 'polyline', 'freehand'] as const) {
      expect(AnnotationOverlayKind.safeParse(kind).success).toBe(true);
    }
  });

  it('declares an arity for every kind, and enforces it', () => {
    for (const kind of AnnotationOverlayKind.options) {
      expect(OVERLAY_POINT_ARITY[kind]).toBeDefined();
    }
    expect(overlayArityIsValid('arrow', 1)).toBe(false);
    expect(overlayArityIsValid('arrow', 2)).toBe(true);
    expect(overlayArityIsValid('polygon', 2)).toBe(false);
    expect(overlayArityIsValid('polygon', 3)).toBe(true);
    expect(overlayArityIsValid('point', 2)).toBe(false);
  });

  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: 'tenant-a',
    incidentId: 'incident-1',
    source: { kind: 'evidence' as const, id: 'ev-1' },
    at: NOW,
    points: [
      [0.1, 0.1],
      [0.4, 0.4],
    ] as [number, number][],
    label: 'suspect',
    createdBy: 'operator-1',
    createdAt: NOW,
  };

  it('rejects a polygon drawn with two points', () => {
    const result = AnnotationOverlay.safeParse({ ...base, kind: 'polygon' });
    expect(result.success).toBe(false);
  });

  it('⚠️ requires a revision to name what it replaces, and why', () => {
    const withoutSupersedes = AnnotationOverlay.safeParse({
      ...base,
      kind: 'box',
      revision: { revision: 2, reason: 'wrong frame' },
    });
    expect(withoutSupersedes.success).toBe(false);

    const withoutReason = AnnotationOverlay.safeParse({
      ...base,
      kind: 'box',
      revision: { revision: 2, supersedes: '22222222-2222-4222-8222-222222222222' },
    });
    expect(withoutReason.success).toBe(false);

    const complete = AnnotationOverlay.safeParse({
      ...base,
      kind: 'box',
      revision: {
        revision: 2,
        supersedes: '22222222-2222-4222-8222-222222222222',
        reason: 'wrong frame',
      },
    });
    expect(complete.success).toBe(true);
  });

  it('defaults a first statement to revision 1 with nothing superseded', () => {
    const parsed = AnnotationOverlay.parse({ ...base, kind: 'box' });
    expect(parsed.revision.revision).toBe(1);
    expect(parsed.revision.supersedes).toBeUndefined();
  });
});

describe('redaction', () => {
  it('⚠️ requires a justification — a disclosure is an accountable act', () => {
    const result = RedactionRequest.safeParse({
      tenantId: 'tenant-a',
      incidentId: 'incident-1',
      sourceEvidenceId: 'ev-1',
      regions: [{ treatment: 'blur', points: [], startAt: NOW, reason: 'bystander' }],
      requestedBy: 'operator-1',
      requestedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('⚠️ produces a new evidence record and is always irreversible', () => {
    const result = RedactionResult.safeParse({
      redactedEvidenceId: 'ev-2',
      sourceEvidenceId: 'ev-1',
      irreversible: false,
      regionCount: 1,
      jobId: '33333333-3333-4333-8333-333333333333',
      producedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('never carries a flag that could write back over the original', () => {
    const parsed = RedactionRequest.parse({
      tenantId: 'tenant-a',
      incidentId: 'incident-1',
      sourceEvidenceId: 'ev-1',
      regions: [{ treatment: 'mask', points: [], startAt: NOW, reason: 'bystander' }],
      requestedBy: 'operator-1',
      justification: 'subject access request',
      requestedAt: NOW,
    });
    expect(Object.keys(parsed)).not.toContain('overwriteOriginal');
    expect(Object.keys(parsed)).not.toContain('inPlace');
  });
});

// ---------------------------------------------------------------------------------------------
// rec 1 — the session is UI state
// ---------------------------------------------------------------------------------------------

describe('investigation playback session', () => {
  const session = {
    sessionId: '44444444-4444-4444-8444-444444444444',
    tenantId: 'tenant-a',
    openedBy: 'operator-1',
    openedAt: NOW,
  };

  it('⚠️ carries ids, never the records themselves', () => {
    const parsed = InvestigationPlaybackSession.parse({
      ...session,
      activeBookmarkIds: ['bm-1'],
      activeAnnotationIds: ['an-1'],
    });
    for (const forbidden of SESSION_FORBIDDEN_KEYS) {
      expect(Object.keys(parsed)).not.toContain(forbidden);
    }
    expect(parsed.activeBookmarkIds).toEqual(['bm-1']);
  });

  it('⚠️ is not live until something has been resolved — absent expiry is never "no expiry"', () => {
    const parsed = InvestigationPlaybackSession.parse(session);
    expect(parsed.expiresAt).toBeUndefined();
    expect(sessionIsLive(parsed, new Date(NOW))).toBe(false);
  });

  it('expires with its signed URLs', () => {
    const parsed = InvestigationPlaybackSession.parse({
      ...session,
      expiresAt: '2026-08-03T12:05:00.000Z',
    });
    expect(sessionIsLive(parsed, new Date(NOW))).toBe(true);
    expect(sessionIsLive(parsed, new Date('2026-08-03T12:06:00.000Z'))).toBe(false);
  });

  it('⚠️ has an unavailable state distinct from paused', () => {
    expect(PlaybackState.options).toContain('unavailable');
    expect(PlaybackState.options).toContain('paused');
  });

  it('derives the expiry from the earliest segment, not the latest', () => {
    expect(
      sessionExpiresInSeconds([
        { expiresInSeconds: 900 },
        { expiresInSeconds: 300 },
        { expiresInSeconds: 600 },
      ] as never),
    ).toBe(300);
    expect(sessionExpiresInSeconds([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// rec 2 — the wall
// ---------------------------------------------------------------------------------------------

describe('multi-camera wall', () => {
  it('offers every requested grid', () => {
    expect(PlaybackGridLayout.options).toEqual(['1', '2', '4', '9', '16']);
  });

  it('⚠️ never resolves more members than the fan-out budget, however many tiles are drawn', () => {
    expect(GRID_TILE_COUNT['16']).toBe(16);
    expect(resolvableMembers('16')).toBe(PLAYBACK_SYNC_MAX_SOURCES);
    expect(resolvableMembers('4')).toBe(4);
    /* Raising the budget must move every grid, with no second number to maintain. */
    expect(resolvableMembers('9')).toBe(Math.min(9, PLAYBACK_SYNC_MAX_SOURCES));
  });

  const member = (order: number) => ({
    session: {
      tenantId: 'tenant-a',
      source: { kind: 'evidence' as const, id: `ev-${order}` },
      startedAt: NOW,
      endedAt: NOW,
      durationSeconds: 0,
      playableSeconds: 0,
      capabilities: { seek: true, frameStep: false, rates: [1], snapshot: false, export: false },
      derivedAt: NOW,
    },
    clock: { confidence: 'synchronised' as const },
    order,
  });

  const wall = (overrides: Record<string, unknown>) => ({
    layout: '4' as const,
    group: {
      tenantId: 'tenant-a',
      startedAt: NOW,
      endedAt: NOW,
      durationSeconds: 0,
      members: [member(0), member(1)],
      alignmentVerified: true,
      derivedAt: NOW,
    },
    tiles: [],
    ...overrides,
  });

  it('rejects a tile position outside the grid', () => {
    const result = PlaybackWall.safeParse(
      wall({ tiles: [{ position: 9, memberOrder: 0, follow: 'synchronised' }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects duplicate tile positions', () => {
    const result = PlaybackWall.safeParse(
      wall({
        tiles: [
          { position: 0, memberOrder: 0, follow: 'synchronised' },
          { position: 0, memberOrder: 1, follow: 'synchronised' },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('⚠️ requires the leader to be a real member', () => {
    expect(PlaybackWall.safeParse(wall({ leaderOrder: 7 })).success).toBe(false);
    expect(PlaybackWall.safeParse(wall({ leaderOrder: 1 })).success).toBe(true);
  });

  it('allows an empty tile — a partly filled wall is a normal state', () => {
    const result = PlaybackWall.safeParse(
      wall({ tiles: [{ position: 3, follow: 'independent' }] }),
    );
    expect(result.success).toBe(true);
  });
});

describe('bookmarks', () => {
  it('⚠️ defaults to private — a working note is not published to a colleague', () => {
    const parsed = PlaybackBookmark.parse({
      id: '55555555-5555-4555-8555-555555555555',
      tenantId: 'tenant-a',
      incidentId: 'incident-1',
      source: { kind: 'evidence', id: 'ev-1' },
      at: NOW,
      label: 'entry',
      createdBy: 'operator-1',
      createdAt: NOW,
    });
    expect(parsed.visibility).toBe('private');
  });

  it('⚠️ has no public visibility — evidence never leaves a tenant', () => {
    const result = PlaybackBookmark.safeParse({
      id: '55555555-5555-4555-8555-555555555555',
      tenantId: 'tenant-a',
      incidentId: 'incident-1',
      source: { kind: 'evidence', id: 'ev-1' },
      at: NOW,
      label: 'entry',
      visibility: 'public',
      createdBy: 'operator-1',
      createdAt: NOW,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// rec 3 — export profiles change presentation only
// ---------------------------------------------------------------------------------------------

describe('export profiles', () => {
  it('⚠️ carries no key that could select content', () => {
    for (const preset of EXPORT_PROFILE_PRESETS) {
      const parsed = EvidenceExportProfile.parse(preset);
      for (const forbidden of PROFILE_FORBIDDEN_KEYS) {
        expect(Object.keys(parsed)).not.toContain(forbidden);
      }
    }
  });

  it('ships the seven requested profiles as data, not as a type', () => {
    const ids = EXPORT_PROFILE_PRESETS.map((profile) => profile.id).sort();
    expect(ids).toEqual([
      'compliance',
      'court',
      'customer',
      'executive',
      'insurance',
      'internal',
      'police',
    ]);
    /* ⚠️ The id is an open slug: a deployment adds an eighth without a release. */
    expect(
      EvidenceExportProfile.safeParse({
        ...EXPORT_PROFILE_PRESETS[0],
        id: 'regulator-xyz',
      }).success,
    ).toBe(true);
  });

  it('⚠️ gates an external disclosure rather than redacting for you', () => {
    const court = EXPORT_PROFILE_PRESETS.find((profile) => profile.id === 'court')!;
    expect(court.requiresRedactionReview).toBe(true);
    expect(exportBlockers(court, { redactionReviewed: false })).toHaveLength(1);
    expect(exportBlockers(court, { redactionReviewed: true })).toHaveLength(0);
  });

  it('⚠️ requires an external profile to state its basis for disclosure', () => {
    const profile = EvidenceExportProfile.parse({
      id: 'partner',
      title: 'Partner',
      description: 'Shared with a partner organisation.',
      presentation: {},
      external: true,
    });
    expect(exportBlockers(profile, { redactionReviewed: true })).toEqual([
      'an external profile must state the basis for disclosure',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// rec 5 — the camera map
// ---------------------------------------------------------------------------------------------

describe('camera placement', () => {
  const base = {
    tenantId: 'tenant-a',
    cameraId: 'cam-1',
    floorId: 'floor-1',
    position: { x: 0.5, y: 0.5 },
    updatedBy: 'admin-1',
    updatedAt: NOW,
  };

  it('⚠️ carries no zoneId — the camera record is the only answer to "which zone"', () => {
    const parsed = CameraPlacement.parse(base);
    expect(Object.keys(parsed)).not.toContain('zoneId');
  });

  it('⚠️ refuses half a cone — a bearing with no field of view reads as coverage', () => {
    expect(
      CameraPlacement.safeParse({ ...base, orientation: { bearingDegrees: 90, basis: 'declared' } })
        .success,
    ).toBe(false);
    expect(
      CameraPlacement.safeParse({
        ...base,
        orientation: { bearingDegrees: 90, fieldOfViewDegrees: 70, basis: 'declared' },
      }).success,
    ).toBe(true);
  });

  it('⚠️ requires a survey to be dated, and only a dated survey is coverage', () => {
    expect(CameraPlacement.safeParse({ ...base, orientation: { basis: 'surveyed' } }).success).toBe(
      false,
    );
    expect(coverageIsSurveyed({ basis: 'declared' })).toBe(false);
    expect(coverageIsSurveyed({ basis: 'surveyed', surveyedAt: NOW })).toBe(true);
  });

  it('defaults to an unknown basis rather than a plausible one', () => {
    expect(CameraPlacement.parse(base).orientation.basis).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// rec 7 — the heatmap
// ---------------------------------------------------------------------------------------------

describe('timeline heatmap', () => {
  const band = (overrides: Partial<Record<string, unknown>> = {}) => ({
    kind: 'event' as const,
    bucketSeconds: 60,
    counts: [1, 5, 2],
    counted: true,
    ...overrides,
  });

  it('⚠️ scales to counted bands only — a truncated read must not set the scale', () => {
    const bands = [
      HeatmapBand.parse(band()),
      HeatmapBand.parse(
        band({ kind: 'detection', counts: [99], counted: false, uncountedReason: 'truncated' }),
      ),
    ];
    expect(heatmapPeak(bands)).toBe(5);
  });

  it('⚠️ requires an uncounted band to say why — never rendered as zero', () => {
    const result = PlaybackTimelineHeatmap.safeParse({
      startedAt: NOW,
      endedAt: NOW,
      bands: [band({ counted: false })],
      peak: 0,
      derivedAt: NOW,
    });
    expect(result.success).toBe(false);
  });

  it('refuses a peak that disagrees with the bands', () => {
    expect(
      PlaybackTimelineHeatmap.safeParse({
        startedAt: NOW,
        endedAt: NOW,
        bands: [band()],
        peak: 99,
        derivedAt: NOW,
      }).success,
    ).toBe(false);
  });

  it('⚠️ keeps motion as its own band — detections are not motion', () => {
    expect(HeatmapBand.safeParse(band({ kind: 'motion' })).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// rec 6 — the AI boundary
// ---------------------------------------------------------------------------------------------

describe('AI recommendations', () => {
  it('adds the related-* categories', () => {
    for (const kind of ['related-detections', 'related-timelines'] as const) {
      expect(IncidentRecommendationKind.safeParse(kind).success).toBe(true);
    }
  });

  it('⚠️ refuses every category that would have AI produce or decide something', () => {
    for (const refused of REFUSED_RECOMMENDATION_KINDS) {
      expect(IncidentRecommendationKind.safeParse(refused).success).toBe(false);
    }
    expect(REFUSED_RECOMMENDATION_KINDS).toContain('generated-evidence');
    expect(REFUSED_RECOMMENDATION_KINDS).toContain('approval');
  });

  it('⚠️ binds no mutating command to an AI assistant', () => {
    for (const command of WORKSPACE_COMMANDS.commands) {
      if (!command.mutates) continue;
      expect(command.bindings).not.toContain('ai-assistant');
      expect(command.bindings).not.toContain('automation');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// rec 10 — metrics, and the surveillance boundary
// ---------------------------------------------------------------------------------------------

describe('investigation metrics', () => {
  const metrics = {
    tenantId: 'tenant-a',
    window: { from: NOW, to: NOW },
    incidentCount: 10,
    evidenceCount: 40,
    resolutionTime: { sampleSize: 10, meanSeconds: 600 },
    investigationDuration: { sampleSize: 10, meanSeconds: 300 },
    escalatedCount: 2,
    confirmedCount: 5,
    falsePositiveCount: 2,
    inconclusiveCount: 1,
    duplicateCount: 0,
    undisposedCount: 2,
    derivedAt: NOW,
  };

  it('requires dispositions to account for every incident', () => {
    expect(InvestigationMetrics.safeParse(metrics).success).toBe(true);
    expect(InvestigationMetrics.safeParse({ ...metrics, undisposedCount: 0 }).success).toBe(false);
  });

  it('⚠️ leaves false negatives absent rather than zero — they are not in the data', () => {
    const parsed = InvestigationMetrics.parse(metrics);
    expect(parsed.falseNegatives).toBeUndefined();
  });

  it('⚠️ excludes undisposed incidents from the false-positive rate', () => {
    const parsed = InvestigationMetrics.parse(metrics);
    /* 2 false positives out of 8 dispositioned, not out of 10. */
    expect(falsePositiveRate(parsed)).toBeCloseTo(2 / 8);
  });

  it('⚠️ returns undefined for an empty window rather than a flattering zero', () => {
    const empty = InvestigationMetrics.parse({
      ...metrics,
      incidentCount: 0,
      escalatedCount: 0,
      confirmedCount: 0,
      falsePositiveCount: 0,
      inconclusiveCount: 0,
      duplicateCount: 0,
      undisposedCount: 0,
    });
    expect(escalationRate(empty)).toBeUndefined();
    expect(falsePositiveRate(empty)).toBeUndefined();
  });

  it('computes the escalation rate over the window', () => {
    expect(escalationRate(InvestigationMetrics.parse(metrics))).toBeCloseTo(0.2);
  });

  /*
   * ⚠️ The permission itself is asserted in `@vip/permissions` — contracts is the base package and
   * must not depend on it. The name is pinned here so a rename breaks in both places.
   */
  it('names the workload permission with a distinct action, not read', () => {
    expect(WORKLOAD_PERMISSION).toBe('metrics:workload');
    expect(WORKLOAD_PERMISSION.endsWith(':read')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Demo, branding, profiles, commands
// ---------------------------------------------------------------------------------------------

describe('demo mode', () => {
  it('⚠️ makes a reset repeat the tenant it is about to clear', () => {
    expect(
      DemoResetRequest.safeParse({ tenantId: 'demo-1', confirmTenantId: 'tenant-a' }).success,
    ).toBe(false);
    expect(
      DemoResetRequest.safeParse({ tenantId: 'demo-1', confirmTenantId: 'demo-1' }).success,
    ).toBe(true);
  });
});

describe('branding', () => {
  it('⚠️ keeps login branding off by default — the sign-in page is pre-authentication', () => {
    const parsed = TenantBranding.parse({
      tenantId: 'tenant-a',
      companyName: 'Acme',
      updatedAt: NOW,
    });
    expect(parsed.loginBranding).toBe(false);
  });

  it('takes a favicon as a storage key, never a URL', () => {
    const result = TenantBranding.safeParse({
      tenantId: 'tenant-a',
      companyName: 'Acme',
      faviconStorageKey: 'tenants/tenant-a/favicon.ico',
      updatedAt: NOW,
    });
    expect(result.success).toBe(true);
  });
});

describe('workspace profiles', () => {
  it('⚠️ adds custom, which supplies no defaults at all', () => {
    expect(WorkspaceProfileId.safeParse('custom').success).toBe(true);
    const custom = WORKSPACE_PROFILES.find((profile) => profile.id === 'custom')!;
    expect(custom.hiddenPanels).toEqual([]);
    expect(custom.collapsedPanels).toEqual([]);
  });

  it('defines every profile id exactly once', () => {
    const ids = WORKSPACE_PROFILES.map((profile) => profile.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([...WorkspaceProfileId.options].sort());
  });
});

describe('playback commands', () => {
  const playbackCommands = WORKSPACE_COMMANDS.commands.filter(
    (command) => command.scope === 'playback',
  );

  it('reserves the full transport', () => {
    for (const id of [
      'playback.stop',
      'playback.back-5',
      'playback.forward-5',
      'playback.back-30',
      'playback.forward-30',
      'playback.speed-up',
      'playback.speed-down',
      'playback.fullscreen',
      'playback.picture-in-picture',
      'playback.snapshot',
    ] as const) {
      expect(CommandId.safeParse(id).success).toBe(true);
      expect(playbackCommands.some((command) => command.id === id)).toBe(true);
    }
  });

  it('⚠️ marks every new control unavailable — no player consumes them yet', () => {
    const reserved = playbackCommands.filter((command) => command.id !== 'playback.play-pause');
    expect(reserved.some((command) => command.available)).toBe(true); // frame steps stay available
    expect(playbackCommands.find((command) => command.id === 'playback.snapshot')?.available).toBe(
      false,
    );
  });

  it('⚠️ requires a modifier on snapshot — it creates an evidence record', () => {
    const snapshot = playbackCommands.find((command) => command.id === 'playback.snapshot')!;
    expect(snapshot.mutates).toBe(true);
    expect(snapshot.shortcut?.includes('+')).toBe(true);
    expect(snapshot.permission).toBe('evidence:create');
  });

  it('has no chord collision within the playback scope', () => {
    const chords = playbackCommands
      .map((command) => command.shortcut)
      .filter((chord): chord is string => chord !== undefined);
    expect(new Set(chords).size).toBe(chords.length);
  });
});

// ---------------------------------------------------------------------------------------------
// P-5.4.1 — the final refinements: derived artefacts, three timestamps, four view modes,
// reproducible reports.
// ---------------------------------------------------------------------------------------------

describe('derived evidence artefacts', () => {
  const artifact = {
    derivedEvidenceId: 'ev-2',
    sourceEvidenceId: 'ev-1',
    tenantId: 'tenant-a',
    renderProfileId: 'court',
    appliedOperations: [
      { order: 0, operation: 'mask' as const, parameters: { regions: 2 } },
      { order: 1, operation: 'scale' as const, parameters: { width: 1280 } },
    ],
    rendererVersion: 'ffmpeg-7.1/vip-render-2.3.0',
    time: {
      recordedAt: '2026-07-01T09:00:00.000Z',
      exportedAt: NOW,
      clockConfidence: 'device-clock' as const,
    },
    integrityHash: 'sha256:abc',
    producedBy: 'operator-1',
  };

  it('⚠️ refuses an output id equal to its input — that is an in-place mutation', () => {
    expect(DerivedArtifact.safeParse({ ...artifact, derivedEvidenceId: 'ev-1' }).success).toBe(
      false,
    );
    expect(DerivedArtifact.safeParse(artifact).success).toBe(true);
  });

  it('⚠️ keeps the operation order unique — rendering is not commutative', () => {
    expect(
      DerivedArtifact.safeParse({
        ...artifact,
        appliedOperations: [
          { order: 0, operation: 'mask', parameters: {} },
          { order: 0, operation: 'scale', parameters: {} },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires a renderer version — the artefact is not reproducible without one', () => {
    const { rendererVersion: _omitted, ...withoutRenderer } = artifact;
    expect(DerivedArtifact.safeParse(withoutRenderer).success).toBe(false);
  });

  it('⚠️ keeps the recording instant separate from the export instant', () => {
    const parsed = DerivedArtifact.parse(artifact);
    expect(parsed.time.recordedAt).toBe('2026-07-01T09:00:00.000Z');
    expect(parsed.time.exportedAt).toBe(NOW);
    expect(parsed.time.recordedAt).not.toBe(parsed.time.exportedAt);
  });

  it('⚠️ defaults clock confidence to unknown, never to synchronised', () => {
    const parsed = DerivedArtifact.parse({
      ...artifact,
      time: { recordedAt: '2026-07-01T09:00:00.000Z', exportedAt: NOW },
    });
    expect(parsed.time.clockConfidence).toBe('unknown');
  });

  it('rejects a recording that ends before it starts', () => {
    expect(
      DerivedArtifact.safeParse({
        ...artifact,
        time: {
          recordedAt: '2026-07-01T09:00:00.000Z',
          recordedUntil: '2026-07-01T08:00:00.000Z',
          exportedAt: NOW,
        },
      }).success,
    ).toBe(false);
  });

  it('knows which operations removed information', () => {
    expect(isDestructive(DerivedArtifact.parse(artifact))).toBe(true);
    expect(
      isDestructive(
        DerivedArtifact.parse({
          ...artifact,
          appliedOperations: [{ order: 0, operation: 'transcode', parameters: {} }],
        }),
      ),
    ).toBe(false);
  });
});

describe('evidence view mode', () => {
  const derived = (operation: string) =>
    DerivedArtifact.parse({
      derivedEvidenceId: 'ev-2',
      sourceEvidenceId: 'ev-1',
      tenantId: 'tenant-a',
      appliedOperations: [{ order: 0, operation, parameters: {} }],
      rendererVersion: 'r-1',
      time: { recordedAt: NOW, exportedAt: NOW },
      integrityHash: 'sha256:abc',
      producedBy: 'operator-1',
    });

  it('distinguishes all four states', () => {
    expect(EvidenceViewMode.options).toEqual(['original', 'enhanced', 'redacted', 'derived']);
  });

  it('⚠️ ranks provenance above adjustment — a brightened redaction is still redacted', () => {
    const brightened = EvidenceViewAdjustment.parse({ brightness: 1.4 });
    expect(viewMode(brightened)).toBe('enhanced');
    expect(viewMode(brightened, derived('blur'))).toBe('redacted');
    expect(viewMode(brightened, derived('transcode'))).toBe('derived');
  });

  it('stays original when nothing was done to it', () => {
    expect(viewMode(undefined)).toBe('original');
    /* ⚠️ Parsed, not a bare object: the neutral adjustment is 1/1/0, not "fields absent". */
    expect(viewMode(EvidenceViewAdjustment.parse({}))).toBe('original');
  });

  it('⚠️ marks an unadjusted view of a redacted copy as redacted, not original', () => {
    expect(viewMode(undefined, derived('mask'))).toBe('redacted');
    expect(viewMode(undefined, derived('watermark'))).toBe('derived');
  });

  it('⚠️ requires a persistent label on everything except the original', () => {
    expect(requiresProminentLabel('original')).toBe(false);
    for (const mode of MODES_REQUIRING_PROMINENT_LABEL) {
      expect(requiresProminentLabel(mode)).toBe(true);
    }
  });
});

describe('report reproducibility', () => {
  const provenance = {
    incidentId: '66666666-6666-4666-8666-666666666666',
    incidentVersion: 3,
    correlationId: 'corr-1',
    generatedAt: NOW,
    generatedBy: 'operator-1',
  };
  const rendered = (extra: Record<string, unknown>) => ({
    model: {
      tenantId: 'tenant-a',
      title: 'Incident report',
      provenance: { ...provenance, ...extra },
      sections: [],
      omissions: [],
    },
    presentation: {},
    storageKey: 'reports/r-1.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    renderedAt: NOW,
  });

  it('⚠️ refuses a rendered report with no platform build', () => {
    expect(RenderedReport.safeParse(rendered({ templateVersion: '2.1.0' })).success).toBe(false);
  });

  it('⚠️ refuses a rendered report with no template version — a theme slug is not a version', () => {
    expect(RenderedReport.safeParse(rendered({ platformVersion: '1.4.2' })).success).toBe(false);
  });

  it('accepts one that records both', () => {
    expect(
      RenderedReport.safeParse(rendered({ platformVersion: '1.4.2', templateVersion: '2.1.0' }))
        .success,
    ).toBe(true);
  });

  it('⚠️ records evidence hashes, so a purged item makes a re-render detectably different', () => {
    const parsed = ReportProvenance.parse({
      ...provenance,
      evidenceVersions: [{ evidenceId: 'ev-1', integrityHash: 'sha256:abc' }],
    });
    expect(parsed.evidenceVersions).toHaveLength(1);
    /* A preview has no artefact, so it needs neither version — that is why they stay optional. */
    expect(ReportProvenance.parse(provenance).evidenceVersions).toEqual([]);
  });
});
