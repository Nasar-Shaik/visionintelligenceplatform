#!/usr/bin/env bash
# Measure capacity, and nothing else.
#
#   ./scripts/benchmark.sh                  # run the ladder, write scripts/reports/nightly/<date>/benchmark.md
#   ./scripts/benchmark.sh --promote        # copy the latest run's benchmark over the committed page
#   ./scripts/benchmark.sh --promote 2026-08-06
#
# ⚠️ Promotion is a separate, explicit act. The nightly run never overwrites
# docs/project/AI_RUNTIME_BENCHMARK.md, because a permanent reference a machine can rewrite at 03:00
# is not a reference — the value of that page is that a person stood behind the numbers on it.
set -u
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$REPO/scripts/nightly.config"
ROOT="$REPO/${REPORT_ROOT:-scripts/reports/nightly}"

if [ "${1:-}" = "--promote" ]; then
  RUN_ID="${2:-latest}"
  SRC="$ROOT/$RUN_ID/benchmark.md"
  DEST="$REPO/docs/project/AI_RUNTIME_BENCHMARK.md"
  [ -f "$SRC" ] || { echo "no benchmark at $SRC" >&2; exit 2; }
  echo "This replaces $DEST with the measurements from $RUN_ID."
  echo "Review it first:  less $SRC"
  printf 'Promote? [y/N] '
  read -r answer
  case "$answer" in
    y | Y)
      cp "$SRC" "$DEST"
      echo "promoted — review the diff before committing:  git diff $DEST"
      ;;
    *) echo "left alone" ;;
  esac
  exit 0
fi

exec bash "$(dirname -- "$0")/nightly/launch.sh" benchmark "$@"
