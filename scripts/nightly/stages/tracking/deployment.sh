#!/usr/bin/env bash
# Tracking as deployed — is the engine in the running image, reachable, and still off the gateway?
#
# ⚠️ Separate from `platform/deployment.sh`, which asks whether the running bytes are the committed
# bytes. This asks whether a specific CAPABILITY made it into the deployment and can be reached by
# the routes the console uses — a question that gets a different answer.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/tracking-deploy.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "tracking deployment script not found"; finish; }

node "$SCRIPT"
RC=$?

if [ "$RC" -eq 0 ]; then
  ok "tracking is deployed, reachable and permission-gated"
  headline "tracking deployed and off the gateway"
else
  bad "tracking deployment verification failed (exit $RC)"
  headline "tracking deployment RED"
fi
finish
