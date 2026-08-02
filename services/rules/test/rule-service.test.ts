import { describe, it, expect, beforeEach } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { RuleService } from '../src/application/rule-service.js';
import { InMemoryRuleStore } from '../src/adapters/in-memory-rule-store.js';
import { personEvent, personRuleInput } from './helpers.js';

let store: InMemoryRuleStore;
let service: RuleService;
const scopeA = TenantScope.fromTenantId('tnt_a');
const scopeB = TenantScope.fromTenantId('tnt_b');

beforeEach(() => {
  store = new InMemoryRuleStore({ now: () => new Date('2026-07-29T21:00:00.000Z') });
  service = new RuleService({ store });
});

describe('RuleService — CRUD + versioning/audit', () => {
  it('creates a version-1 rule and an audit record', async () => {
    const rule = await service.create(scopeA, personRuleInput(), 'usr_1');
    expect(rule.version).toBe(1);
    expect(rule.lifecycle).toBe('enabled');
    const versions = await service.listVersions(scopeA, rule.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, changeKind: 'created', changedBy: 'usr_1' });
  });

  it('bumps the version on update and records the audit kind', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const updated = await service.update(scopeA, rule.id, { severity: 'critical' }, 'usr_2');
    expect(updated.version).toBe(2);
    expect(updated.severity).toBe('critical');

    // a lifecycle-only change is audited distinctly
    const lc = await service.update(scopeA, rule.id, { lifecycle: 'disabled' });
    expect(lc.version).toBe(3);
    const versions = await service.listVersions(scopeA, rule.id);
    expect(versions.map((v) => v.changeKind)).toEqual(['lifecycle-changed', 'updated', 'created']);
  });

  it('removes a rule and leaves a deleted audit snapshot', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await service.remove(scopeA, rule.id, 'usr_1');
    await expect(service.get(scopeA, rule.id)).rejects.toThrow();
    const versions = await service.listVersions(scopeA, rule.id);
    expect(versions[0]?.changeKind).toBe('deleted');
  });

  it('does not leak rules across tenants (404 for another tenant)', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    await expect(service.get(scopeB, rule.id)).rejects.toThrow();
    expect(await service.list(scopeB)).toHaveLength(0);
  });
});

describe('RuleService — dry-run (no side effects)', () => {
  it('reports a match + the candidate that WOULD be raised', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const result = await service.dryRun(scopeA, rule.id, personEvent());
    expect(result.matched).toBe(true);
    expect(result.evaluation).toEqual({
      prefilterPassed: true,
      conditionPassed: true,
      windowPassed: true,
    });
    expect(result.candidate?.severity).toBe('high');
  });

  it('reports no match when the condition fails, with no candidate', async () => {
    const rule = await service.create(scopeA, personRuleInput());
    const result = await service.dryRun(scopeA, rule.id, personEvent({ confidence: 0.4 }));
    expect(result.matched).toBe(false);
    expect(result.evaluation.conditionPassed).toBe(false);
    expect(result.candidate).toBeUndefined();
  });
});

/**
 * Rules consume the Location Hierarchy (P-4).
 *
 * The hierarchy is reached through a **port**, called at validation time and never per event, so
 * these drive the real gate with a fake provider rather than mocking the decision away.
 */
describe('RuleService — scope, validation and activation (P-4)', () => {
  /** A hierarchy that knows one site with two zones, and one archived building. */
  const hierarchy = {
    async resolveScope(_scope: TenantScope, nodeIds: readonly string[]) {
      const known: Record<string, string[]> = { on_london: ['zone_1', 'zone_2'], on_empty: [] };
      const archived = new Set(['on_old']);
      return {
        available: true,
        zoneIds: nodeIds.flatMap((id) => known[id] ?? []),
        missingNodeIds: nodeIds.filter((id) => !(id in known) && !archived.has(id)),
        archivedNodeIds: nodeIds.filter((id) => archived.has(id)),
      };
    },
  };
  const cameras = {
    async findMissing(_scope: TenantScope, ids: readonly string[]) {
      return { available: true, missingCameraIds: ids.filter((id) => id !== 'cam_1') };
    },
  };

  const scopedService = () => new RuleService({ store, hierarchy, cameras });

  it('enables a scoped rule and snapshots the expansion onto that version', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    expect(rule.resolvedScope).toBeUndefined();

    const enabled = await svc.update(scopeA, rule.id, { lifecycle: 'enabled' });
    expect(enabled.lifecycle).toBe('enabled');
    expect(enabled.resolvedScope?.zoneIds).toEqual(['zone_1', 'zone_2']);
    expect(enabled.resolvedScope?.tenantWide).toBe(false);

    // The expansion travels with the immutable version, so an old incident can be shown its scope.
    const versions = await svc.listVersions(scopeA, rule.id);
    expect(versions[0]?.snapshot.resolvedScope?.zoneIds).toEqual(['zone_1', 'zone_2']);
  });

  it('refuses to enable a rule scoped to a location that does not exist', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    await expect(svc.update(scopeA, rule.id, { lifecycle: 'enabled' })).rejects.toThrow(
      /does not exist/,
    );
    expect((await svc.get(scopeA, rule.id)).lifecycle).toBe('draft');
  });

  it('refuses to enable a rule naming a camera that does not exist', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: [], cameraIds: ['cam_ghost'] } }),
    );
    await expect(svc.update(scopeA, rule.id, { lifecycle: 'enabled' })).rejects.toThrow(
      /cam_ghost/,
    );
  });

  /**
   * The rule that matters most. With no hierarchy configured the check cannot run — and a check that
   * could not run is not a check that passed.
   */
  it('refuses to enable a location-scoped rule when the hierarchy is unreachable', async () => {
    const svc = new RuleService({ store }); // no providers → unavailable, never "fine"
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    await expect(svc.update(scopeA, rule.id, { lifecycle: 'enabled' })).rejects.toThrow(
      /could not be checked/,
    );
  });

  it('still enables a tenant-wide rule with no providers — the check is proportional', async () => {
    const svc = new RuleService({ store });
    const rule = await svc.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    const enabled = await svc.update(scopeA, rule.id, { lifecycle: 'enabled' });
    expect(enabled.lifecycle).toBe('enabled');
    expect(enabled.resolvedScope?.tenantWide).toBe(true);
  });

  it('lets a broken rule be disabled or archived without first being made valid', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    // Created straight to `enabled` by the fixture; the gate only guards the transition INTO enabled.
    await expect(svc.update(scopeA, rule.id, { lifecycle: 'disabled' })).resolves.toMatchObject({
      lifecycle: 'disabled',
    });
    await expect(svc.update(scopeA, rule.id, { lifecycle: 'archived' })).resolves.toMatchObject({
      lifecycle: 'archived',
    });
  });

  it('validates without changing anything', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_ghost'], cameraIds: [] } }),
    );
    const report = await svc.validate(scopeA, rule.id);
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === 'missing-location')).toBe(true);
    expect((await svc.get(scopeA, rule.id)).lifecycle).toBe('draft');
    expect((await svc.get(scopeA, rule.id)).version).toBe(1);
  });

  it('drops the expansion when the scope is re-authored, so it cannot go stale silently', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    const enabled = await svc.update(scopeA, rule.id, { lifecycle: 'enabled' });
    expect(enabled.resolvedScope).toBeDefined();

    const rescoped = await svc.update(scopeA, rule.id, {
      scope: { nodeIds: ['on_empty'], cameraIds: [] },
    });
    // The old expansion belonged to the old scope; carrying it forward would match removed zones.
    expect(rescoped.resolvedScope).toBeUndefined();
  });

  it('dry-runs against the scope and explains which stage decided', async () => {
    const svc = scopedService();
    const rule = await svc.create(
      scopeA,
      personRuleInput({ lifecycle: 'draft', scope: { nodeIds: ['on_london'], cameraIds: [] } }),
    );
    await svc.update(scopeA, rule.id, { lifecycle: 'enabled' });

    const inside = await svc.dryRun(scopeA, rule.id, personEvent({ zoneId: 'zone_1' }));
    expect(inside.matched).toBe(true);
    expect(inside.explanation?.decidedBy).toBe('matched');

    const outside = await svc.dryRun(scopeA, rule.id, personEvent({ zoneId: 'zone_99' }));
    expect(outside.matched).toBe(false);
    expect(outside.explanation?.decidedBy).toBe('scope');
    expect(outside.explanation?.summary).toContain('outside');
  });

  it('explains a failing condition with the value it actually saw', async () => {
    const svc = scopedService();
    const rule = await svc.create(scopeA, personRuleInput());
    const result = await svc.dryRun(scopeA, rule.id, personEvent({ confidence: 0.42 }));
    expect(result.matched).toBe(false);
    expect(result.explanation?.decidedBy).toBe('condition');
    expect(result.explanation?.summary).toContain('0.42');
  });

  it('never reports "not enabled" in a dry-run — an author tests a draft', async () => {
    const svc = scopedService();
    const rule = await svc.create(scopeA, personRuleInput({ lifecycle: 'draft' }));
    const result = await svc.dryRun(scopeA, rule.id, personEvent());
    expect(result.explanation?.stages.lifecyclePassed).toBe(true);
    expect(result.matched).toBe(true);
  });
});
