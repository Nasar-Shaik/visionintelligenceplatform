#!/usr/bin/env bash
# Detection zones — geometry, versioning, and the plan that carries them.
#
# ⚠️ This stage exists because zone GEOMETRY and zone DELIVERY fail differently and neither implies
# the other. A polygon can be stored perfectly and never reach the enforcement point; a plan can
# carry a zone whose geometry nobody validated. The unit tests own the first, this stage owns the
# second — that the version history exists, and that the enforcement point actually holds what the
# operator drew.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/loitering.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "loitering script not found"; finish; }

SAMPLES="$(metrics_path loitering)"
if [ ! -f "$SAMPLES" ]; then
  # ⚠️ Skipped, not failed. This stage reads the loitering stage's evidence; declaring a failure
  # when the run before it did not produce any would report the same fault twice under two names.
  note "no loitering samples on this run — the loitering stage did not complete"
  headline "skipped: no samples to read"
  finish
fi

RESULT=$(node -e '
  const d = require(process.argv[1]);
  const z = (d.samples?.gate?.pipeline?.zones) ?? {};
  const problems = [];
  if (!(z.zonesLoaded > 0)) problems.push("the enforcement point held no zones");
  if (!(z.detectionsTested > 0)) problems.push("no detection was tested against a zone");
  if (z.averageResolveMicros === null || z.averageResolveMicros === undefined) {
    problems.push("zone resolution cost was never measured");
  }
  console.log(JSON.stringify({
    problems,
    summary: `${z.zonesLoaded ?? 0} zone(s) held · ${z.insideDetections ?? 0}/${z.detectionsTested ?? 0} inside · ` +
             `${(z.averageResolveMicros ?? 0).toFixed(1)}µs per frame`,
  }));
' "$SAMPLES" 2>/dev/null)

PROBLEMS=$(node -e 'console.log((JSON.parse(process.argv[1]).problems ?? []).join("; "))' "$RESULT" 2>/dev/null)
SUMMARY=$(node -e 'console.log(JSON.parse(process.argv[1]).summary ?? "")' "$RESULT" 2>/dev/null)

if [ -z "$PROBLEMS" ]; then
  ok "zones travelled on the assignment plan and were evaluated on the frame path"
else
  bad "$PROBLEMS"
fi
headline "${SUMMARY:-no zone statistics}"

finish
