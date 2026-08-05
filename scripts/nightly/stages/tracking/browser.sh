#!/usr/bin/env bash
# The four track pages in a real browser, with every number traced to the payload behind it.
#
# ⚠️ Playwright lives in /private/tmp/pwrun, not in this repo, so the script is copied there and run
# from there. That is a deployment constraint of this machine, not a preference.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

PWRUN=/private/tmp/pwrun
if [ ! -d "$PWRUN/node_modules/playwright" ]; then
  bad "playwright is not installed at $PWRUN — browser verification cannot run"
  headline "playwright missing at $PWRUN"
  finish
fi

# Fixtures first: the pages need something to show, and the clips are generated rather than committed.
node docs/review/p8/tracking-fixtures.mjs >/dev/null || {
  bad "could not build the motion fixtures"
  headline "tracking fixtures unavailable"
  finish
}

cp docs/review/p8/tracking-ui.mjs "$PWRUN/p8-tracking-ui.mjs"
# ⚠️ Screenshots into the run, never over committed review screens — otherwise every night rewrites
# tracked binaries and the tree-drift check goes red for no reason.
mkdir -p "$RUN_DIR/screens"
guard "cd '$REPO' && node docs/review/p8/tracking.mjs clean"
( cd "$PWRUN" && OUT="$RUN_DIR/screens" REPO="$REPO" node p8-tracking-ui.mjs )
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "the track pages report only what the runtime measured"
  headline "track pages verified in a browser"
else
  bad "tracking browser verification failed (exit $RC)"
  headline "track pages RED"
fi
finish
