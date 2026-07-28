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
