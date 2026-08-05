#!/usr/bin/env bash
# Housekeeping — delegate to the standalone cleanup script so there is one implementation.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

bash "$REPO/scripts/cleanup.sh" --prune --docker
RC=$?
[ "$RC" -eq 0 ] && ok "old runs pruned and docker cache reclaimed" || bad "cleanup failed (exit $RC)"
headline "$([ "$RC" -eq 0 ] && echo 'housekeeping done' || echo 'housekeeping failed')"
finish
