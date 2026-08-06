#!/usr/bin/env bash
# The loitering capacity ladder — three separated latencies, throughput, zone cost, resources.
#
# ⚠️ Every latency here is the PLATFORM's own measurement, read from /metrics, and null when nothing
# was observed in the window. P-8 Phase 6 shipped two latency metrics that FELL as load rose; one was
# impossible and anyone would have caught it, the other was merely bad and would have shipped. A
# window mean that falls back to a lifetime mean is how a ladder reports the previous rung's number.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/loitering-benchmark.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "benchmark script not found"; finish; }

guard "cd '$REPO' && node $SCRIPT clean"

LADDER="${LOITERING_LADDER:-1,2,4}"
SAMPLES="$(metrics_path loitering-capacity)"
rm -f "$SAMPLES"
note "ladder $LADDER — event→rule, rule→candidate, end-to-end, separated"
OUT="$SAMPLES" LADDER="$LADDER" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "the ladder completed"
else
  bad "the loitering benchmark failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const rungs = d.rungs ?? [];
    const first = rungs[0] ?? {};
    const last = rungs[rungs.length - 1] ?? {};
    const ms = (v) => (v === null || v === undefined ? "—" : v.toFixed(0) + "ms");
    console.log(
      `${rungs.length} rung(s) · end-to-end ${ms(first.endToEndMs)} → ${ms(last.endToEndMs)} · ` +
      `rule ${ms(first.ruleToCandidateMs)} → ${ms(last.ruleToCandidateMs)} · ` +
      `rules ${last.rulesCpuPct ?? "?"}% / ${last.rulesMemMb ?? "?"}MB · ` +
      `sizing unchanged (2 supported, 4 provisional)`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
