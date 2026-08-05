#!/usr/bin/env bash
# Dashboard verification — the operator page in a real browser.
#
# ⚠️ Playwright lives in /private/tmp/pwrun, not in this repo, so the script is copied there and run
# from there. That is a deployment constraint of this machine, not a preference.
. "$(dirname -- "$0")/_preamble.sh"

PWRUN=/private/tmp/pwrun
if [ ! -d "$PWRUN/node_modules/playwright" ]; then
  bad "playwright is not installed at $PWRUN — browser verification cannot run"
  headline "playwright missing at $PWRUN"
  finish
fi

cp docs/review/p8/runtime-ui.mjs "$PWRUN/p8-runtime-ui.mjs"
( cd "$PWRUN" && OUT="$REPO/docs/review/p8/screens" REPO="$REPO" node p8-runtime-ui.mjs )
RC=$?

if [ "$RC" -eq 0 ]; then
  ok "the operator page renders only what the deployment reported"
  headline "dashboard verified in a browser"
else
  bad "dashboard verification failed (exit $RC)"
  headline "dashboard verification RED"
fi
finish
