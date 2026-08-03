/**
 * P-5.2 — the Investigation Workspace.
 *
 * These test the rules, not the pixels: the layout comes from the frozen registry, a panel the
 * principal cannot see is *absent* rather than disabled, an unavailable panel never renders as
 * empty, and persisted state that cannot be trusted is discarded **and reported**.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { http as mswHttp, HttpResponse } from 'msw';
import {
  INVESTIGATION_WORKSPACE_LAYOUT,
  WORKSPACE_COMMANDS,
  workspaceStateKey,
} from '@vip/contracts';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { resolveLayout, viewportTier } from './layout';
import { useWorkspaceState } from './useWorkspaceState';
import { displayChord, matchesChord } from './useCommands';
import { PANEL_BODIES } from './panels';
import { UnavailableState } from '@/ui';

const allow = () => true;

describe('layout resolution — the registry drives the workspace', () => {
  it('places every panel from the contract into its region', () => {
    const layout = resolveLayout({ can: allow, tier: 'wide' });
    const placed = Object.values(layout.regions).flat().length;
    expect(placed).toBe(INVESTIGATION_WORKSPACE_LAYOUT.panels.length);
    expect(layout.dropped).toEqual([]);
  });

  /*
   * ⚠️ Omitted, not disabled. A greyed-out "AI Recommendations" tells a viewer exactly which
   * capabilities exist and which roles hold them.
   */
  it('⚠️ omits a panel whose permission the principal lacks', () => {
    const layout = resolveLayout({
      can: (permission) => permission !== 'evidence:read',
      tier: 'wide',
    });
    const ids = Object.values(layout.regions)
      .flat()
      .map((resolved) => resolved.panel.id);
    expect(ids).not.toContain('evidence-viewer');
    expect(ids).toContain('incident-queue');
  });

  it('carries the registry’s reason onto a deferred panel, and nothing onto an available one', () => {
    const layout = resolveLayout({ can: allow, tier: 'wide' });
    const right = layout.regions.right;
    const ai = right.find((resolved) => resolved.panel.id === 'ai-recommendations');
    const details = right.find((resolved) => resolved.panel.id === 'incident-details');
    expect(ai?.unavailableReason).toContain('nothing has analysed');
    expect(details?.unavailableReason).toBeUndefined();
  });

  /* ⚠️ A size stored by an older build must not escape the current bounds. */
  it('⚠️ clamps a persisted size back into the registry’s range', () => {
    const layout = resolveLayout({
      can: allow,
      tier: 'wide',
      panelState: [{ panelId: 'incident-queue', sizePx: 4000 }],
    });
    const queue = layout.regions.left.find((r) => r.panel.id === 'incident-queue');
    expect(queue?.sizePx).toBe(520); // the registry's maxSizePx
  });

  it('ignores a hidden flag on a panel that may not be hidden', () => {
    const layout = resolveLayout({
      can: allow,
      tier: 'wide',
      panelState: [{ panelId: 'incident-queue', hidden: true }],
    });
    const ids = layout.regions.left.map((r) => r.panel.id);
    expect(ids).toContain('incident-queue');
  });

  it('drops by priority on a narrow viewport and never drops the queue', () => {
    const layout = resolveLayout({ can: allow, tier: 'laptop' });
    const ids = Object.values(layout.regions)
      .flat()
      .map((r) => r.panel.id);
    expect(layout.dropped.length).toBeGreaterThan(0);
    expect(ids).toContain('incident-queue');
    expect(ids).toContain('evidence-viewer');
    /* The deferred panels are the first to go — they carry the highest priority numbers. */
    expect(layout.dropped).toContain('ai-recommendations');
  });

  it('maps viewport widths to the documented tiers', () => {
    expect(viewportTier(2560)).toBe('wide');
    expect(viewportTier(1440)).toBe('desktop');
    expect(viewportTier(1100)).toBe('laptop');
    expect(viewportTier(800)).toBe('compact');
  });
});

describe('workspace state — a reference may be persisted; a record may not', () => {
  beforeEach(() => window.localStorage.clear());

  it('scopes storage by tenant and principal', () => {
    const { result } = renderHook(() => useWorkspaceState('tnt_a', 'usr_1'));
    act(() => result.current.openTab('inc_1'));
    expect(window.localStorage.getItem(workspaceStateKey('tnt_a', 'usr_1'))).toContain('inc_1');
    expect(window.localStorage.getItem(workspaceStateKey('tnt_b', 'usr_1'))).toBeNull();
  });

  /*
   * ⚠️ The failure this prevents: a shared control-room browser restoring the previous shift's open
   * incidents, or an id crossing a tenant boundary into a different record with the same id.
   */
  it('⚠️ discards state whose body disagrees with the key it was stored under, and says so', () => {
    window.localStorage.setItem(
      workspaceStateKey('tnt_a', 'usr_1'),
      JSON.stringify({
        schemaVersion: 1,
        tenantId: 'tnt_b',
        principalId: 'usr_1',
        layoutVersion: 1,
        panels: [],
        view: {},
        tabs: [{ incidentId: 'inc_other', openedAt: '2026-08-03T00:00:00.000Z' }],
        bookmarkIds: [],
        updatedAt: '2026-08-03T00:00:00.000Z',
      }),
    );
    const { result } = renderHook(() => useWorkspaceState('tnt_a', 'usr_1'));
    expect(result.current.state.tabs).toEqual([]);
    expect(result.current.dropped[0]?.reason).toBe('wrong-tenant');
  });

  it('⚠️ discards an incompatible schema version rather than half-applying it', () => {
    window.localStorage.setItem(
      workspaceStateKey('tnt_a', 'usr_1'),
      JSON.stringify({ schemaVersion: 99, tenantId: 'tnt_a', principalId: 'usr_1' }),
    );
    const { result } = renderHook(() => useWorkspaceState('tnt_a', 'usr_1'));
    expect(result.current.dropped[0]?.reason).toBe('stale-schema');
  });

  it('reports unreadable state instead of failing silently', () => {
    window.localStorage.setItem(workspaceStateKey('tnt_a', 'usr_1'), 'not json');
    const { result } = renderHook(() => useWorkspaceState('tnt_a', 'usr_1'));
    expect(result.current.dropped[0]?.reason).toBe('invalid');
  });

  /* ⚠️ There is nowhere to cache a title — a tab is an id and a timestamp. */
  it('⚠️ persists only ids for open tabs', () => {
    const { result } = renderHook(() => useWorkspaceState('tnt_a', 'usr_1'));
    act(() => result.current.openTab('inc_1'));
    const stored = JSON.parse(window.localStorage.getItem(workspaceStateKey('tnt_a', 'usr_1'))!);
    expect(Object.keys(stored.tabs[0]).sort()).toEqual(['incidentId', 'openedAt']);
  });

  it('remembers a collapsed panel and moves the selection when a tab closes', () => {
    const { result } = renderHook(() => useWorkspaceState('tnt_a', 'usr_1'));
    act(() => {
      result.current.openTab('inc_1');
      result.current.openTab('inc_2');
      result.current.setPanelState('comments', { collapsed: true });
    });
    act(() => result.current.closeTab('inc_2'));
    expect(result.current.state.view.currentIncidentId).toBe('inc_1');
    expect(result.current.state.panels.find((p) => p.panelId === 'comments')?.collapsed).toBe(true);
  });
});

describe('commands — one registry, resolved per platform', () => {
  function key(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
    return new KeyboardEvent('keydown', init);
  }

  it('matches a Mod chord against the platform modifier', () => {
    /* jsdom reports a non-Apple platform, so `Mod` is Ctrl here. */
    expect(matchesChord(key({ key: 'k', ctrlKey: true }), 'Mod+K')).toBe(true);
    expect(matchesChord(key({ key: 'k' }), 'Mod+K')).toBe(false);
  });

  /* ⚠️ A bare chord must not fire while a modifier is held — `Space` is not `⌘Space`. */
  it('⚠️ does not fire a bare chord when a modifier is down', () => {
    expect(matchesChord(key({ key: ' ' }), 'Space')).toBe(true);
    expect(matchesChord(key({ key: ' ', metaKey: true }), 'Space')).toBe(false);
  });

  it('requires the exact modifier set, so Mod+Shift+R is not Mod+R', () => {
    expect(matchesChord(key({ key: 'r', ctrlKey: true, shiftKey: true }), 'Mod+Shift+R')).toBe(
      true,
    );
    expect(matchesChord(key({ key: 'r', ctrlKey: true }), 'Mod+Shift+R')).toBe(false);
  });

  it('renders every frozen chord without leaking the contract spelling', () => {
    for (const command of WORKSPACE_COMMANDS.commands) {
      if (command.shortcut === undefined) continue;
      expect(displayChord(command.shortcut)).not.toContain('Mod');
    }
    expect(displayChord('Mod+Shift+E')).toBe('Ctrl+Shift+E');
    expect(displayChord('ArrowLeft')).toBe('←');
  });
});

describe('every panel in the contract has a body', () => {
  /*
   * ⚠️ The type system already enforces this — `PANEL_BODIES` is a `Record<WorkspacePanelId, …>`,
   * so adding a panel to the contract without a body fails the build rather than rendering a blank
   * rectangle a customer finds. Asserted anyway, because the guarantee is worth stating.
   */
  it('covers the registry exactly', () => {
    const registered = Object.keys(PANEL_BODIES).sort();
    const contract = INVESTIGATION_WORKSPACE_LAYOUT.panels.map((p) => p.id).sort();
    expect(registered).toEqual(contract);
  });
});

describe('the fourth render state', () => {
  /*
   * ⚠️ The whole point. "There is nothing here" and "nothing has produced this" are different
   * claims, and only the second is true of the AI panel today.
   */
  it('⚠️ renders a stated reason rather than an empty surface', () => {
    renderWithProviders(<UnavailableState reason="No AI advisor is configured." />);
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.getByText(/No AI advisor is configured/)).toBeInTheDocument();
  });
});

describe('the timeline panel tells an operator which kind of absence they are looking at', () => {
  it('⚠️ shows a forbidden gap as a permission problem, not as an outage', async () => {
    server.use(
      mswHttp.get('/api/workflow/incidents/:id', () =>
        HttpResponse.json({
          success: true,
          data: {
            id: 'inc_1',
            tenantId: 'tnt_a',
            status: 'raised',
            severity: 'critical',
            title: 'Loitering',
            category: 'perception',
            source: {
              ruleId: 'r1',
              ruleVersion: 1,
              ruleName: 'after hours',
              candidateId: '11111111-1111-4111-8111-111111111111',
              dedupKey: 'k',
            },
            triggeredBy: {
              eventId: '22222222-2222-4222-8222-222222222222',
              eventType: 'perception.person.detected',
              occurredAt: '2026-08-03T00:00:00.000Z',
            },
            matchedCount: 1,
            version: 1,
            correlationId: 'corr_1',
            causationId: '11111111-1111-4111-8111-111111111111',
            history: [],
            assignments: [],
            notes: [],
            raisedAt: '2026-08-03T00:00:00.000Z',
            updatedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
      mswHttp.get('/api/workflow/incidents/:id/timeline', () =>
        HttpResponse.json({
          success: true,
          data: {
            incidentId: 'inc_1',
            incidentVersion: 1,
            entries: [],
            sources: ['incident'],
            gaps: [
              { source: 'events', reason: 'forbidden', detail: 'not permitted to read events' },
              { source: 'evidence', reason: 'unavailable', detail: 'timed out' },
            ],
            derivedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
    );

    const Timeline = PANEL_BODIES.timeline;
    renderWithProviders(
      <Timeline
        incidentId="inc_1"
        unavailableReason={undefined}
        onSelectIncident={vi.fn()}
        filters={{}}
        setFilters={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/don’t have permission to read this context/),
    ).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/)).toBeInTheDocument();
  });
});
