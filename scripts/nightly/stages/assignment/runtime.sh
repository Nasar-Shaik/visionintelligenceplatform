#!/usr/bin/env bash
# Runtime orchestration — health, capacity, failover, persistence.
#
# ⚠️ This is the stage that covers the cases an operator actually meets: a runtime that stops
# answering, a runtime that is full, and a restart. The happy path is another stage's job, and a
# night that only ran the happy path would report a healthy platform through every one of these.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/assignment-runtime.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "assignment runtime script not found"; finish; }

# ⚠️ The run REGISTERS runtimes and DISABLES the deployment's own. If it is killed mid-way the
# platform is left unable to place anything, so the undo is registered before anything is touched.
guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path assignment-runtime)"
rm -f "$SAMPLES"
note "an unreachable runtime, a full runtime, a failover, and a restart of both halves"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "health is measured, capacity is enforced, failover moves only what it must, assignments survive a restart"
else
  bad "the runtime orchestration verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const before = (d.beforeFailover ?? [])[0] ?? {};
    const after = (d.afterFailover ?? [])[0] ?? {};
    const gate = d.gateAfterRestart ?? {};
    console.log(
      `dead runtime ${d.dead?.health ?? "?"} · failover ${before.runtimeId ?? "?"} → ${after.runtimeId ?? "?"} · ` +
      `plan ${gate.planVersion ?? "?"} re-applied · ${gate.plannedCameras ?? "?"} camera(s) after restart`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
