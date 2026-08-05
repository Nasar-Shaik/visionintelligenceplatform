#!/usr/bin/env bash
# The long one — everything nightly does, with a soak long enough to see a slow leak, plus
# housekeeping.
#
#   ./scripts/weekly.sh
#
# ⚠️ Supplies the SOAK_REASON that pre-flight demands for anything over an hour. That gate exists
# because a multi-hour soak with no stated reason is a night spent re-verifying what already worked
# — the execution policy of 2026-08-05 makes short runs the default and long ones deliberate.
set -u
export SOAK_MINUTES="${SOAK_MINUTES:-240}"
export SOAK_REASON="${SOAK_REASON:-weekly long-soak: the run entitled to look for a slow arena leak, which a 15-30 minute run cannot see}"
export SOAK_CAMERAS="${SOAK_CAMERAS:-4}"
export RUN_CLEANUP="${RUN_CLEANUP:-true}"
exec bash "$(dirname -- "$0")/nightly/launch.sh" weekly "$@"
