#!/usr/bin/env bash
# Report — turn the run's journal, statuses and metrics into something readable at 08:00.
#
# ⚠️ This stage `requires` nothing and never aborts. A night where six stages failed is precisely the
# night you most need a summary, so the report must be the one thing that always runs.
. "$(dirname -- "$0")/_preamble.sh"

node "$REPO/scripts/nightly/report.mjs" --run "$RUN_DIR"
RC=$?

if [ "$RC" -eq 0 ]; then
  ok "summary.md, verification.md and benchmark.md written"
  headline "${REPORT_ROOT:-scripts/reports/nightly}/$RUN_ID/summary.md"
else
  bad "the report generator failed (exit $RC)"
  headline "REPORT GENERATION FAILED — read the logs directly"
fi
finish
