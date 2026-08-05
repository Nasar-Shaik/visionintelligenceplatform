#!/usr/bin/env bash
# Integration — the cross-service tests, which need the stack up and are therefore not part of the
# unit gate.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

pnpm test:integration
RC=$?

if [ "$RC" -eq 0 ]; then
  ok "integration tests passed"
  headline "integration green"
else
  bad "integration tests failed (exit $RC)"
  headline "integration RED"
fi
finish
