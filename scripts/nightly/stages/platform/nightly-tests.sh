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

# ⚠️ **Run inside each owning package, never from the root.** `vitest` is a per-package dev
# dependency; there is no root binary, so `pnpm vitest` at the repo root fails with
# `Command "vitest" not found` — which is exactly what this stage did on the first full nightly after
# the convention was introduced. The stage reported RED, correctly, about itself. A runner that has
# never run is the same failure the `FOUND = 0` branch above exists to catch, one level down.
#
# ⚠️ The filter is a **positional name pattern**, not `--include`: vitest 4 rejects `--include` as an
# unknown option, and the package's own config narrows `include` to `test/**/*.test.ts` anyway.
PKGS=$(
  find services packages apps -name '*.nightly.test.ts' -not -path '*/node_modules/*' 2>/dev/null |
    while IFS= read -r f; do
      d=$(dirname "$f")
      while [ "$d" != "." ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done
      [ -f "$d/package.json" ] && printf '%s\n' "$d"
    done | sort -u
)

RC=0
for pkg in $PKGS; do
  note "running in $pkg"
  if pnpm --dir "$pkg" exec vitest run 'nightly.test'; then
    ok "$pkg — every nightly-only assertion held"
  else
    bad "$pkg — a nightly-only assertion failed"
    RC=1
  fi
done

if [ "$RC" -eq 0 ]; then
  headline "$FOUND suite(s) passed across $(printf '%s\n' "$PKGS" | wc -l | tr -d ' ') package(s)"
else
  headline "nightly-only suites failed"
fi

finish
