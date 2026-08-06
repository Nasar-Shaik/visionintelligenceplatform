#!/usr/bin/env bash
# The `*.nightly.test.ts` suites — assertions whose INSTRUMENT needs a quiet machine.
#
# ⚠️ These are excluded from `pnpm test` on purpose, and this stage is the only thing that runs them.
# Without it they would be dead code that nobody notices for a year, which is a worse outcome than a
# flaky gate: at least a flaky check is telling you something.
#
# What lives here: assertions that compare two wall-clock timings to establish an ALGORITHMIC
# property. The unit gate runs 28 suites in parallel, and a ratio between two contended timings
# cannot be made trustworthy by sampling harder. Per the execution policy of 2026-08-06, they run
# where the instrument works.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

cd "$REPO" || { bad "cannot enter $REPO"; headline "repo missing"; finish; }

FOUND=$(find services packages apps -name '*.nightly.test.ts' -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
if [ "$FOUND" = "0" ]; then
  # ⚠️ A finding, not a pass. A convention with no files is a convention somebody has stopped using.
  note "no *.nightly.test.ts files exist"
  headline "no nightly-only suites found — has the convention been abandoned?"
  finish
fi

note "$FOUND nightly-only suite(s) — timing ratios that need an idle machine"
pnpm vitest run --root . --include '**/*.nightly.test.ts'
RC=$?

if [ "$RC" -eq 0 ]; then
  ok "every nightly-only assertion held on an idle machine"
  headline "$FOUND suite(s) passed"
else
  bad "a nightly-only assertion failed (exit $RC)"
  headline "nightly-only suites failed"
fi

finish
