#!/usr/bin/env bash
# The Event Bridge page in a real browser, with every number traced to the payload behind it.
#
# ⚠️ Some of this subsystem's rules are only observable on a page. "An unmeasured average must never
# render as a number" (ADR-0039) is one: a publisher reporting 0 ms instead of null looks like a fast
# broker, so no deployment check can fail — the damage is entirely in what an operator reads. The
# tracking statistics page shipped with exactly that defect, hard-coding a value while the payload
# said otherwise, and it was a browser stage that found it.
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

SCRIPT="docs/review/p8/event-bridge-ui.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "event bridge UI script not found"; finish; }

cp "$SCRIPT" "$PWRUN/p8-event-bridge-ui.mjs"
# Screenshots into the run, never over committed review screens — a night must not rewrite tracked
# binaries, or the tree-drift check goes red for no reason.
mkdir -p "$RUN_DIR/screens"
guard "cd '$REPO' && node docs/review/p8/event-bridge.mjs clean"
( cd "$PWRUN" && OUT="$RUN_DIR/screens" REPO="$REPO" node p8-event-bridge-ui.mjs )
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "the event bridge page reports only what the publisher measured"
  headline "event bridge page verified in a browser"
else
  bad "event bridge browser verification failed (exit $RC)"
  headline "event bridge page RED"
fi
finish
