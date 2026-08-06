#!/usr/bin/env bash
# Does the assignment verification fail for the right reason?
#
# ⚠️ Eight deliberate breaks, each required to turn the verification red AT THE CHECK THAT NAMES IT.
# "Something failed" is nearly worthless: a mutation that goes red somewhere else means the suite
# caught a problem and cannot say which, and it is recorded as a failure of the harness.
#
# ⚠️ This stage REBUILDS IMAGES and RESTARTS CONTAINERS. It must not run beside anything else that
# touches the deployment, and its undo restores the working tree from a byte snapshot rather than
# from git — reverting to HEAD once destroyed an uncommitted fix.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/assignment-mutations.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "assignment mutation script not found"; finish; }

guard "cd '$REPO' && node $SCRIPT restore"
note "assignment disabled · runtime offline · wrong runtime · corruption · ordering · duplicate · persistence · capacity"
node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "every assignment property is verified by a check that fails when it is broken"
  headline "8 mutations, each red at the check naming the fault"
else
  bad "the assignment mutation suite failed (exit $RC)"
  headline "assignment mutations RED"
fi
finish
