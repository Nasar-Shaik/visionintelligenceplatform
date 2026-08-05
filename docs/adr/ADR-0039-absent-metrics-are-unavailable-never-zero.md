# ADR-0039 — A metric that was not measured is reported unavailable, never zero

- **Status:** Accepted
- **Date:** 2026-08-05
- **Milestone:** P-8 Phase 4 freeze (object tracking)
- **Scope:** platform-wide — applies to every subsystem from here on, not only to tracking
- **Related:** [ADR-0038](ADR-0038-track-identity-across-gaps.md) (track identity across gaps),
  [ADR-0002](ADR-0002-model-agnostic-capability-runtime.md) (model-agnostic runtime)

## Context

The Phase 4 freeze added eleven permanent tracking metrics. Eight of them are counts and timings the
runtime can produce from what it already knows. **Three of them are not measurable at all on a live
camera**, and discovering which three was the work:

| Metric                        | Asks                                      | Needs                              |
| ----------------------------- | ----------------------------------------- | ---------------------------------- |
| `identitySwitches`            | did the tracker give A's identity to B?   | which real object each track _was_ |
| `reidentificationSuccessRate` | was the returning person the same person? | the same                           |
| `falseRecoveries`             | was a link formed between two strangers?  | the same                           |

Each asks whether the tracker was **right**. Being right is defined against ground truth — a record
of which real object each identity belonged to — and a camera does not carry one. An identity switch
is not a subtle signal that a better implementation could detect: on the frame it happens, two people
are in the scene and two identities continue. Nothing observable distinguishes the correct assignment
from the exchanged one.

The obvious implementations are all wrong in the same direction:

- **Emit `0`.** The dashboard then shows a verified-looking clean record that nothing verified.
- **Omit the field.** "Not measurable here" becomes indistinguishable from "the exporter is broken"
  or "this runtime is an old build", and the operator has no way to tell which they are looking at.
- **Estimate it from fragmentation.** Fragmentation is a _symptom_ of switching and also of frame
  loss, occlusion and a person leaving. A number derived from it would be a guess wearing the name
  of a measurement.

This platform's output becomes evidence. A confident wrong number is its worst failure mode, and it
is worse than a blank.

## Decision

**A metric the system did not measure is reported as unavailable, with the reason, in the same place
the measured metrics appear. It is never zero, never omitted, and never estimated.**

Four consequences, which are the actual rules:

### 1. `null` means "measured as unmeasurable"; absent means "this build does not report it"

Two distinct statements that must not collapse into one. The JSON runtime reports
`identitySwitches: null` and carries a sibling object saying why:

```json
"groundTruth": {
  "available": false,
  "reason": "these ask whether an identity was CORRECT, which is only answerable against ground truth…",
  "metrics": ["identitySwitches", "reidentificationSuccessRate", "falseRecoveries"],
  "measuredBy": "docs/review/p8/tracking.mjs"
}
```

The contract types them `.nullable().optional()` for exactly this reason: `null` from a current
runtime, `undefined` from one that predates the metric.

### 2. Prometheus omits the series and publishes a flag instead

Prometheus has no null, and a gauge is a number. So the three series are **not emitted**, and
`inference_tracking_ground_truth_available 0` is emitted in their place. A dashboard can then
distinguish "not measurable in this deployment" from "the scrape failed", and an alert on the absent
series cannot be written by accident.

The same rule governs the derived averages: `averageTrackLifetimeSeconds` is omitted until something
has been tracked, because a gauge reading `0` there says "tracks last no time at all".

### 3. The UI renders the absence, and names the reason

The statistics page has a **Not measurable here** card carrying all three rows and the runtime's own
explanation. Hiding them would satisfy the letter of this decision and break its purpose.

### 4. Where ground truth exists, the metric is measured for real — and says what it was measured on

The numbers do exist. `docs/review/p8/tracking.mjs` plays clips whose trajectories were authored
before the run, so "was the tracker right?" has an answer; it emits `tracking-truth.json` with six
measurements, and the nightly report presents them in a **separate section** from the load ladder.

⚠️ **Every one of those numbers travels with its caveat attached**, in the file, in the ledger and in
the report: they are measured against authored synthetic clips and certify the tracking _logic_, not
the platform against real CCTV. L-1 stands — no camera has ever been connected.

## Consequences

**Good.** A reader of any tracking surface can tell measured from unmeasurable without knowing how
the tracker works. The three hardest metrics get real values from the one place that can produce
them. The rule generalises: the Rule Engine's precision and recall are the same kind of quantity and
will be governed by this ADR rather than re-litigated.

**Costly.** Three permanently empty cells on an operator page need explaining, every time somebody
new sees them. That cost is paid deliberately — the alternative is three cells that read `0` and are
never questioned.

⚠️ **This constrains what may be built later.** A future "tracking accuracy" summary, health score or
SLA cannot be computed from live runtime statistics. If one is wanted it must be sourced from
authored scenarios, or from a labelled dataset that does not exist yet, and it must carry the same
caveat. A single blended number that hides which parts were measured would undo this decision while
appearing to honour it.

⚠️ **It does not license absence as a default.** "Report it unavailable" is the correct answer only
when the quantity is genuinely unmeasurable in that context. A metric that is merely inconvenient to
compute must be computed. The test is whether a correct value _could_ be derived from information the
system holds — not whether deriving it is work.

## Alternatives considered

**Emit zero and document the caveat in a README.** Rejected. The number is read on a dashboard and
the README is not. Documentation does not travel with a value; a `null` and a reason field do.

**Omit the metrics entirely.** Rejected — see the context table. It makes an honest absence
indistinguishable from a fault, which is the failure the platform's whole verification argument is
built to avoid.

**Estimate switches from fragmentation and flag them "approximate".** Rejected. A label saying
"approximate" survives one dashboard, one export or one screenshot before the number is alone. On an
evidence product the number has to be defensible without its footnote.

**Publish accuracy from the capacity ladder.** Rejected, and worth stating because it looked
attractive: the ladder runs one walking person per camera, so "identities minus cameras" is tempting
to call a switch count. It is not — it is fragmentation, and at 16 cameras the ladder produces extra
identities for reasons that are entirely about frame loss. Naming that "identity switches" would have
put a plausible number on the most misleading possible page.
