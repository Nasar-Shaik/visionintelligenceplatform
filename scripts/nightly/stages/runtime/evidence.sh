#!/usr/bin/env bash
# Evidence integrity under load — Evidence Integrity, EI-5b.
#
# Wraps `tools/validation/evidence-stress.mjs`, which is the thing that actually measures. This stage
# gives it a size, a timeout it cannot outlive, and a home for its output.
#
# ⛔ **Why this is nightly rather than part of the milestone's own verification.**
#
# The bounded run — 24 analyses, one ungraceful kill — takes 45 seconds and ran on the commit. The
# useful one is 120+ analyses with three kills, which is well past the fifteen minutes a milestone
# gate may spend, so it lands here in the same commit rather than being promised for later.
#
# ⚠️ **The scale is the point, not decoration.** Every defect this milestone found was a steady-state
# defect: 28 open identities across 12 finished runs had accumulated in 26 minutes of ordinary use,
# and one analysis would never have shown it. A property that holds for the first run and fails for
# the hundredth is exactly the shape of what was already found here twice.
#
# ⭐ **It runs the control too.** A pass with kills is worth little without the paired run that has
# none: with a deliberate SIGKILL, evidence held in memory by the killed process is genuinely gone and
# the requirement is that the read SAYS so; without one, the requirement is that nothing is lost at
# all. Only the pair separates "the platform is honest about loss" from "the platform loses things".
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

STRESS="tools/validation/evidence-stress.mjs"
[ -f "$STRESS" ] || {
  bad "missing $STRESS"
  headline "evidence stress harness not found"
  finish
}

CLIP="${EVIDENCE_CLIP:-infra/docker/fixtures/media/validation/carried-objects.mp4}"
[ -f "$CLIP" ] || {
  bad "missing clip $CLIP"
  headline "no footage to stress with"
  finish
}

RUNS="${EVIDENCE_RUNS:-120}"
CONCURRENCY="${EVIDENCE_CONCURRENCY:-6}"
RESTARTS="${EVIDENCE_RESTARTS:-3}"

note "control: ${RUNS} analyses, concurrency ${CONCURRENCY}, NO restart — nothing may be lost"
echo ""
node "$STRESS" --clip "$CLIP" --runs "$RUNS" --concurrency "$CONCURRENCY" --restarts 0
CONTROL=$?

echo ""
note "under kills: ${RUNS} analyses, concurrency ${CONCURRENCY}, ${RESTARTS} ungraceful restarts"
note "loss is permitted here and must be REPORTED as lost, never as absent"
echo ""
node "$STRESS" --clip "$CLIP" --runs "$RUNS" --concurrency "$CONCURRENCY" --restarts "$RESTARTS"
KILLED=$?

echo ""
if [ "$CONTROL" -eq 0 ] && [ "$KILLED" -eq 0 ]; then
  ok "evidence held with and without ungraceful restarts"
  headline "${RUNS} analyses × 2 · control clean · loss under kills reported, never silent"
elif [ "$CONTROL" -ne 0 ]; then
  # ⛔ The worse of the two by a distance: evidence lost with nothing going wrong.
  bad "the control run lost evidence with no restart to explain it"
  headline "control FAILED — evidence lost on an undisturbed stack"
else
  bad "evidence was lost silently under ungraceful restarts"
  headline "kills FAILED — a loss did not report itself as lost"
fi

finish
