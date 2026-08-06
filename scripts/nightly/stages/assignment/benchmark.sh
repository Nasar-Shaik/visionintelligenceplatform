#!/usr/bin/env bash
# What the assignment layer costs at 1 → 16 cameras.
#
# ⚠️ Every rung ASSIGNS the cameras it creates. A ladder that started cameras without assigning them
# would measure the skip path — one map lookup per frame — and report it as the cost of the
# subsystem.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/assignment-benchmark.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "assignment benchmark script not found"; finish; }

guard "cd '$REPO' && node $SCRIPT clean"
LADDER_OUT="$(metrics_path assignment-capacity)"
rm -f "$LADDER_OUT"
note "assignment latency, runtime latency, fps, queue, utilisation, CPU and memory at 1 → 16 cameras"
OUT="$LADDER_OUT" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "the assignment capacity ladder completed"
else
  bad "the assignment capacity ladder failed (exit $RC)"
fi

if [ -f "$LADDER_OUT" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const rows = d.rows ?? [];
    const top = rows[rows.length - 1] ?? {};
    const drops = rows.reduce((n, r) => n + (r.dropped ?? 0), 0);
    const refused = rows.reduce((n, r) => n + (r.refused ?? 0), 0);
    const lat = top.assignmentLatencyMs == null ? "not measured" : `${top.assignmentLatencyMs.toFixed(0)}ms`;
    console.log(
      `${rows.length} rung(s) to ${top.cameras ?? "?"} cameras · assign ${lat} · ` +
      `fps/cam ${top.processingFpsPerCamera ?? "?"} · ${drops} dropped · ${refused} refused`,
    );
  ' "$LADDER_OUT" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

# ⚠️ Restated every night. A rung table in a run directory is read as a capacity recommendation by
# whoever finds it next, and one run recommends nothing.
note "sizing policy unchanged: 2 cameras supported, 4 provisional, three agreeing runs before any change"
finish
