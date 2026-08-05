#!/usr/bin/env bash
# Six deliberate breaks — does the bridge verification fail for the RIGHT reason?
#
# ⚠️ **This stage edits source files, rebuilds the media image, and stops the broker.** It restores
# every one of them from a byte snapshot in a `finally`, and the guard below repeats that if the
# stage is killed. Turn it off (`RUN_BRIDGE_MUTATION=false`) on any machine where a half-restored
# deployment would matter more than the answer.
#
# ⚠️ What it asserts is not "the verification went red" — that is nearly worthless. It asserts each
# break turns red at the CHECK THAT NAMES IT. A mutation that goes red somewhere else has caught a
# problem while being unable to say which, and is recorded here as a failure of the harness.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/event-bridge-mutations.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "bridge mutation harness not found"; finish; }

node docs/review/p8/tracking-fixtures.mjs >/dev/null || {
  bad "could not build the motion fixtures"
  headline "fixtures unavailable"
  finish
}

# ⚠️ The undo restores the SOURCE and the deployment, not just the fixtures — a killed mutation run
# otherwise leaves a mutated publisher in the running image and every later stage measures that.
guard "cd '$REPO' && node $SCRIPT restore"

note "publisher disabled · queue overflow · schema corruption · ordering · retry disabled · broker down"
node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "every mutation went red at the check that names it"
else
  bad "the bridge mutation harness reported failures (exit $RC)"
fi

RESULTS="docs/review/p8/event-bridge-mutations.json"
if [ -f "$RESULTS" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const rows = d.results || [];
    const named = rows.filter((r) => (r.named || []).length > 0).length;
    console.log(
      `${named}/${rows.length} mutation(s) red at the named check · ` +
      `restored ${d.restoredGreen ? "green" : "RED — the deployment may be mutated"}`,
    );
  ' "$RESULTS" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
