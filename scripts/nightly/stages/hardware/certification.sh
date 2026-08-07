#!/usr/bin/env bash
# Certification, end to end, in the deployed runtime image (P-9 A8).
#
# ⚠️ **Registered, and it runs at night — never in a working day.** The observation window plus the
# benchmark takes minutes, and the `hardware` profile it belongs to is where the certification SOAK
# eventually lands, which takes hours. Daytime execution policy: fast verification only.
#
# ⚠️ **This stage certifies nothing, and that is the correct outcome.** Against the synthetic fixture
# the bundle comes back `pending-validation` with three blockers, two of which no software can ever
# clear — `reconnect-recovery` and `clean-shutdown` need a person to pull a cable and watch a device
# shut down. The stage's job is to prove the PROCEDURE still runs and still refuses. The day real
# hardware is on the bench, the same stage produces a real verdict with no code change.
#
# ⛔ It is also why an unattended certification is not a substitute for an attended one. A bundle
# nobody observed is a bundle nobody can defend — see P9_IMPLEMENTATION_PLAN §8.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

RUNTIME="${RUNTIME_CONTAINER:-vip-prod-inference-1}"
FIXTURE=vip-rtsp-fixture
OUT="$RUN_DIR/certification"
mkdir -p "$OUT"

if ! docker inspect "$RUNTIME" >/dev/null 2>&1; then
  bad "$RUNTIME is not present — certification cannot run"
  headline "runtime container absent"
  finish
fi

# ⛔ The decoder. Absent until P-9 A2, and its absence made every live endpoint raise
# ModuleNotFoundError inside the request handler. Checked FIRST, because every stage below it would
# otherwise fail in a way that blames the camera.
if docker exec "$RUNTIME" python -c 'import cv2' >/dev/null 2>&1; then
  ok "the runtime image has a decoder"
else
  bad "the runtime image has no cv2 — no live source can be opened"
  headline "runtime image has no decoder"
  finish
fi

echo ""
echo "── fixture ───────────────────────────────────────────────"
docker rm -f "$FIXTURE" >/dev/null 2>&1
guard "docker rm -f $FIXTURE >/dev/null 2>&1"
docker run -d --rm --name "$FIXTURE" --network "${FIXTURE_NETWORK:-vip-prod_default}" \
  -v "$REPO/infra/docker/fixtures/p9-probe-fixture.yml:/mediamtx.yml:ro" \
  -v "$REPO/infra/docker/fixtures/media:/fixtures/media:ro" \
  bluenviron/mediamtx:latest-ffmpeg >/dev/null 2>&1
sleep 4
# ⚠️ `docker run -d` returns 0 for a container that started and exited — a rejected config looks
# exactly like a healthy launch. P-9 A4.5 reported "0/4 cameras decoded" against a fixture that had
# never come up.
if [ "$(docker inspect -f '{{.State.Running}}' "$FIXTURE" 2>/dev/null)" = "true" ]; then
  ok "RTSP fixture running"
else
  bad "the RTSP fixture did not stay up"
  headline "fixture would not start"
  unguard
  finish
fi

echo ""
echo "── certification against the fixture ─────────────────────"
docker exec "$RUNTIME" rm -rf /tmp/nightly-cert >/dev/null 2>&1
if docker exec "$RUNTIME" python certify_cli.py \
    --target generic-rtsp --source rtsp \
    --uri "rtsp://$FIXTURE:8554/p9probe" \
    --frames "${CERT_FRAMES:-60}" --max-seconds "${CERT_MAX_SECONDS:-120}" \
    --output /tmp/nightly-cert >"$OUT/certify.log" 2>&1; then
  ok "certify_cli ran to completion on a live source"
else
  # ⛔ Exit code, not stdout. A live run once printed a complete summary and then died with SIGSEGV
  # while writing its bundle (P-9 A3) — stdout alone called that a pass.
  bad "certify_cli exited non-zero (see certify.log)"
fi

for f in certification-summary.json compatibility.json capability.json validation-bundle.json; do
  if docker exec "$RUNTIME" test -s "/tmp/nightly-cert/$f"; then
    docker exec "$RUNTIME" cat "/tmp/nightly-cert/$f" >"$OUT/$f" 2>/dev/null
    ok "wrote $f"
  else
    bad "$f is missing or empty"
  fi
done

echo ""
echo "── the verdict must still be a refusal ───────────────────"
STATUS=$(docker exec "$RUNTIME" python -c "import json;print(json.load(open('/tmp/nightly-cert/certification-summary.json'))['status'])" 2>/dev/null || echo unreadable)
EVIDENCE=$(docker exec "$RUNTIME" python -c "import json;print(json.load(open('/tmp/nightly-cert/certification-summary.json'))['evidenceClass'])" 2>/dev/null || echo unreadable)
BLOCKERS=$(docker exec "$RUNTIME" python -c "import json;print(len(json.load(open('/tmp/nightly-cert/certification-summary.json'))['blockers']))" 2>/dev/null || echo 0)

if [ "$STATUS" = "pending-validation" ]; then
  ok "status is 'pending-validation' — a synthetic source certifies nothing"
else
  bad "status is '$STATUS' — expected 'pending-validation' from a synthetic source"
fi
if [ "$EVIDENCE" = "simulated" ]; then
  ok "evidence class is 'simulated' — the weakest link, not the average"
else
  bad "evidence class is '$EVIDENCE' — expected 'simulated'"
fi
if [ "${BLOCKERS:-0}" -ge 3 ]; then
  ok "$BLOCKERS blockers named, including the two only a person can clear"
else
  bad "only ${BLOCKERS:-0} blocker(s) — the refusal has stopped explaining itself"
fi

echo ""
echo "── the baseline has not drifted ──────────────────────────"
# The committed baseline is the diff target every hardware run is compared against. If the procedure
# changes shape without anyone deciding to, this is where it shows.
if docker exec "$RUNTIME" python -m unittest tests.test_camera_registry -q >"$OUT/registry-tests.log" 2>&1; then
  ok "the committed baseline and compatibility matrix still match the registry"
else
  bad "baseline or matrix has drifted (see registry-tests.log)"
fi

metrics=$(metrics_path)
cat >"$metrics" <<JSON
{
  "stage": "$STAGE_ID",
  "status": "$STATUS",
  "evidenceClass": "$EVIDENCE",
  "blockers": ${BLOCKERS:-0},
  "certifiedDevices": 0,
  "note": "synthetic fixture — certifies nothing by design; L-1 stands until real hardware runs here"
}
JSON

docker rm -f "$FIXTURE" >/dev/null 2>&1
unguard

if [ "$STAGE_FAILURES" -eq 0 ]; then
  headline "certification procedure runs and still refuses (synthetic)"
else
  headline "certification procedure has $STAGE_FAILURES problem(s)"
fi
finish
