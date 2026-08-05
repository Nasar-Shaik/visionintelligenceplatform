#!/usr/bin/env bash
# The production gate — the checks that must be green before any measurement is worth recording.
#
# ⚠️ Each sub-check runs even if an earlier one failed. The morning wants "lint and python are
# broken", not "lint is broken, and who knows about the rest" — one command, one complete answer.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

run_check() {
  local label="$1"
  shift
  local out rc
  echo ""
  echo "──── $label"
  out=$("$@" 2>&1)
  rc=$?
  printf '%s\n' "$out" | tail -6
  if [ "$rc" -eq 0 ]; then
    ok "$label"
  else
    bad "$label (exit $rc)"
  fi
  return $rc
}

run_check "format" pnpm format:check
run_check "typecheck" pnpm typecheck
run_check "lint" pnpm lint
run_check "unit tests" pnpm exec turbo run test --concurrency=3
run_check "build" pnpm build

# ⚠️ Run from the repo, not inside the container. Four of these tests read files that exist only in
# the checkout — the serving image legitimately does not carry a dataset or the TypeScript contracts,
# and running them there reports failures that say nothing about the product. The numpy-dependent
# tests skip here and are asserted to actually RUN inside the image by the runtime stage.
echo ""
echo "──── python"
PY_OUT=$(python3 -m unittest discover -s ai/inference/tests -p 'test_*.py' 2>&1)
PY_RC=$?
printf '%s\n' "$PY_OUT" | tail -4
if [ "$PY_RC" -eq 0 ]; then
  ok "python suite"
else
  bad "python suite (exit $PY_RC)"
fi
PY_COUNT=$(printf '%s' "$PY_OUT" | sed -n 's/^Ran \([0-9]*\) tests.*/\1/p' | head -1)

cat >"$(metrics_path gate)" <<JSON
{
  "pythonTests": ${PY_COUNT:-0},
  "failures": $STAGE_FAILURES
}
JSON

if [ "$STAGE_FAILURES" -eq 0 ]; then
  headline "all gates green · python ${PY_COUNT:-?}"
else
  headline "$STAGE_FAILURES gate(s) failed"
fi
finish
