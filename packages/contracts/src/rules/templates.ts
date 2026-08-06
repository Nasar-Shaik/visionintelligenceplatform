/**
 * **Rule templates** (P-8 Phase 7) — the mechanism that makes "rules are configuration, not code"
 * checkable rather than merely asserted.
 *
 * A template is a **named set of defaults over `CreateRuleInput`**. It contains no logic, no
 * behaviour, and nothing the rule engine can execute; applying one produces an ordinary rule that an
 * operator could have typed by hand. That is the entire design, and it is what makes the Architect's
 * claim testable:
 *
 * > *The same engine should later support Theft, Queue Monitoring, Intrusion, Occupancy, Line
 * > Crossing, Abandoned Object, PPE and Safety without redesign.*
 *
 * ### ⚠️ How that claim is kept honest
 *
 * Not by shipping eight templates. Shipping stubs for workflows nobody has verified is how a product
 * acquires eight features that each fail differently the first time a customer opens one, and the
 * Architect explicitly said **do not implement Theft Detection in this milestone**.
 *
 * It is kept honest **structurally**: there is nothing in this file, in `RuleTemplate`, or in the
 * evaluation path that mentions loitering. The word appears in exactly one place — the `id` of the
 * one built-in below — and the engine never reads it. A future workflow is a new entry in this array
 * and no other change anywhere. `FUTURE_WORKFLOW_COVERAGE` records, for each workflow the Architect
 * named, which already-built primitive expresses it — so the claim can be reviewed now rather than
 * discovered to be false in eight milestones' time.
 */
import { z } from 'zod';
import type { CreateRuleInput } from './rules.js';

/**
 * A parameter an operator fills in when applying a template.
 *
 * Deliberately dumb: a label, a path into the rule, a type and a default. There is no expression
 * language and there will not be one — a template that could compute would be code, and this file
 * exists to prove rules are not.
 */
export const RuleTemplateParameter = z.object({
  /** Dotted path into `CreateRuleInput`, e.g. `dwell.minSeconds`. */
  path: z.string().min(1).max(100),
  label: z.string().min(1).max(120),
  help: z.string().max(400).optional(),
  kind: z.enum(['seconds', 'integer', 'text', 'zones', 'cameras', 'groups', 'severity', 'boolean']),
  /** Whether an operator must supply it before the rule can be created. */
  required: z.boolean().default(false),
});
export type RuleTemplateParameter = z.infer<typeof RuleTemplateParameter>;

export const RuleTemplate = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  /** Coarse grouping for the template picker. Presentation only. */
  family: z.enum(['retail', 'security', 'safety', 'operations']),
  /** The parameters the console renders. */
  parameters: z.array(RuleTemplateParameter).default([]),
  /**
   * What applying it produces, before parameters are filled in.
   *
   * ⚠️ A complete, valid `CreateRuleInput` — not a fragment. A template that produced something the
   * normal create path had to special-case would be a second way to author a rule, and the second way
   * is always the one that misses a validation.
   */
  rule: z.custom<CreateRuleInput>(),
});
export type RuleTemplate = z.infer<typeof RuleTemplate>;

/**
 * **Retail Loitering** — the first complete customer workflow, expressed entirely as configuration.
 *
 * Read it as the answer to *"what did the platform have to gain to support this?"*: a dwell block and
 * a zone scope. Everything else — the event type, the condition, the action, the severity — was
 * already there and unchanged since P1-7.
 *
 * ### ⚠️ Why the condition is `subjects.0.identityId exists` rather than empty
 *
 * A dwell rule that matches a detection with no identity cannot accumulate anything: there is no
 * subject to file the observation under. Without this leaf the rule would reach the dwell stage,
 * discover it has no key, and reject the event there — which is correct behaviour reported at the
 * wrong stage, and an operator reading the explanation would be told the dwell threshold was not met
 * when the real answer is that tracking is not producing identities. The leaf moves the refusal to
 * the stage whose name says what is actually wrong.
 */
export const LOITERING_TEMPLATE: RuleTemplate = {
  id: 'retail-loitering',
  name: 'Retail Loitering',
  family: 'retail',
  description:
    'Raise a candidate when the same person is observed in a chosen zone for longer than a chosen ' +
    'time. Timing follows the subject across brief occlusions by accumulating on identity rather ' +
    'than on track. Recording is unaffected.',
  parameters: [
    {
      path: 'dwell.minSeconds',
      label: 'Minimum dwell time',
      help: 'How long a person must be observed in the zone before a candidate is raised.',
      kind: 'seconds',
      required: true,
    },
    {
      path: 'scope.zoneIds',
      label: 'Zones',
      help: 'Which detection zones this rule watches. Leave empty to watch the whole frame.',
      kind: 'zones',
      required: false,
    },
    {
      path: 'scope.cameraIds',
      label: 'Cameras',
      help: 'Cameras this rule covers. Leave every scope field empty to cover the whole tenant.',
      kind: 'cameras',
      required: false,
    },
    {
      path: 'scope.groupIds',
      label: 'Camera groups',
      help: 'Groups are expanded into cameras when the rule is validated.',
      kind: 'groups',
      required: false,
    },
    {
      path: 'dwell.resetAfterSeconds',
      label: 'Reset after',
      help: 'A gap longer than this ends the visit; the next sighting starts a new one from zero.',
      kind: 'seconds',
      required: false,
    },
    {
      path: 'dwell.cooldownSeconds',
      label: 'Cool-down',
      help: 'After firing for a person, stay silent about that person in that zone for this long.',
      kind: 'seconds',
      required: false,
    },
    {
      path: 'dryRun',
      label: 'Dry run',
      help: 'Evaluate against live traffic and record what would have happened, raising nothing.',
      kind: 'boolean',
      required: false,
    },
    { path: 'severity', label: 'Severity', kind: 'severity', required: false },
  ],
  rule: {
    name: 'Retail Loitering',
    description: 'A person observed in a monitored zone for longer than the configured dwell time.',
    lifecycle: 'draft',
    priority: 100,
    eventTypes: ['perception.person.detected'],
    categories: [],
    condition: { field: 'subjects.0.identityId', op: 'exists' },
    dwell: { minSeconds: 60, groupBy: 'identity', resetAfterSeconds: 30, cooldownSeconds: 300 },
    dryRun: false,
    severity: 'medium',
    actions: [{ type: 'raise-incident' }],
    scope: { nodeIds: [], cameraIds: [], groupIds: [], zoneIds: [] },
  } as CreateRuleInput,
};

/** Every template the platform ships. ⚠️ One, deliberately — see the header. */
export const RULE_TEMPLATES: readonly RuleTemplate[] = [LOITERING_TEMPLATE];

export function lookupRuleTemplate(id: string): RuleTemplate | undefined {
  return RULE_TEMPLATES.find((t) => t.id === id);
}

/**
 * **The no-redesign claim, written down so it can be reviewed** (Architect rec 2 of the main brief).
 *
 * For each workflow the Architect named, the primitive that expresses it and — where one is missing —
 * exactly what is missing. ⚠️ This is documentation, not a promise: `needs` naming something means
 * that workflow is **not** buildable from configuration today, and saying so here is the point. A
 * coverage table that claimed everything was ready would be discovered to be wrong by whoever tried
 * it, under deadline.
 */
export const FUTURE_WORKFLOW_COVERAGE: readonly {
  workflow: string;
  expressedBy: string;
  needs?: string;
}[] = [
  {
    workflow: 'Loitering',
    expressedBy: 'dwell(identity) + zone scope — shipped in P-8 Phase 7 as the template above',
  },
  {
    workflow: 'Intrusion',
    expressedBy: 'zone scope + condition on subject class; no dwell, or a dwell of a second or two',
  },
  {
    workflow: 'Queue monitoring',
    expressedBy:
      'dwell(identity) in a queue zone; the rule is the same, the zone and threshold differ',
  },
  {
    workflow: 'Abandoned object',
    expressedBy:
      'dwell(track) on a non-person class — `groupBy: track` exists for exactly this case',
  },
  {
    workflow: 'Occupancy',
    expressedBy: 'window(count, groupBy zone) over zone-stamped events — the P1-7 window stage',
    needs:
      'a distinct-subject count. `window` counts events, so two events from one person read as two ' +
      'people. Occupancy needs counting by subject, which is a third stateful stage, not a redesign.',
  },
  {
    workflow: 'Line crossing',
    expressedBy: 'a `line` detection zone, which the geometry and storage already accept',
    needs:
      'directional transition detection in the zone resolver. It stamps membership, and a line has ' +
      'no interior — crossing is a change of side between frames, which nothing computes yet.',
  },
  {
    workflow: 'PPE / Safety',
    expressedBy: 'condition on `subjects.0.attributes` + zone scope',
    needs: 'a capability that produces the attribute. This is a perception gap, not a rules gap.',
  },
  {
    workflow: 'Theft',
    expressedBy: 'a composite of the above — deliberately not attempted in this milestone',
    needs:
      'correlation across rules and across cameras. The single largest gap on this list and the ' +
      'reason the Architect scheduled it as its own milestone.',
  },
];
