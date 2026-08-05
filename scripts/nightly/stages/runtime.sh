#!/usr/bin/env bash
# Runtime verification — real inference, end to end, through a camera.
#
# The full `inference.mjs`: image and artifact integrity, the loaded model's self-report, a
# photograph of two people that must yield exactly two, a test pattern that must yield ZERO, the
# decoder's own tests run inside the deployed image, the operator route, and the camera ladder.
. "$(dirname -- "$0")/_preamble.sh"

# It creates fixture cameras and an RTSP source through the real API.
guard "cd '$REPO' && node docs/review/p8/inference.mjs clean"

node docs/review/p8/inference.mjs
RC=$?

unguard

if [ "$RC" -eq 0 ]; then
  ok "real inference verified against the deployment"
else
  bad "inference verification failed (exit $RC)"
fi

FINDINGS=$(grep -c '⚠️' "$STAGE_LOG" 2>/dev/null || echo 0)
headline "$([ "$RC" -eq 0 ] && echo 'inference verified end to end' || echo 'inference verification RED')"
finish
