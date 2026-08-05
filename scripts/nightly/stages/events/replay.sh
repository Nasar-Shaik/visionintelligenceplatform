#!/usr/bin/env bash
# Duplicates, correlation, replay determinism and payload versions — with no camera in the run.
#
# ⚠️ Separate from `events/bridge.sh` and deliberately so, on the same reasoning the README gives for
# splitting the two benchmarks. That stage proves the chain EXISTS, using a decoder, a model and a
# host under whatever load it is under. This one proves the chain is DETERMINISTIC, by injecting a
# known result onto the subject the publisher publishes to. A flaky decoder can turn the first red
# without saying anything about the second, and one stage covering both would report that as one
# fact.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/event-bridge-replay.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "replay verification script not found"; finish; }

# Two enabled rules and a bus probe inside a container — all of it removed if the stage is killed.
guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path event-replay)"
rm -f "$SAMPLES"
note "duplicate suppression, correlation trace, replay determinism, payload v1/v2/v3"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "duplicates bounded, correlation unbroken, replay deterministic, payloads versionable"
else
  bad "the replay/correlation verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const dup = d.samples?.duplicates ?? {};
    const rep = d.samples?.replay ?? {};
    const pay = d.samples?.payloadVersions ?? {};
    console.log(
      `6 deliveries → ${dup.persisted ?? "?"} event(s) across the ${d.dedupWindowMs}ms window · ` +
      `replayed ${rep.replayed ?? "?"} twice, ${rep.reEvaluated ?? "?"} re-evaluation(s), ` +
      `incidents ${rep.incidentsBefore ?? "?"}→${rep.incidentsAfter ?? "?"} · ` +
      `payload v1/v2/v3 ${pay.matched ?? 0}/3 consumed`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
