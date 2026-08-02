import { afterEach, describe, expect, it, vi } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { RulesListPage } from './RulesListPage';
import { RuleEditorPage } from './RuleEditorPage';
import { ruleToFormValues, toRuleInput } from './ruleForm';

function authAs(roles: string[]) {
  store.dispatch(
    authenticated({
      user: { id: 'u', email: 'ops@tenant', roles },
      tenantId: 'tnt_acme',
      permissions: permissionsForRoles(roles),
    }),
  );
}

afterEach(() => store.dispatch(signedOut()));

const RULE = {
  id: 'rule-1',
  tenantId: 'tnt_acme',
  name: 'Loitering after hours',
  description: 'Person in zone A',
  lifecycle: 'enabled',
  priority: 200,
  version: 3,
  eventTypes: ['perception.person.detected'],
  categories: ['perception'],
  severity: 'high',
  actions: [{ type: 'raise-incident' }],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

function mockRules(rules: unknown[]) {
  server.use(
    mswHttp.get('/api/rules/rules', () => HttpResponse.json({ success: true, data: rules })),
  );
}

describe('RulesListPage', () => {
  it('lists rules with lifecycle state and offers "New rule" to an author', async () => {
    mockRules([RULE]);
    authAs(['admin']);
    renderWithProviders(<RulesListPage />, { store });

    expect(await screen.findByText('Loitering after hours')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new rule/i })).toBeInTheDocument();
  });

  it('shows an empty state when there are no rules', async () => {
    mockRules([]);
    authAs(['admin']);
    renderWithProviders(<RulesListPage />, { store });
    expect(await screen.findByText(/no rules yet/i)).toBeInTheDocument();
  });

  it('toggles lifecycle via PATCH when disabling an enabled rule', async () => {
    mockRules([RULE]);
    const patched = vi.fn();
    server.use(
      mswHttp.patch('/api/rules/rules/:id', async ({ request }) => {
        patched(await request.json());
        return HttpResponse.json({ success: true, data: { ...RULE, lifecycle: 'disabled' } });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderWithProviders(<RulesListPage />, { store });

    await user.click(await screen.findByRole('button', { name: /disable/i }));
    await waitFor(() => expect(patched).toHaveBeenCalledWith({ lifecycle: 'disabled' }));
  });
});

describe('RuleEditorPage (create)', () => {
  it('validates and POSTs a new rule', async () => {
    let created: unknown;
    server.use(
      mswHttp.post('/api/rules/rules', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ success: true, data: { ...RULE, id: 'rule-new' } });
      }),
    );
    authAs(['admin']);
    const user = userEvent.setup();
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/new' });

    await user.type(screen.getByLabelText('Name'), 'Tailgating');
    await user.click(screen.getByRole('button', { name: /create rule/i }));

    await waitFor(() => expect(created).toBeDefined());
    expect(created).toMatchObject({
      name: 'Tailgating',
      actions: [{ type: 'raise-incident' }],
    });
  });

  it('blocks an operator without rule:create', () => {
    authAs(['viewer']);
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/new' });
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
  });
});

/**
 * Rules consume the Location Hierarchy (P-4).
 *
 * The estate fixture comes from the shared MSW handlers — the same tree the Locations page and the
 * camera picker read — so a rule is scoped against the same data a customer would see.
 */
describe('rule scope and validation (P-4)', () => {
  const SCOPED_RULE = {
    ...RULE,
    scope: { nodeIds: ['on_london'], cameraIds: [] },
    resolvedScope: {
      zoneIds: ['on_lobby'],
      cameraIds: [],
      tenantWide: false,
      resolvedAt: '2026-08-02T00:00:00.000Z',
    },
  };

  function mockRule(rule: unknown) {
    server.use(
      mswHttp.get('/api/rules/rules/:id', () => HttpResponse.json({ success: true, data: rule })),
      mswHttp.get('/api/rules/rules/:id/validation', () =>
        HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            ruleVersion: 3,
            valid: true,
            verified: true,
            issues: [],
            checked: ['event-type', 'category', 'action', 'location'],
            checkedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      ),
    );
  }

  it('says plainly that an unscoped rule applies everywhere', async () => {
    authAs(['admin']);
    mockRule(RULE);
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    expect(await screen.findByText(/Everywhere in this tenant/i)).toBeInTheDocument();
  });

  it('shows the scoped location with how much sits beneath it', async () => {
    authAs(['admin']);
    mockRule(SCOPED_RULE);
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });

    // The full resolved path, from the hierarchy — not a raw id.
    expect(await screen.findByText('Acme › EMEA › London')).toBeInTheDocument();
    expect(screen.getByText(/\+1 location below/)).toBeInTheDocument();
  });

  it('surfaces a scoped location that no longer resolves, rather than hiding it', async () => {
    authAs(['admin']);
    mockRule({ ...RULE, scope: { nodeIds: ['on_ghost'], cameraIds: [] } });
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
  });

  it('adds a chosen location to the scope, and can remove it again', async () => {
    authAs(['admin']);
    mockRule(RULE);
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    await screen.findByText(/Everywhere in this tenant/i);

    await userEvent.click(screen.getByRole('combobox', { name: /location/i }));
    // "London" alone also matches the Lobby beneath it — the type suffix disambiguates.
    await userEvent.click(await screen.findByRole('option', { name: /London · Site/ }));

    expect(await screen.findByText('Acme › EMEA › London')).toBeInTheDocument();
    expect(screen.queryByText(/Everywhere in this tenant/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Remove London from the scope/ }));
    expect(await screen.findByText(/Everywhere in this tenant/i)).toBeInTheDocument();
  });

  /**
   * The form → contract mapping, tested directly.
   *
   * Driving this through a full save would depend on the editor's lifecycle/severity `Select`s, which
   * have a **pre-existing** edit-mode validation defect unrelated to P-4 (reproduced against the
   * original editor before these changes; recorded as TD-21). Testing the mapping where it lives is
   * both unaffected by that and a better test of the thing P-4 actually added.
   */
  it('maps the scope onto the contract in both directions', () => {
    const values = ruleToFormValues({
      ...RULE,
      scope: { nodeIds: ['on_london'], cameraIds: ['cam_1'] },
    } as never);
    expect(values.scopeNodeIds).toEqual(['on_london']);
    expect(values.scopeCameraIds).toEqual(['cam_1']);

    expect(toRuleInput(values).scope).toEqual({
      nodeIds: ['on_london'],
      cameraIds: ['cam_1'],
    });
  });

  it('treats a rule written before P-4 as tenant-wide rather than rejecting it', () => {
    // No `scope` field at all — an absent scope has always meant "everywhere".
    const values = ruleToFormValues(RULE as never);
    expect(values.scopeNodeIds).toEqual([]);
    expect(toRuleInput(values).scope).toEqual({ nodeIds: [], cameraIds: [] });
  });

  it('reports a clean validation', async () => {
    authAs(['admin']);
    mockRule(RULE);
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    expect(await screen.findByText(/Every reference checks out/i)).toBeInTheDocument();
  });

  it('names the blocking issue when a reference is broken', async () => {
    authAs(['admin']);
    server.use(
      mswHttp.get('/api/rules/rules/:id', () => HttpResponse.json({ success: true, data: RULE })),
      mswHttp.get('/api/rules/rules/:id/validation', () =>
        HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            ruleVersion: 3,
            valid: false,
            verified: true,
            issues: [
              {
                code: 'missing-location',
                severity: 'error',
                kind: 'location',
                message: 'location "on_ghost" does not exist in this tenant',
                ref: 'on_ghost',
              },
            ],
            checked: ['event-type', 'category', 'action', 'location'],
            checkedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      ),
    );

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    expect(await screen.findByText(/does not exist in this tenant/i)).toBeInTheDocument();
  });

  /**
   * The distinction the panel exists to make visible: **valid** is not **verified**. An author whose
   * rule will not enable, with no explanation, concludes the button is broken.
   */
  it('distinguishes "not verified" from "invalid"', async () => {
    authAs(['admin']);
    server.use(
      mswHttp.get('/api/rules/rules/:id', () => HttpResponse.json({ success: true, data: RULE })),
      mswHttp.get('/api/rules/rules/:id/validation', () =>
        HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            ruleVersion: 3,
            valid: false,
            verified: false,
            issues: [],
            checked: ['event-type'],
            checkedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      ),
    );

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText(/never activated on a check that did not run/i)).toBeInTheDocument();
  });
});

describe('rule explanation (P-4)', () => {
  function mockDryRun(explanation: unknown, matched = false) {
    server.use(
      mswHttp.get('/api/rules/rules/:id', () => HttpResponse.json({ success: true, data: RULE })),
      mswHttp.get('/api/rules/rules/:id/validation', () =>
        HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            ruleVersion: 3,
            valid: true,
            verified: true,
            issues: [],
            checked: ['event-type'],
            checkedAt: '2026-08-02T00:00:00.000Z',
          },
        }),
      ),
      mswHttp.post('/api/rules/rules/:id/dry-run', () =>
        HttpResponse.json({
          success: true,
          data: {
            matched,
            evaluation: { prefilterPassed: true, conditionPassed: false, windowPassed: true },
            explanation,
          },
        }),
      ),
    );
  }

  it('leads with the stage that decided, and the value that failed', async () => {
    authAs(['admin']);
    mockDryRun({
      ruleId: 'rule-1',
      ruleVersion: 3,
      ruleName: 'Loitering after hours',
      matched: false,
      decidedBy: 'condition',
      summary: 'confidence is 0.42, which is not at least 0.8',
      stages: {
        lifecyclePassed: true,
        scopePassed: true,
        prefilterPassed: true,
        conditionPassed: false,
        windowPassed: true,
      },
      condition: {
        kind: 'predicate',
        passed: false,
        field: 'confidence',
        op: 'gte',
        expected: 0.8,
        actual: 0.42,
        reason: 'confidence is 0.42, which is not at least 0.8',
      },
    });

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    await userEvent.click(await screen.findByRole('button', { name: /run dry run/i }));

    expect(await screen.findByText(/Did not fire — Condition/)).toBeInTheDocument();
    expect(screen.getAllByText(/0\.42/).length).toBeGreaterThan(0);
    expect(screen.getByText('decided here')).toBeInTheDocument();
  });

  it('attributes a scope miss to the scope, not the condition', async () => {
    authAs(['admin']);
    mockDryRun({
      ruleId: 'rule-1',
      ruleVersion: 3,
      ruleName: 'Loitering after hours',
      matched: false,
      decidedBy: 'scope',
      summary: 'zone zone_99 is outside the rule’s scope (1 zone(s), 0 camera(s))',
      stages: {
        lifecyclePassed: true,
        scopePassed: false,
        prefilterPassed: true,
        conditionPassed: false,
        windowPassed: true,
      },
    });

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    await userEvent.click(await screen.findByRole('button', { name: /run dry run/i }));

    expect(await screen.findByText(/Did not fire — Location scope/)).toBeInTheDocument();
    expect(screen.getByText(/outside/)).toBeInTheDocument();
  });
});
