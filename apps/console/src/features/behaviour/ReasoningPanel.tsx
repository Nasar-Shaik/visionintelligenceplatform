import { useMemo, useState } from 'react';
import { ArrowDown, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import type {
  BehaviourCandidate,
  BehaviourReasonLink,
  BehaviourRule,
  BehaviourStep,
} from '@vip/contracts';
import { Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui';
import { useAppSelector } from '@/app/hooks';
import { EvidenceTag, SeekControl, type RecordingClock } from './parts';
import { STEP_KINDS, stepPhrase } from './vocabulary';
import { useEvaluateBehaviour } from './useBehaviour';

/**
 * **The reasoning chain viewer** (Phase 2.4 slice 2.8) — a rule, the subjects that matched it, and
 * the WHY chain that says so.
 *
 *     candidate  ──▶  WHY  ──▶  step ──▶ step ──▶ step  ──▶  rule matched
 *                              each one a graph fact, each one a frame
 *
 * ### ⛔ It says CANDIDATE, and it will keep saying candidate
 *
 * What this layer establishes is that a described sequence of geometry occurred. Whether that
 * warrants an incident, a notification or a shrug is a decision with a human and a policy behind it
 * — so nothing here creates an incident, and the word is not used for something that is not one.
 * The requested reading is *"incident ↓ WHY ↓ …"*; what the platform can honestly render is
 * *"candidate ↓ WHY ↓ …"*, and the difference is the whole of ADR-0052.
 *
 * ### ⛔ The operator writes the rule, because the platform ships none
 *
 * There is no behaviour-rule store yet — slice 2.7's stated boundary — so a rule travels in the
 * request. That is not a gap this panel papers over; it is the honest shape of the feature today,
 * and it has a property worth keeping: nothing on this screen can be mistaken for a configured rule
 * set, because the operator had to compose it. `candidateLabel` is the **only** place in the platform
 * where an intent may be named, and it is typed by a person here rather than compiled into anything.
 *
 * ### ⚠️ Confidence is a coverage measure and is labelled as one
 *
 * It is the share of the chain's links whose evidence carries a frame reference. A rule whose every
 * link is seekable scores 1.0. Rendering it as "confidence: 80 %" without that sentence beside it
 * would invite somebody to read it as "probably a thief", which this layer has no basis to claim.
 */
export interface ReasoningPanelProps {
  streamId: string | undefined;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  onSelectIdentity: (identityId: string | undefined) => void;
  /** Reported upwards so the graph can light the edges a chain used. */
  onHighlightEdges: (edgeIds: string[]) => void;
  /** Zones and lines seen in this run, offered as filter values rather than free text. */
  zoneIds: readonly string[];
  objectLabels: readonly string[];
}

interface DraftStep {
  key: string;
  kind: string;
  zoneId: string;
  objectLabel: string;
  minSeconds: string;
  absent: boolean;
}

let nextKey = 0;
const newStep = (kind = 'visited'): DraftStep => ({
  key: `s${String((nextKey += 1))}`,
  kind,
  zoneId: '',
  objectLabel: '',
  minSeconds: '',
  absent: false,
});

export function ReasoningPanel({
  streamId,
  clock,
  onSeek,
  onSelectIdentity,
  onHighlightEdges,
  zoneIds,
  objectLabels,
}: ReasoningPanelProps) {
  const tenantId = useAppSelector((s) => s.session.tenantId);
  const [name, setName] = useState('Sequence I am investigating');
  const [label, setLabel] = useState('Matched the sequence');
  const [withinSeconds, setWithinSeconds] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([newStep('visited'), newStep('linger')]);
  const evaluate = useEvaluateBehaviour(streamId);

  const rule = useMemo(
    () => buildRule({ tenantId: tenantId ?? '', name, label, withinSeconds, steps }),
    [tenantId, name, label, withinSeconds, steps],
  );

  const result = evaluate.data;

  return (
    <section className="space-y-4" data-testid="reasoning-panel">
      {/* --- the rule ---------------------------------------------------------------------- */}
      <div className="space-y-3 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="rule-name">Rule name</Label>
            <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} className="w-56" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-label">
              {/* ⛔ The only place an intent may be named, and a person types it. */}
              Call a subject that matches
            </Label>
            <Input id="rule-label" value={label} onChange={(e) => setLabel(e.target.value)} className="w-56" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rule-within">Within (seconds, optional)</Label>
            <Input
              id="rule-within"
              inputMode="numeric"
              value={withinSeconds}
              onChange={(e) => setWithinSeconds(e.target.value)}
              className="w-36"
              placeholder="no window"
            />
          </div>
        </div>

        <ol className="space-y-2">
          {steps.map((step, index) => (
            <li key={step.key} className="flex flex-wrap items-end gap-2" data-testid="rule-step">
              <span className="pb-2 text-xs text-muted-foreground">{index + 1}.</span>
              <div className="space-y-1">
                <Label htmlFor={`${step.key}-kind`}>Then the subject…</Label>
                <Select
                  value={step.kind}
                  onValueChange={(value) => setSteps(replace(steps, index, { ...step, kind: value }))}
                >
                  <SelectTrigger id={`${step.key}-kind`} className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STEP_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {stepPhrase(kind)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {step.kind === 'visited' ? (
                <div className="space-y-1">
                  <Label htmlFor={`${step.key}-zone`}>in zone</Label>
                  <Input
                    id={`${step.key}-zone`}
                    list="behaviour-zone-ids"
                    value={step.zoneId}
                    placeholder="any"
                    onChange={(e) => setSteps(replace(steps, index, { ...step, zoneId: e.target.value }))}
                    className="w-40"
                  />
                </div>
              ) : null}

              {['carried', 'picked', 'dropped', 'wentMissing', 'returned', 'handedOver'].includes(step.kind) ? (
                <div className="space-y-1">
                  <Label htmlFor={`${step.key}-object`}>object</Label>
                  <Input
                    id={`${step.key}-object`}
                    list="behaviour-object-labels"
                    value={step.objectLabel}
                    placeholder="any"
                    onChange={(e) =>
                      setSteps(replace(steps, index, { ...step, objectLabel: e.target.value }))
                    }
                    className="w-36"
                  />
                </div>
              ) : null}

              <div className="space-y-1">
                <Label htmlFor={`${step.key}-min`}>for at least</Label>
                <Input
                  id={`${step.key}-min`}
                  inputMode="numeric"
                  value={step.minSeconds}
                  placeholder="0 s"
                  onChange={(e) => setSteps(replace(steps, index, { ...step, minSeconds: e.target.value }))}
                  className="w-24"
                />
              </div>

              {/* ⭐ The step that makes the language worth having: "…and never went to the till". */}
              <label className="flex items-center gap-1.5 pb-2 text-xs">
                <input
                  type="checkbox"
                  checked={step.absent}
                  data-testid={`${step.key}-absent`}
                  onChange={(e) => setSteps(replace(steps, index, { ...step, absent: e.target.checked }))}
                />
                never happened
              </label>

              <Button
                size="sm"
                variant="ghost"
                className="mb-1"
                aria-label={`Remove step ${String(index + 1)}`}
                disabled={steps.length === 1}
                onClick={() => setSteps(steps.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ol>

        <datalist id="behaviour-zone-ids">
          {zoneIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <datalist id="behaviour-object-labels">
          {objectLabels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setSteps([...steps, newStep()])}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add a step
          </Button>
          <Button
            size="sm"
            data-testid="evaluate-rule"
            disabled={evaluate.isPending || streamId === undefined || tenantId === null}
            onClick={() => {
              onHighlightEdges([]);
              evaluate.mutate([rule]);
            }}
          >
            {evaluate.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3.5 w-3.5" />
            )}
            {evaluate.isPending ? 'Evaluating…' : 'Evaluate over this run'}
          </Button>
          <p className="text-2xs text-muted-foreground">
            {/* ⚠️ Stated plainly: this is not a saved rule and it raises nothing. */}
            Evaluated on demand over this run's behaviour graph. Nothing is stored, and no incident is
            created — this reports subjects whose recorded geometry matches the sequence above.
          </p>
        </div>
      </div>

      {/* --- what came back ---------------------------------------------------------------- */}
      {evaluate.isError ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          {/* ⛔ A refusal reported as a refusal. `graph-unavailable` is a 503 with a reason, and it
              must never render as "no candidates" — those are opposite facts. */}
          {evaluate.error instanceof Error ? evaluate.error.message : 'The evaluation failed.'}
        </p>
      ) : null}

      {result === undefined ? null : (
        <div className="space-y-3" data-testid="reasoning-result">
          <p className="text-xs text-muted-foreground">
            {result.rulesEvaluated} rule(s) over {result.identitiesEvaluated} subject(s) in{' '}
            {result.elapsedMs} ms · {result.candidates.length} candidate(s)
          </p>
          {result.graphTruncated.relational ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-500">
              ⛔ Only {result.graphTruncated.identitiesConsidered} subject(s) were examined for
              relations. A step naming proximity, following or a group could not have matched for the
              rest, so its silence means nothing.
            </p>
          ) : null}

          {result.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-candidates">
              No subject in this run matched the sequence. ⚠️ That is a statement about this graph and
              this rule, not about the footage — a step whose kind never occurs (see the Primitive
              Inspector) can never match.
            </p>
          ) : (
            result.candidates.map((candidate) => (
              <CandidateCard
                key={`${candidate.ruleId}-${candidate.identityId}-${String(candidate.fromSeconds)}`}
                candidate={candidate}
                clock={clock}
                onSeek={onSeek}
                onSelectIdentity={onSelectIdentity}
                onHighlightEdges={onHighlightEdges}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function replace(steps: DraftStep[], index: number, next: DraftStep): DraftStep[] {
  return steps.map((step, i) => (i === index ? next : step));
}

/**
 * A draft as the contract's `BehaviourRule`.
 *
 * ⚠️ Empty filters are **omitted, not sent as empty strings**. `{ zoneId: '' }` is a rule that can
 * never match a zone; `{}` is "any zone", which is what an operator who left the box blank meant.
 */
export function buildRule(draft: {
  tenantId: string;
  name: string;
  label: string;
  withinSeconds: string;
  steps: DraftStep[];
}): BehaviourRule {
  const within = Number.parseFloat(draft.withinSeconds);
  return {
    id: 'rule_console_draft',
    tenantId: draft.tenantId,
    name: draft.name.trim() === '' ? 'Untitled sequence' : draft.name,
    version: 1,
    enabled: true,
    cameraIds: [],
    candidateLabel: draft.label.trim() === '' ? 'Matched the sequence' : draft.label,
    severity: 'medium',
    steps: draft.steps.map((step): BehaviourStep => {
      const min = Number.parseFloat(step.minSeconds);
      return {
        kind: step.kind as BehaviourStep['kind'],
        absent: step.absent,
        ...(step.zoneId.trim() === '' ? {} : { zoneId: step.zoneId.trim() }),
        ...(step.objectLabel.trim() === '' ? {} : { objectLabel: step.objectLabel.trim() }),
        ...(Number.isFinite(min) && min > 0 ? { minSeconds: min } : {}),
      };
    }),
    ...(Number.isFinite(within) && within >= 1 ? { withinSeconds: within } : {}),
  };
}

/**
 * One matched subject, and the chain that says why.
 *
 * ⭐ Rendered as the vertical flow an investigator reads top to bottom, because that is the order
 * the facts happened in — and every link is a click to the frame that established it.
 */
function CandidateCard({
  candidate,
  clock,
  onSeek,
  onSelectIdentity,
  onHighlightEdges,
}: {
  candidate: BehaviourCandidate;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
  onSelectIdentity: (identityId: string | undefined) => void;
  onHighlightEdges: (edgeIds: string[]) => void;
}) {
  const edgeIds = candidate.chain
    .map((link) => link.edgeId)
    .filter((id): id is string => id !== undefined);

  return (
    <article className="space-y-2 rounded-md border border-border p-3" data-testid="candidate">
      <header className="flex flex-wrap items-center gap-2">
        {/* ⛔ CANDIDATE. Not an incident, and the badge says so on every card. */}
        <Badge variant="warning">candidate</Badge>
        <strong className="text-sm">{candidate.label}</strong>
        <button
          type="button"
          className="text-xs hover:underline"
          onClick={() => onSelectIdentity(candidate.identityId)}
        >
          {candidate.identityId}
        </button>
        <span className="text-xs tabular text-muted-foreground">
          {/* ⛔ Offsets into the run. The footage clock is carried beside them and never printed as
              a position, because "at 1786221387.294 s" is true, useless, and has shipped once. */}
          {candidate.fromSeconds.toFixed(1)}–{candidate.toSeconds.toFixed(1)} s
        </span>
        <span className="text-xs text-muted-foreground" data-testid="candidate-confidence">
          {/* ⚠️ Labelled as coverage everywhere it appears. */}
          evidence coverage {(candidate.confidence * 100).toFixed(0)}%
        </span>
        {edgeIds.length === 0 ? null : (
          <Button size="sm" variant="ghost" onClick={() => onHighlightEdges(edgeIds)}>
            Show on the graph
          </Button>
        )}
      </header>

      <p className="text-sm">{candidate.summary}</p>
      <p className="text-2xs text-muted-foreground">
        Coverage is the share of this chain's links whose evidence carries a frame reference — a rule
        whose every link is seekable scores 100 %. ⛔ It is not a probability that the label is true.
      </p>

      <div className="space-y-1">
        <p className="text-2xs uppercase tracking-wide text-muted-foreground">Why</p>
        <ol className="space-y-1">
          {candidate.chain.map((link) => (
            <li key={link.index}>
              <ChainLink link={link} clock={clock} onSeek={onSeek} />
              {link.index < candidate.chain.length - 1 ? (
                <ArrowDown className="ml-3 h-3 w-3 text-muted-foreground" aria-hidden />
              ) : null}
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2 pt-1 text-xs">
          <ArrowDown className="ml-3 h-3 w-3 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">
            every step held in order · rule <strong>{candidate.ruleName}</strong> v
            {candidate.ruleVersion} matched · reported as a candidate
          </span>
        </div>
      </div>
    </article>
  );
}

function ChainLink({
  link,
  clock,
  onSeek,
}: {
  link: BehaviourReasonLink;
  clock: RecordingClock;
  onSeek: (offsetSeconds: number) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-sm border border-border/60 px-2 py-1 text-xs"
      data-testid="chain-link"
      data-matched={link.matched}
      data-absent={link.step.absent}
    >
      <Badge variant={link.matched ? 'success' : 'neutral'}>
        {link.step.absent ? 'never' : link.matched ? 'yes' : 'no'}
      </Badge>
      <span>{link.reason}</span>
      {link.atSeconds === undefined ? null : (
        <span className="tabular text-muted-foreground">
          {link.atSeconds.toFixed(1)} s
          {link.seconds === undefined ? '' : ` · ${link.seconds.toFixed(1)} s`}
        </span>
      )}
      <EvidenceTag evidence={link.evidence as { frameIndex?: number; trackId?: string }} />
      {/* ⛔ An `absent` step's strength is the search behind it. "0 facts of that kind were examined"
          and "seven were checked and none was the till" both satisfy the step; only one is worth
          acting on, and the difference is invisible unless it is printed. */}
      {link.step.absent && link.considered !== undefined ? (
        <span className="text-2xs text-muted-foreground" data-testid="absence-strength">
          {link.considered} fact(s) of that kind were examined
        </span>
      ) : null}
      {link.footageAtSeconds === undefined ? null : (
        <SeekControl
          footageSeconds={link.footageAtSeconds}
          clock={clock}
          onSeek={onSeek}
          size="xs"
        />
      )}
    </div>
  );
}
