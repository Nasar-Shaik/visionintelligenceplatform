#!/usr/bin/env bash
# Eight deliberate breaks — does each loitering check fail for its OWN reason?
#
# ⚠️ "Something failed" is nearly worthless. Stamping the wrong zone must fail the ZONE check; if it
# fails "the live rule raised an incident" instead, the suite caught a problem and cannot say which.
# A mutation that goes red elsewhere is a failure of the harness, not a success.
#
# ⚠️ Long. It rebuilds services between mutations, so it belongs in a nightly profile and nowhere in
# an interactive loop.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/loitering-mutations.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "mutation script not found"; finish; }

# ⚠️ The undo restores the tree AND rebuilds every mutated service. A run killed mid-mutation
# otherwise leaves a deliberately broken image serving production traffic until somebody notices.
guard "cd '$REPO' && node $SCRIPT restore"

note "rule disabled, wrong zone, wrong dwell, fragmentation, missing identity, event loss, duplicates, suppression"
OUT_LOG="$(metrics_path loitering-mutations).log"
node "$SCRIPT" | tee "$OUT_LOG"
RC=${PIPESTATUS[0]}
unguard

RIGHT=$(grep -c '   ✓$' "$OUT_LOG" 2>/dev/null || echo 0)
TOLERATED=$(grep -c '· tolerated' "$OUT_LOG" 2>/dev/null || echo 0)

if [ "$RC" -eq 0 ]; then
  ok "every mutation went red at the check that names its fault"
else
  bad "the mutation suite failed (exit $RC)"
fi
headline "${RIGHT} mutation(s) red at the naming check, ${TOLERATED} tolerated with a recorded reason"

finish
