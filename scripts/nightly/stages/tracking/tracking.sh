#!/usr/bin/env bash
# Object tracking, end to end — the five identity properties, against authored ground truth.
#
# ⚠️ This is the only stage in the framework that asks "was the answer RIGHT?" rather than "did the
# platform answer?". It can only ask that because the input is authored: four clips with known
# trajectories, played through real RTSP. See docs/review/p8/tracking.mjs.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

TRACKING="docs/review/p8/tracking.mjs"
FIXTURES="docs/review/p8/tracking-fixtures.mjs"
[ -f "$TRACKING" ] || { bad "missing $TRACKING"; headline "tracking script not found"; finish; }

# The clips are generated rather than committed — derived binary that any machine rebuilds in
# twenty seconds. ⚠️ Regenerated every night on purpose: they are built from the boxes the DEPLOYED
# model returns, so a model change that moves the crops must move the fixtures with it.
note "building motion fixtures from the deployed model"
node "$FIXTURES" --verify || {
  bad "the fixtures are not usable — the model could not see them, or the background is not empty"
  headline "tracking fixtures unusable"
  finish
}

# It creates cameras and an RTSP fixture container through the real API.
guard "cd '$REPO' && node $TRACKING clean"

SAMPLES="$(metrics_path tracking)"
rm -f "$SAMPLES"
OUT="$SAMPLES" node "$TRACKING"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "identity holds across every authored scenario"
else
  bad "tracking verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const r = d.results || {};
    const bits = [];
    if (r.walk) bits.push(`walk ${r.walk.ids.length} id`);
    if (r.occlusion) bits.push(`occlusion ${r.occlusion.ids.length} id${r.occlusion.everLost ? " (survived)" : ""}`);
    if (r.reentry) bits.push(`re-entry ${r.reentry.ids.length} ids${r.reentry.linked ? " linked" : " UNLINKED"}`);
    if (r.crossing) bits.push(`crossing ${r.crossing.ids.length} ids no swap`);
    console.log(bits.join(" · ") || "no scenarios ran");
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  bad "no tracking samples were written — the run did not complete"
  headline "tracking did not complete"
fi

finish
