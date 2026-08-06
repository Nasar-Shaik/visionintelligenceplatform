#!/usr/bin/env bash
# Camera Processing Assignment, end to end — does an ASSIGNED camera become an incident candidate,
# and does an unassigned one keep recording?
#
# ⚠️ The negative half is why this stage exists. Every other events stage proves the platform CAN
# analyse a camera; this one proves it can decline to, on the same deployment at the same time. A
# gate that let everything through would pass every other stage in this file.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/assignment.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "assignment script not found"; finish; }

# ⚠️ The run creates cameras AND a verification rule. If it is killed between the two, an ENABLED
# rule is left raising candidates for every person detection in the tenant — so the undo is
# registered before anything is created, not after.
guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path assignment)"
rm -f "$SAMPLES"
note "three cameras recording, one assigned — selectivity, hot assignment, pause, release, re-enable"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "an assigned camera became an incident candidate; an unassigned one recorded and was never analysed"
else
  bad "the assignment verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const row = d.targetRow ?? {};
    const cap = d.capacity ?? {};
    const rt = (d.runtimes ?? [])[0] ?? {};
    const supported = (d.profiles ?? []).filter((p) => p.supported === true).length;
    const unsupported = (d.profiles ?? []).filter((p) => p.supported === false).length;
    console.log(
      `${cap.assignedCameras ?? "?"} assigned · ${cap.idleCameras ?? "?"} recording-only · ` +
      `${row.framesDelivered ?? 0} frames · ${row.eventsPublished ?? 0} events · ` +
      `runtime ${rt.health ?? "?"} · profiles ${supported} supported / ${unsupported} not`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
