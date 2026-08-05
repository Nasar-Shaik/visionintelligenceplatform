#!/usr/bin/env bash
# Shared launcher for every profile entry script.
#
# The entry scripts (nightly.sh, weekly.sh, …) are deliberately thin: a profile name, a few defaults,
# and this. Six copies of the same orchestration would drift, and the one that drifted would be the
# one you ran at midnight.
set -u
LAUNCH_REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$LAUNCH_REPO/scripts/nightly.config"
[ -f "$LAUNCH_REPO/scripts/nightly.config.local" ] && . "$LAUNCH_REPO/scripts/nightly.config.local"

PROFILE_NAME="$1"; shift

# ⚠️ `caffeinate` is not a nicety. Without it macOS sleeps, the run stops mid-stage, and you wake to
# a directory of half-finished evidence — the exact outcome this framework exists to prevent.
# `-i` prevents idle sleep; the run still respects a lid close, which is a deliberate escape hatch.
if [ "${KEEP_AWAKE:-true}" = "true" ] && command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -i bash "$LAUNCH_REPO/scripts/nightly/engine.sh" --profile "$PROFILE_NAME" "$@"
fi
exec bash "$LAUNCH_REPO/scripts/nightly/engine.sh" --profile "$PROFILE_NAME" "$@"
