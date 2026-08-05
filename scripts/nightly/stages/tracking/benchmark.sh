#!/usr/bin/env bash
# Tracking capacity — tracks/s, identity stability, lost, recovered, CPU, RAM at 1 → 16 cameras.
#
# ⚠️ Separate from `runtime/benchmark.sh` and deliberately so. That one measures how many frames the
# platform can analyse; this one measures whether IDENTITY survives while it does. They diverge:
# a host that analyses every frame can still fragment every identity, and one number cannot say so.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/tracking-benchmark.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "tracking benchmark not found"; finish; }

node docs/review/p8/tracking-fixtures.mjs >/dev/null || {
  bad "could not build the motion fixtures"
  headline "tracking fixtures unavailable"
  finish
}

guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path tracking-benchmark)"
rm -f "$SAMPLES"
note "capacity ladder with one walking person per camera"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

[ "$RC" -eq 0 ] && ok "tracking capacity measured" || bad "the tracking benchmark reported failures (exit $RC)"

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const rows = d.rows || [];
    if (!rows.length) { console.log("no rungs"); process.exit(0); }
    const top = rows[rows.length - 1];
    const clean = rows.filter((r) => r.identityOverhead === 0).map((r) => r.cameras);
    const cost = Math.max(...rows.map((r) => r.trackingMsAvg ?? 0));
    console.log(
      `identity intact to ${clean.length ? Math.max(...clean) : 0} cameras · ` +
      `top rung ${top.cameras} cams ${top.dropPercent.toFixed(1)}% dropped, ${top.identityOverhead} extra ids · ` +
      `tracking ${cost.toFixed(2)}ms/frame`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
