import { afterEach, describe, expect, it, vi } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
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

/**
 * Version history and restore (P-4.1, Architect recs 7 + 12).
 *
 * The timeline is derived server-side, so what the console must get right is the reading: an action
 * per entry, and a restore offered only where restoring means something.
 */
describe('rule history and restore (P-4.1)', () => {
  const AUDIT = [
    {
      ruleId: 'rule-1',
      version: 3,
      action: 'enabled',
      summary: 'the rule was enabled and is now evaluated against live events',
      changedFields: ['lifecycle'],
      actor: 'ops@tenant',
      at: '2026-07-20T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
    },
    {
      ruleId: 'rule-1',
      version: 2,
      action: 'updated',
      summary: 'changed severity',
      changedFields: ['severity'],
      actor: 'ops@tenant',
      at: '2026-07-10T00:00:00.000Z',
      contentHash: 'b'.repeat(64),
    },
    {
      ruleId: 'rule-1',
      version: 1,
      action: 'created',
      summary: 'the rule was created',
      changedFields: [],
      at: '2026-07-01T00:00:00.000Z',
      contentHash: 'c'.repeat(64),
    },
  ];

  function mockAudit(onRollback?: (body: unknown) => void) {
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
            checkedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
      mswHttp.get('/api/rules/rules/:id/audit', () =>
        HttpResponse.json({ success: true, data: AUDIT }),
      ),
      mswHttp.post('/api/rules/rules/:id/rollback', async ({ request }) => {
        onRollback?.(await request.json());
        return HttpResponse.json({ success: true, data: { ...RULE, version: 4 } });
      }),
    );
  }

  it('reads the history as actions rather than states', async () => {
    authAs(['admin']);
    mockAudit();
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });

    await userEvent.click(await screen.findByRole('button', { name: /version history/i }));

    // Scoped to the sheet: the editor's lifecycle picker also has an "Enabled" option.
    const sheet = within(await screen.findByRole('dialog'));
    expect(await sheet.findByText('Enabled')).toBeInTheDocument();
    expect(sheet.getByText('Created')).toBeInTheDocument();
    expect(sheet.getByText(/changed severity/)).toBeInTheDocument();
  });

  it('restores an earlier version, and does not offer it for a lifecycle-only entry', async () => {
    authAs(['admin']);
    let body: unknown = null;
    mockAudit((received) => {
      body = received;
    });
    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });

    await userEvent.click(await screen.findByRole('button', { name: /version history/i }));
    const restores = await screen.findAllByRole('button', { name: /restore this version/i });

    // v3 is the current version and an enable, not a content change — only v2 and v1 are restorable.
    expect(restores).toHaveLength(2);

    await userEvent.click(restores[0]!);
    await waitFor(() => expect(body).toEqual({ version: 2 }));
  });
});

/** The server-supplied evaluation tree (P-4.1, Architect rec 6). */
describe('rule explanation tree (P-4.1)', () => {
  it('renders the stages the server marked, rather than re-deciding them', async () => {
    authAs(['admin']);
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
            checkedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
      mswHttp.post('/api/rules/rules/:id/dry-run', () =>
        HttpResponse.json({
          success: true,
          data: {
            matched: false,
            evaluation: { prefilterPassed: true, conditionPassed: true, windowPassed: false },
            explanation: {
              ruleId: 'rule-1',
              ruleVersion: 3,
              ruleName: 'Loitering after hours',
              matched: false,
              decidedBy: 'window',
              summary: '1 of 3 matching events within 60s — not enough yet',
              stages: {
                lifecyclePassed: true,
                scopePassed: true,
                prefilterPassed: true,
                conditionPassed: true,
                windowPassed: false,
              },
              tree: [
                {
                  stage: 'lifecycle',
                  passed: true,
                  decisive: false,
                  reason: 'the rule is enabled',
                },
                { stage: 'scope', passed: true, decisive: false, reason: 'tenant-wide' },
                { stage: 'prefilter', passed: true, decisive: false, reason: 'type matches' },
                { stage: 'condition', passed: true, decisive: false, reason: 'all matched' },
                {
                  stage: 'window',
                  passed: false,
                  decisive: true,
                  reason: '1 of 3 matching events within 60s — not enough yet',
                },
              ],
            },
          },
        }),
      ),
    );

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    await userEvent.click(await screen.findByRole('button', { name: /run dry run/i }));

    expect(await screen.findByText(/Did not fire — Window threshold/)).toBeInTheDocument();

    const stages = within(screen.getByLabelText('Evaluation stages'));
    // Exactly one "decided here", on the stage the server said decided.
    expect(stages.getAllByText('decided here')).toHaveLength(1);
    expect(stages.getByText('Window threshold').closest('li')).toHaveTextContent('decided here');
    // The lifecycle stage is filtered out of an authoring view — it is always true there.
    expect(stages.queryByText('Enabled')).not.toBeInTheDocument();
  });
});

/** Health and version comparison (P-4.2, Architect recs 2 + 6). */
describe('rule health and version comparison (P-4.2)', () => {
  function mockRuleDetail(extra: Parameters<typeof server.use>[0][] = []) {
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
            checkedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
      ...extra,
    );
  }

  it('never shows a score without the reasons behind it', async () => {
    authAs(['admin']);
    mockRuleDetail([
      mswHttp.get('/api/rules/rules/:id/health', () =>
        HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            ruleVersion: 3,
            status: 'degraded',
            score: 90,
            findings: [
              {
                code: 'scope-stale',
                severity: 'warning',
                message: 'the covered zones were last worked out 45 days ago',
                deduction: 10,
              },
            ],
            assessedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
    ]);

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    const panel = within(await screen.findByLabelText('Rule health'));
    expect(panel.getByText('Needs attention')).toBeInTheDocument();
    expect(panel.getByText('90 / 100')).toBeInTheDocument();
    expect(panel.getByText(/45 days ago/)).toBeInTheDocument();
    expect(panel.getByText('−10')).toBeInTheDocument();
  });

  /** An unexamined rule is not an unhealthy one, and the two need different actions. */
  it('shows "cannot be checked" as its own state, with no score at all', async () => {
    authAs(['admin']);
    mockRuleDetail([
      mswHttp.get('/api/rules/rules/:id/health', () =>
        HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            ruleVersion: 3,
            status: 'unknown',
            score: 0,
            findings: [
              {
                code: 'unverified',
                severity: 'error',
                message: 'some of this rule’s references could not be checked',
                deduction: 0,
              },
            ],
            assessedAt: '2026-08-03T00:00:00.000Z',
          },
        }),
      ),
    ]);

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    const panel = within(await screen.findByLabelText('Rule health'));
    expect(panel.getByText('Cannot be checked')).toBeInTheDocument();
    // A 0/100 next to "cannot be checked" would read as "this rule is broken".
    expect(panel.queryByText('0 / 100')).not.toBeInTheDocument();
  });

  it('fetches a comparison only when a reviewer asks for one', async () => {
    authAs(['admin']);
    let diffRequests = 0;
    mockRuleDetail([
      mswHttp.get('/api/rules/rules/:id/audit', () =>
        HttpResponse.json({
          success: true,
          data: [
            {
              ruleId: 'rule-1',
              version: 2,
              action: 'updated',
              summary: 'changed severity',
              changedFields: ['severity'],
              at: '2026-07-20T00:00:00.000Z',
              contentHash: 'a'.repeat(64),
            },
            {
              ruleId: 'rule-1',
              version: 1,
              action: 'created',
              summary: 'the rule was created',
              changedFields: [],
              at: '2026-07-01T00:00:00.000Z',
              contentHash: 'b'.repeat(64),
            },
          ],
        }),
      ),
      mswHttp.get('/api/rules/rules/:id/diff', () => {
        diffRequests += 1;
        return HttpResponse.json({
          success: true,
          data: {
            ruleId: 'rule-1',
            fromVersion: 1,
            toVersion: 2,
            behaviourUnchanged: false,
            changes: [
              {
                area: 'severity',
                kind: 'changed',
                path: 'severity',
                summary: 'severity "high" → "critical"',
              },
            ],
          },
        });
      }),
    ]);

    renderWithProviders(<RuleEditorPage />, { store, route: '/rules/rule-1', path: '/rules/:id' });
    await userEvent.click(await screen.findByRole('button', { name: /version history/i }));

    // A timeline of forty versions must not be forty diff requests.
    expect(diffRequests).toBe(0);
    // Only v2 offers a comparison — there is nothing before v1.
    const compare = await screen.findAllByRole('button', { name: /what changed/i });
    expect(compare).toHaveLength(1);

    await userEvent.click(compare[0]!);
    expect(await screen.findByText(/severity "high" → "critical"/)).toBeInTheDocument();
    expect(diffRequests).toBe(1);
  });
});
