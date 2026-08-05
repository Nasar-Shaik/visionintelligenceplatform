#!/usr/bin/env bash
# The live event bridge, end to end — does a frame become an incident candidate?
#
# ⚠️ The chain this covers existed and was frozen long before anything travelled it. Every stage
# downstream of a published DetectionResult worked in isolation and nothing published, so no test
# failed while the platform could not raise an incident from a camera. This is the stage that would
# have caught that, and it is the reason `events/` exists as a domain.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/event-bridge.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "event bridge script not found"; finish; }

# ⚠️ The run creates a camera AND a verification rule. If it is killed between the two, an ENABLED
# rule is left raising candidates for every person detection in the tenant — so the undo is registered
# before anything is created, not after.
guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path event-bridge)"
rm -f "$SAMPLES"
note "one camera, one walking person, through publisher → events → rules"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "a frame became an incident candidate"
else
  bad "the event bridge verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const a = d.samples?.after ?? {};
    const b = d.samples?.before ?? {};
    const published = (a.published ?? 0) - (b.published ?? 0);
    const latency = a.publishMsAvg == null ? "not measured" : `${a.publishMsAvg.toFixed(2)}ms`;
    console.log(
      `${published} published · ${d.samples?.envelopes ?? 0} persisted · ` +
      `${d.samples?.rule?.matches ?? 0} rule match(es) · publish ${latency} · broker ${a.brokerStatus ?? "?"}`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
