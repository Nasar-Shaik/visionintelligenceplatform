#!/usr/bin/env bash
# Sourced first by every stage.
#
# Stages run as **child processes**, not sourced into the engine — so a stage that crashes, calls
# `exit`, or corrupts its own shell state cannot take the night down with it. The cost is that
# nothing is inherited except the environment, which is why each stage re-reads the config here.
# `nightly.config` assigns with `${VAR:-default}`, so re-reading is idempotent and a command-line
# override (`SOAK_MINUTES=5 ./scripts/nightly.sh`) still wins.

set -u

: "${REPO:?stage must be run by the engine}"
. "$REPO/scripts/nightly/lib.sh"
. "$REPO/scripts/nightly.config"
[ -f "$REPO/scripts/nightly.config.local" ] && . "$REPO/scripts/nightly.config.local"

cd "$REPO" || exit 2

STAGE_FAILURES=0

# A check inside a stage. Prints to the stage log; the count becomes the exit status.
ok() { printf '  ✓ %s\n' "$*"; }
bad() {
  printf '  ✗ %s\n' "$*"
  STAGE_FAILURES=$((STAGE_FAILURES + 1))
}
note() { printf '  · %s\n' "$*"; }
warn() { printf '  ⚠️ %s\n' "$*"; }

# One line the morning summary shows next to this stage. Keep it to what a person needs at a glance.
headline() { printf '%s' "$*" >"$RUN_DIR/status/$STAGE_ID.headline"; }

# Register an undo command. The engine runs this if the stage is killed — a sleeping laptop, a closed
# terminal, ^C. Removed automatically when the stage finishes on its own.
guard() { printf '%s\n' "$*" >"$RUN_DIR/guards/$STAGE_ID.restore"; }
unguard() { rm -f "$RUN_DIR/guards/$STAGE_ID.restore"; }

# Write a metrics file for the report to read. Stages produce data; only the report interprets it.
metrics_path() { printf '%s/%s.json' "$METRICS_DIR" "${1:-$STAGE_ID}"; }

finish() {
  if [ "$STAGE_FAILURES" -eq 0 ]; then
    printf '\nstage %s: OK\n' "$STAGE_ID"
    exit 0
  fi
  printf '\nstage %s: %d check(s) failed\n' "$STAGE_ID" "$STAGE_FAILURES"
  exit 1
}
