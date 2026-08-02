import type {
  CreateRuleInput,
  Rule,
  RuleDryRunResult,
  RuleValidationReport,
  RuleVersionRecord,
  UpdateRuleInput,
} from '@vip/contracts';
import type { EventEnvelope } from '@vip/contracts';
import { http } from './http';

/**
 * Rule authoring reads + writes (through the gateway: `/api/rules/*`). The list endpoint returns a
 * bare `Rule[]` (not a page). Every write is permission-gated server-side (rule:create/update/delete)
 * and tenant-scoped from the access token; dry-run is read-only (no emission, no state mutation).
 */
export const rulesApi = {
  list: () => http.get<Rule[]>('/rules/rules'),
  get: (id: string) => http.get<Rule>(`/rules/rules/${id}`),
  create: (input: CreateRuleInput) => http.post<Rule>('/rules/rules', input),
  update: (id: string, patch: UpdateRuleInput) => http.patch<Rule>(`/rules/rules/${id}`, patch),
  remove: (id: string) => http.del<void>(`/rules/rules/${id}`),
  versions: (id: string) => http.get<RuleVersionRecord[]>(`/rules/rules/${id}/versions`),
  dryRun: (id: string, event: EventEnvelope) =>
    http.post<RuleDryRunResult>(`/rules/rules/${id}/dry-run`, { event }),
  /**
   * Check a rule's references (P-4). A **GET**: it reads and reports, writes nothing and changes no
   * lifecycle, so an editor can call it freely while the author is still deciding.
   */
  validation: (id: string) => http.get<RuleValidationReport>(`/rules/rules/${id}/validation`),
};
