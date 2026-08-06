#!/usr/bin/env bash
# The operator surfaces — Zone Editor, Live Rule Status, incident detail — against the deployment.
#
# ⚠️ Never verify mocked data. This drives a real browser against the running console and asserts
# that every figure traces to a payload the browser actually received. A page that renders a
# plausible number from a fixture is the failure this whole class of check exists to prevent.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/loitering-ui.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "browser script not found"; finish; }

# ⚠️ Playwright lives outside the repo (see the P-5.x runbook): the script is copied to /private/tmp
# and run FROM there, or its module resolution finds nothing.
PWRUN="${PWRUN:-/private/tmp/pwrun}"
if [ ! -d "$PWRUN" ]; then
  note "no Playwright runner at $PWRUN"
  headline "skipped: browser runner not installed"
  finish
fi

guard "cd '$REPO' && node $SCRIPT clean"
cp "$REPO/$SCRIPT" "$PWRUN/" 2>/dev/null
cp "$REPO/docs/review/p8/_assign.mjs" "$PWRUN/" 2>/dev/null
( cd "$PWRUN" && node "$(basename "$SCRIPT")" )
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "every figure on the loitering pages traces to the payload the browser received"
  headline "zone editor, live rule status and incident detail verified in a real browser"
else
  bad "the browser verification failed (exit $RC)"
  headline "browser verification failed"
fi

finish
