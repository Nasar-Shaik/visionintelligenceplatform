#!/usr/bin/env bash
# Report — turn the run's journal, statuses and metrics into something readable at 08:00.
#
# ⚠️ This stage `requires` nothing and never aborts. A night where six stages failed is precisely the
# night you most need a summary, so the report must be the one thing that always runs.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

node "$REPO/scripts/nightly/report.mjs" --run "$RUN_DIR"
RC=$?

# ⚠️ AFTER the report, and never before it. The ledger is append-only, so a run that appended and
# then failed to report would leave a line nobody can trace back to a readable summary.
if node "$REPO/scripts/nightly/history.mjs" "$RUN_DIR"; then
  ok "metrics appended to the persistent history"
else
  # A ledger that could not be written is worth saying, but it must never fail the night: the
  # measurements themselves are already on disk in this run's metrics/.
  warn "the metric history could not be appended — this run's metrics are still in metrics/"
fi

if [ "$RC" -eq 0 ]; then
  ok "summary.md, verification.md and benchmark.md written"
  headline "${REPORT_ROOT:-scripts/reports/nightly}/$RUN_ID/summary.md"
else
  bad "the report generator failed (exit $RC)"
  headline "REPORT GENERATION FAILED — read the logs directly"
fi
finish
