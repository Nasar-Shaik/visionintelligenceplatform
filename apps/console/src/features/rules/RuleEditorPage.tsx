import type { ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { EventCategory } from '@vip/contracts';
import type { Rule } from '@vip/contracts';
import { usePermission } from '@/app/hooks';
import { ApiRequestError } from '@/lib/api/http';
import { SEVERITY_ORDER, severityTokens } from '@/lib/severity';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
  toast,
} from '@/ui';
import { RuleDryRunPanel } from './RuleDryRunPanel';
import { RuleScopeField } from './RuleScopeField';
import { RuleHealthPanel } from './RuleHealthBadge';
import { RuleValidationPanel } from './RuleValidationPanel';
import { RuleVersionsSheet } from './RuleVersionsSheet';
import { RULE_LIFECYCLES, lifecyclePresentation } from './lifecycle';
import {
  DEFAULT_RULE_FORM,
  type RuleFormValues,
  ruleFormSchema,
  ruleToFormValues,
  toRuleInput,
} from './ruleForm';
import { useCreateRule, useRule, useUpdateRule } from './useRules';

/** A labelled form control with optional help + error text. */
function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-xs text-text-subtle">{hint}</p> : null}
      {error ? <p className="text-xs text-critical">{error}</p> : null}
    </div>
  );
}

/**
 * The form itself. **Mounted only once its initial values are known**, and keyed by rule id — see
 * `RuleEditorPage` below for why that is load-bearing rather than tidy.
 */
function RuleEditorForm({ id, rule }: { id: string | undefined; rule: Rule | undefined }) {
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const createRule = useCreateRule();
  const updateRule = useUpdateRule(id ?? '');

  /**
   * ⚠️ **The form is mounted with its values; it is never hydrated afterwards. That was TD-21.**
   *
   * An existing rule could not be saved: submit failed validation on `lifecycle` and `severity` with
   * "Invalid input", so the PATCH never fired. Both are Radix `Select`s behind `Controller`s, and
   * both were the fields whose stored value *differs* from the form default — `enabled` over
   * `draft`, `critical` over `medium`. `actionType` and `actionSeverity` are also Controller-driven
   * Selects and worked, because their stored values happen to equal the defaults. That was the clue.
   *
   * ⚠️ **A Radix `Select` cannot adopt a value that changes after it mounts, in this composition.**
   * Its `SelectItem`s live inside `SelectPrimitive.Portal`, which is not mounted while the menu is
   * closed — so a value arriving later has no item to resolve against. Radix falls back to its
   * placeholder and reports an empty value, which is what reached the resolver. Measured in a real
   * browser against the deployment: the hidden native select read `value=""` with `enabled` present
   * in its options.
   *
   * ⚠️ Two fixes were tried and rejected against that measurement, and both are recorded because
   * each looks obviously right:
   *
   * 1. **`reset()` in an effect** — the original code. Sets form state after mount. No effect on the
   *    Selects.
   * 2. **RHF's `values` option** — built for exactly this case, and it also sets state after mount.
   *    Deployed, measured, still empty. ⚠️ Being the purpose-built API did not make it the right
   *    one; the constraint is Radix's mount, not RHF's plumbing.
   *
   * A `key={field.value}` on each Select does work — measured — and is still wrong: it remounts the
   * trigger on every selection, which drops keyboard focus and fails the accessibility gate.
   *
   * So the form is split. `RuleEditorPage` waits for the data and keys this component by rule id, so
   * `defaultValues` is correct at the only moment RHF reads it, and every Select mounts once with
   * the value it will show. It removes the whole class of bug rather than the two instances of it.
   */
  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors, isDirty },
  } = useForm<RuleFormValues>({
    resolver: zodResolver(ruleFormSchema),
    defaultValues: rule ? ruleToFormValues(rule) : DEFAULT_RULE_FORM,
  });

  const actionType = watch('actionType');
  const windowEnabled = watch('windowEnabled');
  const saving = createRule.isPending || updateRule.isPending;
  const saveError = createRule.error ?? updateRule.error;

  const onSubmit = handleSubmit((values) => {
    const input = toRuleInput(values);
    if (isEdit) {
      updateRule.mutate(input, { onSuccess: () => toast.success('Rule saved') });
    } else {
      createRule.mutate(input, {
        onSuccess: (rule) => {
          toast.success('Rule created');
          navigate(`/rules/${rule.id}`, { replace: true });
        },
      });
    }
  });

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        breadcrumbs={[{ label: 'Rules' }, { label: isEdit ? (rule?.name ?? 'Rule') : 'New rule' }]}
        title={isEdit ? 'Edit rule' : 'New rule'}
        description="IF an event matches the triggers and condition, THEN run the action."
        actions={
          <div className="flex items-center gap-2">
            {isEdit && id ? <RuleVersionsSheet ruleId={id} /> : null}
            <Button asChild variant="ghost" size="sm">
              <Link to="/rules">
                <ArrowLeft />
                Cancel
              </Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <form onSubmit={onSubmit} noValidate className="space-y-6 lg:col-span-2">
          {saveError ? (
            <Alert variant="critical">
              {saveError instanceof ApiRequestError
                ? saveError.message
                : 'Could not save the rule.'}
            </Alert>
          ) : null}

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Name" htmlFor="name" error={errors.name?.message}>
                <Input id="name" aria-invalid={!!errors.name} {...register('name')} />
              </Field>
              <Field label="Description" htmlFor="description" error={errors.description?.message}>
                <Textarea id="description" rows={2} {...register('description')} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Lifecycle" error={errors.lifecycle?.message}>
                  <Controller
                    control={control}
                    name="lifecycle"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RULE_LIFECYCLES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {lifecyclePresentation(s).label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
                <Field label="Severity" error={errors.severity?.message}>
                  <Controller
                    control={control}
                    name="severity"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEVERITY_ORDER.map((s) => (
                            <SelectItem key={s} value={s}>
                              {severityTokens(s).label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
                <Field
                  label="Priority"
                  htmlFor="priority"
                  error={errors.priority?.message}
                  hint="0–1000, higher first"
                >
                  <Input
                    id="priority"
                    type="number"
                    min={0}
                    max={1000}
                    aria-invalid={!!errors.priority}
                    {...register('priority', { valueAsNumber: true })}
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          {/* Where — the frozen Location Hierarchy, consumed not redesigned (P-4) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Where</CardTitle>
              <CardDescription>
                Which parts of the estate this rule watches. A location includes everything beneath
                it.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Controller
                control={control}
                name="scopeNodeIds"
                render={({ field }) => (
                  <RuleScopeField nodeIds={field.value} onChange={field.onChange} />
                )}
              />
            </CardContent>
          </Card>

          {/* Matching */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Matching</CardTitle>
              <CardDescription>
                Which events this rule considers, and the condition.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                label="Event types"
                htmlFor="eventTypesText"
                error={errors.eventTypesText?.message}
                hint="One dotted type per line (e.g. perception.person.detected). Empty = any type."
              >
                <Textarea
                  id="eventTypesText"
                  rows={3}
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="perception.person.detected"
                  {...register('eventTypesText')}
                />
              </Field>

              <Field
                label="Categories"
                error={errors.categories?.message}
                hint="Empty = any category."
              >
                <Controller
                  control={control}
                  name="categories"
                  render={({ field }) => (
                    <div className="flex flex-wrap gap-3">
                      {EventCategory.options.map((cat) => {
                        const checked = field.value.includes(cat);
                        return (
                          <label
                            key={cat}
                            className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                          >
                            <input
                              type="checkbox"
                              className="size-4 accent-primary focus-ring rounded"
                              checked={checked}
                              onChange={(e) =>
                                field.onChange(
                                  e.target.checked
                                    ? [...field.value, cat]
                                    : field.value.filter((c: string) => c !== cat),
                                )
                              }
                            />
                            {cat}
                          </label>
                        );
                      })}
                    </div>
                  )}
                />
              </Field>

              <Field
                label="Condition (optional)"
                htmlFor="conditionText"
                error={errors.conditionText?.message}
                hint='JSON predicate tree, e.g. {"all":[{"field":"confidence","op":"gte","value":0.8}]}'
              >
                <Textarea
                  id="conditionText"
                  rows={5}
                  spellCheck={false}
                  className="font-mono text-xs"
                  {...register('conditionText')}
                />
              </Field>

              <div className="rounded-md border border-border p-3">
                <Controller
                  control={control}
                  name="windowEnabled"
                  render={({ field }) => (
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-foreground">
                        Windowed threshold
                        <span className="ml-2 font-normal text-text-subtle">
                          Fire only after N matches within a time window
                        </span>
                      </span>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </label>
                  )}
                />
                {windowEnabled ? (
                  <div className="mt-3 grid gap-4 sm:grid-cols-3">
                    <Field
                      label="Within (seconds)"
                      htmlFor="windowWithinSeconds"
                      error={errors.windowWithinSeconds?.message}
                    >
                      <Input
                        id="windowWithinSeconds"
                        type="number"
                        min={1}
                        {...register('windowWithinSeconds', { valueAsNumber: true })}
                      />
                    </Field>
                    <Field label="Count" htmlFor="windowCount" error={errors.windowCount?.message}>
                      <Input
                        id="windowCount"
                        type="number"
                        min={1}
                        {...register('windowCount', { valueAsNumber: true })}
                      />
                    </Field>
                    <Field label="Group by" error={errors.windowGroupBy?.message}>
                      <Controller
                        control={control}
                        name="windowGroupBy"
                        render={({ field }) => (
                          <Select value={field.value} onValueChange={field.onChange}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="camera">Camera</SelectItem>
                              <SelectItem value="zone">Zone</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Action */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Action</CardTitle>
              <CardDescription>What happens when the rule matches.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field label="Action type" error={errors.actionType?.message}>
                <Controller
                  control={control}
                  name="actionType"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="raise-incident">Raise incident</SelectItem>
                        <SelectItem value="emit-event">Emit event</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>

              {actionType === 'raise-incident' ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Title override (optional)"
                    htmlFor="actionTitle"
                    error={errors.actionTitle?.message}
                    hint="Defaults to the rule name + triggering event."
                  >
                    <Input id="actionTitle" {...register('actionTitle')} />
                  </Field>
                  <Field label="Severity override" error={errors.actionSeverity?.message}>
                    <Controller
                      control={control}
                      name="actionSeverity"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">Inherit rule severity</SelectItem>
                            {SEVERITY_ORDER.map((s) => (
                              <SelectItem key={s} value={s}>
                                {severityTokens(s).label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                </div>
              ) : (
                <Field
                  label="Emitted event type"
                  htmlFor="actionEventType"
                  error={errors.actionEventType?.message}
                  hint="Dotted type, e.g. analytics.occupancy.exceeded"
                >
                  <Input
                    id="actionEventType"
                    className="font-mono text-xs"
                    {...register('actionEventType')}
                  />
                </Field>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center justify-end gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/rules">Cancel</Link>
            </Button>
            <Button type="submit" size="sm" loading={saving} disabled={isEdit && !isDirty}>
              {isEdit ? 'Save changes' : 'Create rule'}
            </Button>
          </div>
        </form>

        {isEdit && id ? (
          <aside className="space-y-6">
            <Card>
              <CardContent className="pt-6">
                <RuleValidationPanel ruleId={id} />
              </CardContent>
            </Card>
            {/* How the rule is doing, as opposed to whether it would save (P-4.2). */}
            <Card>
              <CardContent className="pt-6">
                <RuleHealthPanel ruleId={id} />
              </CardContent>
            </Card>
            <RuleDryRunPanel ruleId={id} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Data, permission and guard shell for the rule editor.
 *
 * ⚠️ **`key={rule?.id ?? 'new'}` is the fix for TD-21, not a tidy-up.** React Hook Form reads
 * `defaultValues` once, at mount, and a Radix `Select` cannot adopt a value that arrives later — its
 * items are inside a portal that is unmounted while the menu is closed. Keying the form on the rule
 * guarantees it mounts exactly once, with the values it will display.
 *
 * The guards live here so the form below can assume its data exists.
 */
export function RuleEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const canCreate = usePermission('rule:create');
  const canUpdate = usePermission('rule:update');
  const authorized = isEdit ? canUpdate : canCreate;
  const ruleQuery = useRule(id);

  if (!authorized) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description={`You don't have permission to ${isEdit ? 'edit' : 'create'} rules.`}
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/rules">Back to rules</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (isEdit && ruleQuery.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isEdit && ruleQuery.isError) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-6">
        <Alert variant="critical">
          {ruleQuery.error instanceof ApiRequestError && ruleQuery.error.status === 404
            ? 'This rule no longer exists.'
            : 'Could not load the rule.'}
        </Alert>
      </div>
    );
  }

  return <RuleEditorForm key={ruleQuery.data?.id ?? 'new'} id={id} rule={ruleQuery.data} />;
}
