#!/usr/bin/env bash
# The six assignment pages in a real browser, with every figure traced to the payload behind it.
#
# ⚠️ These pages are where this subsystem's rules become visible or become lies. "A runtime nobody
# has observed must not read Healthy" and "an undeclared capacity must not read 0%" are properties no
# deployment check can fail — the damage is entirely in what an operator reads, and the platform has
# already shipped one page that hard-coded a value while its payload said otherwise.
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

SCRIPT="docs/review/p8/assignment-ui.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "assignment UI script not found"; finish; }

cp "$SCRIPT" "$PWRUN/p8-assignment-ui.mjs"
# Screenshots into the run, never over committed review screens — a night must not rewrite tracked
# binaries, or the tree-drift check goes red for no reason.
mkdir -p "$RUN_DIR/screens"
guard "cd '$REPO' && node docs/review/p8/assignment.mjs clean"
( cd "$PWRUN" && OUT="$RUN_DIR/screens" REPO="$REPO" node p8-assignment-ui.mjs )
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "every figure on the assignment pages traces to the payload the browser received"
  headline "assignment pages verified in a browser"
else
  bad "assignment browser verification failed (exit $RC)"
  headline "assignment pages RED"
fi
finish
