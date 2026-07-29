import type { RuleLifecycleState } from '@vip/contracts';
import type { BadgeProps } from '@/ui/badge';

/**
 * Presentation mapping for the rule lifecycle (contract `RuleLifecycleState`). Only `enabled` rules
 * are evaluated by the engine, so it reads as success; `disabled`/`archived` are muted; `draft` and
 * `validated` are authoring stages. Defined once so the list and editor stay consistent.
 */
export const RULE_LIFECYCLES: readonly RuleLifecycleState[] = [
  'draft',
  'validated',
  'enabled',
  'disabled',
  'archived',
];

const PRESENTATION: Record<RuleLifecycleState, { label: string; variant: BadgeProps['variant'] }> =
  {
    draft: { label: 'Draft', variant: 'neutral' },
    validated: { label: 'Validated', variant: 'brand' },
    enabled: { label: 'Enabled', variant: 'success' },
    disabled: { label: 'Disabled', variant: 'warning' },
    archived: { label: 'Archived', variant: 'outline' },
  };

export function lifecyclePresentation(state: RuleLifecycleState) {
  return PRESENTATION[state];
}
