#!/usr/bin/env bash
# Rule replay determinism — the same persisted events must produce the same incident candidate.
#
# ⚠️ Separate from `events/replay.sh`, which proves the EVENT layer replays without duplicating or
# losing envelopes. This stage carries the replay one context further, through scope, condition and
# the dwell clock, and asks whether the *decision* is reproducible. An event layer can be perfectly
# deterministic while the rule engine on top of it reads its own clock; one stage covering both would
# report that as one fact.
#
# ⚠️ It is here rather than in the gate because it must wait out the JetStream duplicate window twice
# — a replay inside that window is dropped by the broker, so a faster version of this run would be
# comparing a candidate against nothing while reporting agreement. The waits are the measurement.
#
# ⚠️ It raises no incident. Both rules are dry-run: everything is evaluated, the candidate is built in
# full, and nothing is published. The stage restarts the rules service on purpose, which is how it
# gets a fresh dwell state under an unchanged rule id.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/rule-replay.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "rule replay script not found"; finish; }

# A camera, a zone and two rules — all of it removed if the stage is killed.
guard "cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path rule-replay)"
rm -f "$SAMPLES"
note "live pass vs replayed pass, byte for byte, across a rules-service restart"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "the same events produce the same candidate — id and timestamp aside, byte for byte"
else
  bad "the replay determinism verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const inst = d.instances ?? {};
    const rep = d.replay ?? {};
    const st = d.stored ?? {};
    const diverged = (rep.diverged ?? []).length;
    console.log(
      `${d.seed?.persisted ?? "?"} envelope(s) over ${d.seed?.spanSeconds ?? "?"}s → ` +
      `${rep.durationSeconds ?? "?"}s dwell · ${inst.compared ?? "?"} field(s) compared, ` +
      `${diverged} divergent · idempotent (${d.idempotent?.candidatesAfterReplay ?? "?"} candidate) · ` +
      `store ${st.before ?? "?"}→${st.after ?? "?"}, ${st.incidents ?? "?"} incident(s) raised`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
