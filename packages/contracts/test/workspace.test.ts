/**
 * P-5.2.0 — the Investigation Workspace freeze.
 *
 * These tests exist to make the *decisions* enforceable, not to re-check that Zod parses objects.
 * Each one corresponds to a rule stated in a contract's header, and each fails on the specific
 * mistake that rule was written to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_WORKSPACE_LAYOUT,
  WorkspaceLayout,
  WorkspacePanel,
  WorkspacePanelId,
  WorkspaceRegion,
  regionAxis,
} from '../src/workspace/workspace.js';
import {
  CommandId,
  CommandRegistry,
  KeyChord,
  WORKSPACE_COMMANDS,
  forbiddenBindings,
  hasModifier,
} from '../src/workspace/commands.js';
import {
  WORKSPACE_STATE_SCHEMA_VERSION,
  WorkspaceUiState,
  workspaceStateKey,
} from '../src/workspace/state.js';

const panel = {
  id: 'timeline' as const,
  region: 'center' as const,
  order: 0,
  title: 'Timeline',
  source: 'workflow' as const,
  permission: 'incident:read',
  availability: 'available' as const,
  persistenceKey: 'vip.workspace.timeline',
};

describe('WorkspaceLayout — the frozen layout', () => {
  it('parses, and every panel in the register is present', () => {
    const parsed = WorkspaceLayout.parse(INVESTIGATION_WORKSPACE_LAYOUT);
    const ids = parsed.panels.map((p) => p.id).sort();
    expect(ids).toEqual([...WorkspacePanelId.options].sort());
  });

  it('has exactly the four approved regions, each populated', () => {
    const regions = new Set(INVESTIGATION_WORKSPACE_LAYOUT.panels.map((p) => p.region));
    expect([...regions].sort()).toEqual([...WorkspaceRegion.options].sort());
  });

  /*
   * The reason `availability` exists. A deferred panel that renders an empty box asserts "there is
   * nothing here" — a different and false claim from "nothing has produced this".
   */
  it('refuses a deferred panel that does not say why', () => {
    const result = WorkspaceLayout.safeParse({
      version: 1,
      panels: [{ ...panel, availability: 'deferred' }],
    });
    expect(result.success).toBe(false);
  });

  it('states a reason for every panel that is not available', () => {
    for (const p of INVESTIGATION_WORKSPACE_LAYOUT.panels) {
      if (p.availability !== 'available') expect(p.unavailableReason).toBeTruthy();
    }
  });

  it('⚠️ never claims "no AI recommendations" — it says nothing has analysed the incident', () => {
    const ai = INVESTIGATION_WORKSPACE_LAYOUT.panels.find((p) => p.id === 'ai-recommendations');
    expect(ai?.availability).toBe('deferred');
    expect(ai?.unavailableReason).toContain('nothing has analysed');
  });

  it('refuses two panels sharing a persistence key (silent state clobbering)', () => {
    const result = WorkspaceLayout.safeParse({
      version: 1,
      panels: [panel, { ...panel, id: 'comments', region: 'right' }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses size bounds on a panel that cannot be resized', () => {
    const result = WorkspaceLayout.safeParse({
      version: 1,
      panels: [{ ...panel, resizable: false, minSizePx: 100 }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses minSizePx above maxSizePx', () => {
    const result = WorkspaceLayout.safeParse({
      version: 1,
      panels: [{ ...panel, minSizePx: 500, maxSizePx: 100 }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a panel that may not dock in its own default region', () => {
    const result = WorkspaceLayout.safeParse({
      version: 1,
      panels: [{ ...panel, allowedRegions: ['left', 'right'] }],
    });
    expect(result.success).toBe(false);
  });

  it('requires a namespaced persistence key', () => {
    expect(WorkspacePanel.safeParse({ ...panel, persistenceKey: 'timeline' }).success).toBe(false);
    /* ⚠️ A key carrying the layout version would reset every operator's layout on the next panel. */
    expect(
      WorkspacePanel.safeParse({ ...panel, persistenceKey: 'vip.workspace.timeline' }).success,
    ).toBe(true);
  });

  it('resizes the bottom dock vertically and the side docks horizontally', () => {
    expect(regionAxis('bottom')).toBe('vertical');
    expect(regionAxis('left')).toBe('horizontal');
    expect(regionAxis('right')).toBe('horizontal');
    expect(regionAxis('center')).toBe('horizontal');
  });

  it('keeps the panels an operator cannot work without', () => {
    const queue = INVESTIGATION_WORKSPACE_LAYOUT.panels.find((p) => p.id === 'incident-queue');
    expect(queue?.hideable).toBe(false);
    expect(queue?.collapsible).toBe(false);
  });
});

describe('CommandRegistry — one registry, not two', () => {
  it('parses the frozen registry', () => {
    expect(() => CommandRegistry.parse(WORKSPACE_COMMANDS)).not.toThrow();
  });

  it('registers every command id exactly once', () => {
    const ids = WORKSPACE_COMMANDS.commands.map((c) => c.id).sort();
    expect(ids).toEqual([...CommandId.options].sort());
  });

  /*
   * Rule 1. `r` for Resolve is one keystroke from a state change whenever focus is not in a text
   * field — and focus leaves a text field constantly in an investigation UI.
   */
  it('⚠️ refuses a bare key on a mutating command', () => {
    const result = CommandRegistry.safeParse({
      version: 1,
      commands: [
        {
          id: 'incident.resolve',
          title: 'Resolve',
          category: 'incident',
          scope: 'workspace',
          permission: 'incident:resolve',
          mutates: true,
          shortcut: 'R',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('every mutating command in the frozen registry carries a modifier', () => {
    for (const command of WORKSPACE_COMMANDS.commands) {
      if (command.mutates && command.shortcut !== undefined) {
        expect(hasModifier(command.shortcut)).toBe(true);
      }
    }
  });

  it('refuses the same chord twice in one scope (a silent conflict)', () => {
    const result = CommandRegistry.safeParse({
      version: 1,
      commands: [
        {
          id: 'search.open',
          title: 'Search',
          category: 'search',
          scope: 'global',
          permission: 'incident:read',
          shortcut: 'Mod+K',
        },
        {
          id: 'command-palette.open',
          title: 'Palette',
          category: 'navigation',
          scope: 'global',
          permission: 'incident:read',
          shortcut: 'Mod+K',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a scoped chord already claimed globally (global shadows everything)', () => {
    const result = CommandRegistry.safeParse({
      version: 1,
      commands: [
        {
          id: 'command-palette.open',
          title: 'Palette',
          category: 'navigation',
          scope: 'global',
          permission: 'incident:read',
          shortcut: 'Mod+K',
        },
        {
          id: 'workspace.open-timeline',
          title: 'Timeline',
          category: 'navigation',
          scope: 'workspace',
          permission: 'incident:read',
          shortcut: 'Mod+K',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('allows one chord in two disjoint scopes (ArrowLeft means different things)', () => {
    const result = CommandRegistry.safeParse({
      version: 1,
      commands: [
        {
          id: 'playback.previous-frame',
          title: 'Previous Frame',
          category: 'playback',
          scope: 'playback',
          permission: 'stream:read',
          shortcut: 'ArrowLeft',
        },
        {
          id: 'workspace.open-incident-queue',
          title: 'Queue',
          category: 'navigation',
          scope: 'queue',
          permission: 'incident:read',
          shortcut: 'ArrowLeft',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('⚠️ writes chords as Mod, not Ctrl — Ctrl ships the wrong key to macOS', () => {
    for (const command of WORKSPACE_COMMANDS.commands) {
      if (command.shortcut !== undefined) expect(command.shortcut).not.toMatch(/^Ctrl\+/);
    }
    expect(KeyChord.safeParse('Mod+Shift+E').success).toBe(true);
    expect(KeyChord.safeParse('Meta+E').success).toBe(false);
    expect(KeyChord.safeParse('Mod+').success).toBe(false);
  });

  it('every command names a permission, so the palette can omit what a principal cannot do', () => {
    for (const command of WORKSPACE_COMMANDS.commands) {
      expect(command.permission).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });
});

describe('WorkspaceUiState — references, never records', () => {
  const state = {
    schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
    tenantId: 'tnt_a',
    principalId: 'usr_1',
    layoutVersion: 1,
    updatedAt: '2026-08-03T00:00:00.000Z',
  };

  it('parses and defaults the collections', () => {
    const parsed = WorkspaceUiState.parse(state);
    expect(parsed.panels).toEqual([]);
    expect(parsed.tabs).toEqual([]);
    expect(parsed.view).toEqual({});
  });

  /*
   * ⚠️ The core rule, asserted structurally: a tab is an id and a timestamp. There is nowhere to
   * cache a title, which is what would survive the operator losing access to the incident.
   */
  it('a tab carries an id and a time, and nothing that can go stale', () => {
    const parsed = WorkspaceUiState.parse({
      ...state,
      tabs: [
        { incidentId: 'inc_1', openedAt: '2026-08-03T00:00:00.000Z', title: 'Loitering at Dock 3' },
      ],
    });
    expect(parsed.tabs[0]).toEqual({
      incidentId: 'inc_1',
      openedAt: '2026-08-03T00:00:00.000Z',
    });
    expect(parsed.tabs[0]).not.toHaveProperty('title');
  });

  it('scopes the storage key by tenant and principal, not by a field a reader must remember', () => {
    expect(workspaceStateKey('tnt_a', 'usr_1')).toBe('vip.workspace.state.tnt_a.usr_1');
    expect(workspaceStateKey('tnt_a', 'usr_1')).not.toBe(workspaceStateKey('tnt_b', 'usr_1'));
  });

  /*
   * ⚠️ The two counters have now genuinely diverged: P-5.3 added two panels (layout v2) and did not
   * change the persisted shape (schema v1). That is exactly the independence they exist for — a
   * single counter would have discarded every operator's saved sizes to add a panel.
   */
  it('⚠️ keeps the state schema version independent of the layout version', () => {
    expect(WORKSPACE_STATE_SCHEMA_VERSION).toBe(1);
    expect(INVESTIGATION_WORKSPACE_LAYOUT.version).toBeGreaterThan(WORKSPACE_STATE_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------------------------
// P-5.2 recs 1, 2, 5 — dock priority, multi-monitor reservation, and binding kinds.
// ---------------------------------------------------------------------------------------------

describe('P-5.2 rec 1 — responsive drop order is data, not a table in a document', () => {
  it('gives every panel a priority', () => {
    for (const p of INVESTIGATION_WORKSPACE_LAYOUT.panels) {
      expect(p.priority, `${p.id} needs a drop priority`).toBeGreaterThanOrEqual(0);
    }
  });

  /*
   * ⚠️ A panel that cannot be hidden cannot be dropped. Without this rule the responsive behaviour
   * contradicts itself, and the resolution is decided by whichever code path runs first.
   */
  it('⚠️ refuses a non-hideable panel that is not one of the first to survive', () => {
    const result = WorkspaceLayout.safeParse({
      version: 1,
      panels: [{ ...panel, hideable: false, priority: 90 }],
    });
    expect(result.success).toBe(false);
  });

  it('drops the deferred panels first and the queue last', () => {
    const byPriority = [...INVESTIGATION_WORKSPACE_LAYOUT.panels].sort(
      (a, b) => a.priority - b.priority,
    );
    expect(byPriority[0]?.id).toBe('incident-queue');
    expect(byPriority.at(-1)?.id).toBe('ai-recommendations');
  });
});

describe('P-5.2 rec 2 — multi-monitor is reserved, and detaching is not floating', () => {
  it('models detaching separately from floating', () => {
    const evidence = INVESTIGATION_WORKSPACE_LAYOUT.panels.find((p) => p.id === 'evidence-viewer');
    expect(evidence?.detachable).toBe(true);
    const comments = INVESTIGATION_WORKSPACE_LAYOUT.panels.find((p) => p.id === 'comments');
    /* Floating within the grid and crossing a window boundary are different problems. */
    expect(comments?.detachable).toBe(false);
    expect(comments?.floatable).toBe(false);
  });

  it('reserves detaching only for the panels a second monitor is actually for', () => {
    const detachable = INVESTIGATION_WORKSPACE_LAYOUT.panels
      .filter((p) => p.detachable)
      .map((p) => p.id)
      .sort();
    expect(detachable).toEqual(['evidence-viewer', 'incident-queue', 'video-playback']);
  });
});

describe('P-5.2 rec 5 — one registry, many bindings, and the AI boundary holds', () => {
  it('defaults to the two surfaces that exist', () => {
    const parsed = CommandRegistry.parse({
      version: 1,
      commands: [
        {
          id: 'search.open',
          title: 'Search',
          category: 'search',
          scope: 'global',
          permission: 'incident:read',
        },
      ],
    });
    expect(parsed.commands[0]?.bindings).toEqual(['keyboard', 'palette']);
  });

  /*
   * ⚠️ The reason this rule is in the schema. P-5.1 locked the AI boundary in the permission catalog
   * and a domain guard; a binding surface is a third way past both, and it is the one that reads
   * like UI plumbing rather than like authorising an AI to close an incident.
   */
  it('⚠️ refuses an ai-assistant binding on a mutating command', () => {
    const result = CommandRegistry.safeParse({
      version: 1,
      commands: [
        {
          id: 'incident.resolve',
          title: 'Resolve Incident',
          category: 'incident',
          scope: 'workspace',
          permission: 'incident:resolve',
          mutates: true,
          bindings: ['keyboard', 'palette', 'ai-assistant'],
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('advisory');
  });

  it('⚠️ refuses an automation binding on a mutating command for the same reason', () => {
    expect(forbiddenBindings(true, ['automation', 'keyboard'])).toEqual(['automation']);
    expect(forbiddenBindings(false, ['automation', 'ai-assistant'])).toEqual([]);
  });

  it('allows an AI assistant to invoke read-only commands', () => {
    const result = CommandRegistry.safeParse({
      version: 1,
      commands: [
        {
          id: 'search.incident',
          title: 'Search Incidents',
          category: 'search',
          scope: 'global',
          permission: 'incident:read',
          mutates: false,
          bindings: ['keyboard', 'palette', 'ai-assistant', 'voice'],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('binds no mutating command in the frozen registry to AI or automation', () => {
    for (const command of WORKSPACE_COMMANDS.commands) {
      expect(forbiddenBindings(command.mutates, command.bindings)).toEqual([]);
    }
  });
});

describe('P-5.2 rec 4 — the investigation session persists references and view state only', () => {
  const state = {
    schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
    tenantId: 'tnt_a',
    principalId: 'usr_1',
    layoutVersion: 1,
    updatedAt: '2026-08-03T00:00:00.000Z',
  };

  it('carries playback rate, camera, zoom and bookmark ids', () => {
    const parsed = WorkspaceUiState.parse({
      ...state,
      view: {
        playbackRate: 4,
        selectedCameraId: 'cam_1',
        viewerZoom: 2,
        currentIncidentId: 'inc_1',
      },
      bookmarkIds: ['11111111-1111-4111-8111-111111111111'],
    });
    expect(parsed.view.playbackRate).toBe(4);
    expect(parsed.view.selectedCameraId).toBe('cam_1');
    expect(parsed.bookmarkIds).toHaveLength(1);
  });

  /* ⚠️ Still no room for a record — bookmarks are ids, resolved on restore. */
  it('⚠️ strips a cached bookmark record, keeping only the id', () => {
    const parsed = WorkspaceUiState.parse({
      ...state,
      bookmarkIds: ['11111111-1111-4111-8111-111111111111'],
      bookmarks: [{ id: 'x', label: 'suspect enters' }],
    });
    expect(parsed).not.toHaveProperty('bookmarks');
  });
});
