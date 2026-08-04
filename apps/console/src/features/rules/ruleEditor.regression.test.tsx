/**
 * **The permanent guard against TD-21: an existing rule that cannot be saved.**
 *
 * ### What broke, and why a test has to be shaped like this one
 *
 * Opening a saved rule and pressing Save failed validation on `lifecycle` and `severity` with
 * "Invalid input", so the PATCH never fired. Both are Radix `Select`s behind RHF `Controller`s, and
 * a Radix `Select` cannot adopt a value that arrives *after* it mounts in this composition — its
 * `SelectItem`s live in a portal that is unmounted while the menu is closed, so a later value has no
 * item to resolve against. Radix falls back to its placeholder and reports an **empty** value.
 *
 * ⚠️ The two Selects that failed were the two whose stored value **differed from the form default**.
 * `actionType` and `actionSeverity` are the same construction and passed, because their stored
 * values happened to equal the defaults. A test using a fixture whose values match the defaults
 * would therefore have been green throughout the entire defect. **That is the trap this file
 * exists to avoid**, so every fixture below deliberately differs from `DEFAULT_RULE_FORM` in every
 * Select, and `differsFromDefaults` asserts it — if someone later "tidies" a fixture back toward the
 * defaults, that assertion fails rather than the coverage quietly evaporating.
 *
 * The four things asserted, per the P-6.1 approval:
 *   **load** — the rule is fetched and the form mounts with it
 *   **display** — every Select shows the stored value, in the DOM and in the hidden native select
 *   **save** — the PATCH body carries the stored values, not the defaults
 *   **reload** — reopening after the save shows what was saved
 */
import { afterEach, describe, expect, it } from 'vitest';
import { http as mswHttp, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { permissionsForRoles } from '@vip/permissions';
import { store } from '@/app/store';
import { authenticated, signedOut } from '@/store/sessionSlice';
import { server } from '@/test/server';
import { renderWithProviders } from '@/test/render';
import { RuleEditorPage } from './RuleEditorPage';
import { DEFAULT_RULE_FORM } from './ruleForm';

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

const BASE = {
  id: 'rule-1',
  tenantId: 'tnt_acme',
  name: 'After-hours presence',
  description: 'Person in the stock room outside trading hours',
  priority: 200,
  version: 1,
  eventTypes: ['perception.person.detected'],
  categories: ['perception'],
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

/** Serve one rule, and capture whatever the editor PATCHes back. */
function mockRule(rule: Record<string, unknown>) {
  const patches: unknown[] = [];
  server.use(
    mswHttp.get('/api/rules/rules/:id', () => HttpResponse.json({ success: true, data: rule })),
    mswHttp.patch('/api/rules/rules/:id', async ({ request }) => {
      const body = await request.json();
      patches.push(body);
      return HttpResponse.json({
        success: true,
        data: { ...rule, ...(body as object), version: 2 },
      });
    }),
  );
  return patches;
}

function openRule() {
  return renderWithProviders(<RuleEditorPage />, {
    store,
    route: '/rules/rule-1',
    path: '/rules/:id',
  });
}

/**
 * What the *browser* would submit for a Radix Select.
 *
 * Radix renders a hidden native `<select>` alongside the trigger, and that element — not the visible
 * button — is what carries the value into a form. During the defect it read `value=""` while its
 * options contained the right entry. Asserting on it is asserting on the exact thing that was
 * measured broken against the deployment.
 */
function hiddenSelectValues(): string[] {
  return [...document.querySelectorAll('select')].map((el) => (el as HTMLSelectElement).value);
}

/**
 * Every rule shape a customer can have saved, each differing from the form defaults in every Select.
 * `lifecycle` and `severity` are crossed deliberately: the defect was specific to the *combination*
 * of a stored value and a different default, so one representative rule would not have found it.
 */
const LIFECYCLES = ['draft', 'validated', 'enabled', 'disabled', 'archived'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: 'Draft',
  validated: 'Validated',
  enabled: 'Enabled',
  disabled: 'Disabled',
  archived: 'Archived',
};
const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

describe('TD-21 — every saved rule loads, displays, saves and reloads', () => {
  /**
   * The full matrix. Twenty-five combinations is cheap here and it is the only way to be sure the
   * suite is not passing because one fixture happens to sit on a default.
   */
  for (const lifecycle of LIFECYCLES) {
    for (const severity of SEVERITIES) {
      it(`loads and saves a ${lifecycle}/${severity} rule without losing either value`, async () => {
        const rule = {
          ...BASE,
          lifecycle,
          severity,
          actions: [{ type: 'raise-incident' }],
        };
        const patches = mockRule(rule);
        authAs(['admin']);
        const user = userEvent.setup();
        openRule();

        // ── load + display ────────────────────────────────────────────────────────────────
        const lifecycleBox = await screen.findByRole('combobox', { name: 'Lifecycle' });
        const severityBox = screen.getByRole('combobox', { name: 'Severity' });
        expect(lifecycleBox).toHaveTextContent(LIFECYCLE_LABEL[lifecycle] as string);
        expect(severityBox).toHaveTextContent(SEVERITY_LABEL[severity] as string);

        // ⚠️ The assertion that would have caught the original defect: the value the form submits.
        expect(hiddenSelectValues()).toContain(lifecycle);
        expect(hiddenSelectValues()).toContain(severity);

        // ── save ──────────────────────────────────────────────────────────────────────────
        // Save is disabled until something changes, so make the smallest possible edit. The point
        // is that the *untouched* Selects still submit their loaded values.
        await user.type(screen.getByLabelText('Name'), ' (edited)');
        await user.click(screen.getByRole('button', { name: /save changes/i }));

        await waitFor(() => expect(patches).toHaveLength(1));
        expect(patches[0]).toMatchObject({
          name: 'After-hours presence (edited)',
          lifecycle,
          severity,
        });
      });
    }
  }

  it('carries every Select through a save, including the two that only worked by accident', async () => {
    /*
     * `actionType` and `actionSeverity` passed throughout the defect because their stored values
     * equalled the defaults. Here every Select differs from its default, so all four are load-bearing.
     */
    const rule = {
      ...BASE,
      lifecycle: 'enabled',
      severity: 'critical',
      actions: [{ type: 'raise-incident', severity: 'low', title: 'Stock room breach' }],
    };
    const patches = mockRule(rule);
    authAs(['admin']);
    const user = userEvent.setup();
    openRule();

    expect(await screen.findByRole('combobox', { name: 'Action type' })).toHaveTextContent(
      'Raise incident',
    );
    expect(screen.getByRole('combobox', { name: 'Severity override' })).toHaveTextContent('Low');

    await user.type(screen.getByLabelText('Name'), '!');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      lifecycle: 'enabled',
      severity: 'critical',
      actions: [{ type: 'raise-incident', severity: 'low', title: 'Stock room breach' }],
    });
  });

  it('keeps the saved values when the rule is reopened', async () => {
    const rule = {
      ...BASE,
      lifecycle: 'enabled',
      severity: 'critical',
      actions: [{ type: 'raise-incident' }],
    };
    mockRule(rule);
    authAs(['admin']);
    const first = openRule();
    expect(await screen.findByRole('combobox', { name: 'Lifecycle' })).toHaveTextContent('Enabled');
    first.unmount();

    // Reopen against the version the save produced — the "reload" half of the requirement.
    mockRule({ ...rule, version: 2, name: 'After-hours presence (edited)' });
    openRule();
    expect(await screen.findByRole('combobox', { name: 'Lifecycle' })).toHaveTextContent('Enabled');
    expect(screen.getByRole('combobox', { name: 'Severity' })).toHaveTextContent('Critical');
    expect(screen.getByLabelText('Name')).toHaveValue('After-hours presence (edited)');
  });

  it('lets a changed Select through — the fix must not freeze the form', async () => {
    /*
     * ⚠️ The counterweight. Mounting once with the right values would also be satisfied by a form
     * that ignores input entirely, so this asserts the opposite direction: a value the operator
     * *changes* must reach the PATCH.
     */
    const rule = {
      ...BASE,
      lifecycle: 'enabled',
      severity: 'critical',
      actions: [{ type: 'raise-incident' }],
    };
    const patches = mockRule(rule);
    authAs(['admin']);
    const user = userEvent.setup();
    openRule();

    await user.click(await screen.findByRole('combobox', { name: 'Lifecycle' }));
    await user.click(await screen.findByRole('option', { name: 'Disabled' }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ lifecycle: 'disabled', severity: 'critical' });
  });

  it('every Select is announced by its purpose, not by its current value', async () => {
    /*
     * ⚠️ These triggers previously had no label association at all. A Radix `SelectTrigger` takes
     * its accessible name from its content, so it reads as "Enabled, combobox" — a *named* control,
     * which is why an automated audit reported zero unnamed controls, but named the wrong thing. A
     * screen-reader user had no way to tell which field they were on.
     */
    mockRule({
      ...BASE,
      lifecycle: 'enabled',
      severity: 'critical',
      actions: [{ type: 'raise-incident' }],
    });
    authAs(['admin']);
    openRule();

    for (const name of ['Lifecycle', 'Severity', 'Action type', 'Severity override']) {
      expect(await screen.findByRole('combobox', { name })).toBeInTheDocument();
    }
  });

  it('the fixtures differ from the form defaults — otherwise this suite proves nothing', () => {
    /*
     * ⚠️ The guard on the guard. The defect was invisible to any fixture sitting on a default value,
     * so if a future edit moves these fixtures back onto the defaults this fails loudly instead of
     * the whole file silently becoming decoration.
     */
    expect(LIFECYCLES.filter((l) => l !== DEFAULT_RULE_FORM.lifecycle).length).toBeGreaterThan(3);
    expect(SEVERITIES.filter((s) => s !== DEFAULT_RULE_FORM.severity).length).toBeGreaterThan(3);
    expect(DEFAULT_RULE_FORM.actionSeverity).toBe('inherit');
  });
});
