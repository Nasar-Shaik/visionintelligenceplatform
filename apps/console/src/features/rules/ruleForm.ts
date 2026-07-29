import { z } from 'zod';
import {
  type CreateRuleInput,
  EventCategory,
  EventPriority,
  EventType,
  type Rule,
  RuleCondition,
  RuleLifecycleState,
} from '@vip/contracts';

type RuleActionValue = CreateRuleInput['actions'][number];

/**
 * Form-shaped schema for the rule editor. It is deliberately flatter than the contract `Rule` so it
 * binds cleanly to React Hook Form: the predicate tree and window are edited as text/toggles here,
 * then mapped to the strict `CreateRuleInput` on submit ({@link toRuleInput}). Cross-field rules
 * (valid dotted event types, parseable condition JSON, action-type–specific fields) live in the
 * `superRefine` so the UI surfaces precise, field-anchored errors. A visual predicate-tree builder is
 * a tracked future enhancement — for now the condition is authored as validated JSON.
 */

const WINDOW_GROUP_BY = z.enum(['none', 'camera', 'zone']);

export const ruleFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    description: z.string().max(2000),
    lifecycle: RuleLifecycleState,
    priority: z.number().int('Whole number').min(0).max(1000),
    severity: EventPriority,
    /** One dotted event type per line (or comma-separated); empty = any type. */
    eventTypesText: z.string(),
    categories: z.array(EventCategory),
    /** RuleCondition as JSON; empty = always true given the pre-filter. */
    conditionText: z.string(),
    windowEnabled: z.boolean(),
    windowWithinSeconds: z.number().int().min(1).max(86_400),
    windowCount: z.number().int().min(1).max(100_000),
    windowGroupBy: WINDOW_GROUP_BY,
    actionType: z.enum(['raise-incident', 'emit-event']),
    actionTitle: z.string().max(200),
    /** 'inherit' = use the rule severity; otherwise an EventPriority. */
    actionSeverity: z.string(),
    actionEventType: z.string(),
  })
  .superRefine((v, ctx) => {
    for (const t of parseEventTypes(v.eventTypesText)) {
      if (!EventType.safeParse(t).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['eventTypesText'],
          message: `"${t}" is not a valid <domain>.<subject>.<predicate> type`,
        });
        break;
      }
    }

    const condText = v.conditionText.trim();
    if (condText) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(condText);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditionText'],
          message: 'Condition must be valid JSON',
        });
        return;
      }
      if (!RuleCondition.safeParse(parsed).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditionText'],
          message: 'Condition does not match the rule-condition schema',
        });
      }
    }

    if (v.windowEnabled && v.windowCount < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['windowCount'],
        message: 'Count must be at least 1',
      });
    }

    if (v.actionType === 'raise-incident') {
      if (
        v.actionSeverity &&
        v.actionSeverity !== 'inherit' &&
        !EventPriority.safeParse(v.actionSeverity).success
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actionSeverity'],
          message: 'Invalid severity',
        });
      }
    } else if (!EventType.safeParse(v.actionEventType.trim()).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionEventType'],
        message: 'Emit-event requires a valid event type',
      });
    }
  });

export type RuleFormValues = z.infer<typeof ruleFormSchema>;

/** Split the free-text event-type field into a normalised, deduplicated list. */
export function parseEventTypes(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\n,]/)) {
    const t = raw.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export const DEFAULT_RULE_FORM: RuleFormValues = {
  name: '',
  description: '',
  lifecycle: 'draft',
  priority: 100,
  severity: 'medium',
  eventTypesText: '',
  categories: [],
  conditionText: '',
  windowEnabled: false,
  windowWithinSeconds: 60,
  windowCount: 5,
  windowGroupBy: 'none',
  actionType: 'raise-incident',
  actionTitle: '',
  actionSeverity: 'inherit',
  actionEventType: '',
};

/** Hydrate the form from a persisted rule (edit mode). */
export function ruleToFormValues(rule: Rule): RuleFormValues {
  const action = rule.actions[0];
  const isRaise = action?.type === 'raise-incident';
  return {
    name: rule.name,
    description: rule.description ?? '',
    lifecycle: rule.lifecycle,
    priority: rule.priority,
    severity: rule.severity,
    eventTypesText: rule.eventTypes.join('\n'),
    categories: rule.categories,
    conditionText: rule.condition ? JSON.stringify(rule.condition, null, 2) : '',
    windowEnabled: Boolean(rule.window),
    windowWithinSeconds: rule.window?.withinSeconds ?? 60,
    windowCount: rule.window?.count ?? 5,
    windowGroupBy: rule.window?.groupBy ?? 'none',
    actionType: action?.type ?? 'raise-incident',
    actionTitle: isRaise ? (action.title ?? '') : '',
    actionSeverity: isRaise ? (action.severity ?? 'inherit') : 'inherit',
    actionEventType: action?.type === 'emit-event' ? action.eventType : '',
  };
}

function buildAction(v: RuleFormValues): RuleActionValue {
  if (v.actionType === 'emit-event') {
    return { type: 'emit-event', eventType: v.actionEventType.trim() };
  }
  const action: Extract<RuleActionValue, { type: 'raise-incident' }> = { type: 'raise-incident' };
  const title = v.actionTitle.trim();
  if (title) action.title = title;
  if (v.actionSeverity && v.actionSeverity !== 'inherit') {
    action.severity = v.actionSeverity as EventPriority;
  }
  return action;
}

/** Map validated form values to the strict contract `CreateRuleInput` (also valid as an update patch). */
export function toRuleInput(v: RuleFormValues): CreateRuleInput {
  const input: CreateRuleInput = {
    name: v.name.trim(),
    lifecycle: v.lifecycle,
    priority: v.priority,
    eventTypes: parseEventTypes(v.eventTypesText),
    categories: v.categories,
    severity: v.severity,
    actions: [buildAction(v)],
  };
  const description = v.description.trim();
  if (description) input.description = description;
  const condText = v.conditionText.trim();
  if (condText) input.condition = JSON.parse(condText) as CreateRuleInput['condition'];
  if (v.windowEnabled) {
    input.window = {
      withinSeconds: v.windowWithinSeconds,
      count: v.windowCount,
      groupBy: v.windowGroupBy,
    };
  }
  return input;
}
