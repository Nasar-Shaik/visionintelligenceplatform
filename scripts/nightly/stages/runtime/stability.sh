#!/usr/bin/env bash
# Stability — run continuous multi-camera inference for a configured duration and watch for drift.
#
# Wraps `docs/review/p8/inference-soak.mjs`, which is the thing that actually measures. This stage
# exists to give it a duration, a timeout it cannot outlive, a home for its samples, and a guard that
# removes the cameras it created if the night is cut short.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SOAK="docs/review/p8/inference-soak.mjs"
[ -f "$SOAK" ] || {
  bad "missing $SOAK"
  headline "soak script not found"
  finish
}

# ⚠️ The soak creates cameras and an RTSP fixture through the real API. Killed half-way it would
# leave them streaming — loading the host all night and poisoning every measurement after it.
guard "cd '$REPO' && node $SOAK clean"

# ⚠️ OUT points into the run, so the soak never writes to the tracked working tree. Without this the
# framework dirties `docs/review/p8/soak-samples.json` on every run — which then fails
# deployment-integrity's "the working tree is clean" check and the engine's own tree-drift check. A
# verification tool must not fail a verification by producing output.
SAMPLES="$(metrics_path stability)"
rm -f "$SAMPLES"

note "running ${SOAK_MINUTES} minutes across ${SOAK_CAMERAS} cameras"
[ -n "$SOAK_REASON" ] && note "reason: $SOAK_REASON"
echo ""

MINUTES="$SOAK_MINUTES" CAMERAS="$SOAK_CAMERAS" OUT="$SAMPLES" node "$SOAK"
RC=$?

unguard

# The samples file is written only on completion, so its absence is itself information: the run did
# not finish. Say that rather than reporting an empty stability result.
if [ -f "$SAMPLES" ]; then
  ok "per-minute samples captured"
else
  bad "the soak produced no samples file — it did not run to completion"
fi

if [ "$RC" -eq 0 ]; then
  ok "stability checks passed over ${SOAK_MINUTES} minutes"
else
  bad "the soak reported failures (exit $RC) — see the log above"
fi

# A headline a person can read at 08:00 without opening anything else.
if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const s = require(process.argv[1]).samples || [];
    if (!s.length) { console.log("no samples"); process.exit(0); }
    const mem = s.map((x) => x.runtimeMem).filter((n) => n > 0);
    const per = s.map((x) => x.perFrame).filter((n) => n > 0);
    const drop = s.reduce((a, x) => a + (x.dropped || 0), 0);
    const seen = s.reduce((a, x) => a + (x.delivered || 0), 0);
    const p95 = s.map((x) => x.runtimeP95).filter((n) => n > 0);
    const r = (xs) => `${Math.min(...xs).toFixed(0)}–${Math.max(...xs).toFixed(0)}`;
    console.log(
      `${s.length} min · ${seen} frames · ${Math.min(...per).toFixed(2)}–${Math.max(...per).toFixed(2)}/frame` +
      ` · mem ${r(mem)}MB · p95 ${r(p95)}ms · ${drop} dropped`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
