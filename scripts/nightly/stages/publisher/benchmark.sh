#!/usr/bin/env bash
# Publisher capacity — publish latency, queue occupancy, what is shed, and what survives to an event.
#
# ⚠️ A third benchmark, and separate for the same reason the first two are. `runtime/benchmark.sh`
# measures how many frames the platform can analyse; `tracking/benchmark.sh` measures whether
# identity survives while it does; this measures whether those results can be PUBLISHED. They
# diverge: a host that analyses and tracks sixteen cameras may still shed events at eight, and no
# single number can say so.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/event-bridge-benchmark.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "publisher benchmark not found"; finish; }

node docs/review/p8/tracking-fixtures.mjs >/dev/null || {
  bad "could not build the motion fixtures"
  headline "fixtures unavailable"
  finish
}

guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path publisher-benchmark)"
rm -f "$SAMPLES"
note "capacity ladder measuring BOTH ends of the bridge — published is not persisted"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

[ "$RC" -eq 0 ] && ok "publisher capacity measured" || bad "the publisher benchmark reported failures (exit $RC)"

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const rows = d.rows || [];
    if (!rows.length) { console.log("no rungs"); process.exit(0); }
    const top = rows[rows.length - 1];
    const shed = rows.find((r) => (r.droppedQueueFull ?? 0) > 0);
    const latency = Math.max(...rows.map((r) => r.publishMsAvg ?? 0));
    console.log(
      `top rung ${top.cameras} cams ${top.publishedPerSecond}/s published, ` +
      `${top.persistedPerSecond ?? "n/a"}/s persisted · publish ≤${latency.toFixed(2)}ms · ` +
      (shed ? `shedding from ${shed.cameras} cams` : "no shedding") +
      ` · sizing unchanged (2 supported / 4 provisional)`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
