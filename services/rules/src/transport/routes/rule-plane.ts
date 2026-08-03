/**
 * Transport: the small amount both rule planes share (P-4.2, Architect rec 9).
 *
 * Kept to tenant scoping and the crash guard. A shared module between route files is a magnet for
 * everything that is *nearly* general, and the way two planes quietly become one again.
 */
import { TenantScope } from '@vip/tenancy';
import { MAX_BODY_NESTING, rawDepth } from '../../domain/budget.js';
import { badRequest } from '../../application/errors.js';

export interface RuleParams {
  id: string;
}

export const scopeOf = (tenantId: string): TenantScope => TenantScope.fromTenantId(tenantId);

/**
 * Refuse an absurdly nested body **before** it reaches the schema (P-4.1).
 *
 * `RuleCondition` is a recursive Zod schema, so a deeply nested body overflows the stack inside the
 * parser — before validation, before the budget check, before anything can report it. The precise
 * limit is enforced afterwards by `budgetChecks` with a number that means something to an author;
 * this is only the crash guard, and it has to run first.
 */
export function guardNesting(body: unknown): void {
  if (rawDepth(body, MAX_BODY_NESTING) > MAX_BODY_NESTING) {
    throw badRequest('this request is nested too deeply to be a rule');
  }
}
