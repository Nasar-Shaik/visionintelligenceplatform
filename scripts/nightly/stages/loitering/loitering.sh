#!/usr/bin/env bash
# Retail Loitering, camera to candidate — does a person standing in a zone become an incident?
#
# ⚠️ Three things are asserted on one deployment at one moment, and the run is only meaningful
# because of the last two: a subject INSIDE the zone fires; a control camera with NO zone produces
# events carrying no zone, ever; and a dry-run twin with the same threshold raises nothing while its
# clock advances and its withheld candidates accumulate. A dry run that silently did not evaluate
# would look identical to one that evaluated and withheld — `withheld > 0` is what separates them.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/loitering.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "loitering script not found"; finish; }

# ⚠️ The run creates cameras, zones AND two enabled rules. Killed between them, it would leave
# rules raising candidates for every person detection in the tenant — so the undo is registered
# before anything is created, not after.
guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path loitering)"
rm -f "$SAMPLES"
note "one camera with a zone, one without, one live rule, one dry-run twin"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "a person in a zone became an incident candidate; a camera with no zone never stamped one"
else
  bad "the loitering verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const s = d.samples ?? {};
    const inc = s.incident ?? {};
    const e = inc.explanation ?? {};
    const z = (s.gate?.pipeline?.zones) ?? {};
    const dry = s.dryRun ?? {};
    console.log(
      `${s.incidents ?? 0} incident(s) · ${(inc.durationSeconds ?? 0).toFixed(1)}s dwell · ` +
      `${e.observations ?? "?"} obs every ~${(e.typicalGapSeconds ?? 0).toFixed(1)}s · ` +
      `${z.insideDetections ?? 0}/${z.detectionsTested ?? 0} in zone · ` +
      `dry run withheld ${dry.withheld ?? 0}`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
