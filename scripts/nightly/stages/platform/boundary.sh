#!/usr/bin/env bash
# Boundary — contracts, and the gate that makes model-agnosticism a build failure.
#
# `verify:contracts` runs the schema check and `tools/contracts/perception-boundary.mjs`: exactly one
# file may call the runtime, only media may know where it lives, no source outside `ai/` may name a
# model-implementation concept, and no consumer may read a detection field the frozen schema does not
# declare.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

pnpm verify:contracts
RC=$?
[ "$RC" -eq 0 ] && ok "contracts and the perception boundary hold" || bad "contract or boundary violation (exit $RC)"

echo ""
pnpm check:imports
IRC=$?
[ "$IRC" -eq 0 ] && ok "the import graph has no violations" || bad "import-graph violation (exit $IRC)"

headline "$([ "$STAGE_FAILURES" -eq 0 ] && echo 'boundary and import graph clean' || echo "$STAGE_FAILURES violation(s)")"
finish
