#!/usr/bin/env bash
# Tracking mutation verification — five breaks, each asserted to fail at the check that names it.
#
# ⚠️ EDITS REAL SOURCE FILES and REBUILDS the runtime image. Restores from a byte snapshot in a
# `finally`, and the engine runs the guard below if this stage is killed. Never run it with
# uncommitted work in flight — that is what REQUIRE_CLEAN_TREE enforces in pre-flight.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/tracking-mutations.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "tracking mutations not found"; finish; }

node docs/review/p8/tracking-fixtures.mjs >/dev/null || {
  bad "could not build the motion fixtures"
  headline "tracking fixtures unavailable"
  finish
}

# ⚠️ The undo the engine runs if this stage dies: rebuild the runtime from the committed source and
# remove any fixture cameras. Without it a killed run leaves a mutated tracker deployed until morning.
guard "cd '$REPO' && node $SCRIPT restore"

OUTPUT="$RUN_DIR/logs/tracking-mutations.out"
node "$SCRIPT" 2>&1 | tee "$OUTPUT"
RC=${PIPESTATUS[0]}

unguard

RED_THEN_GREEN=$(grep -c 'it goes red at the check that names this fault' "$OUTPUT" 2>/dev/null || echo 0)
FAILED=$(grep -c '^    ✗' "$OUTPUT" 2>/dev/null || echo 0)

if [ "$RC" -eq 0 ]; then
  ok "$RED_THEN_GREEN mutation(s) went red at the named check and green again"
  headline "$RED_THEN_GREEN tracking mutation(s) red-then-green"
else
  bad "tracking mutation verification failed (exit $RC)"
  headline "$RED_THEN_GREEN red-then-green · $FAILED check(s) failed"
fi
finish
