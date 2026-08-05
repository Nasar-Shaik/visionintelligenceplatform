#!/usr/bin/env bash
# Pilot readiness (P-10).
#
# ⚠️ Several stages in this profile have no script yet and will report NOT IMPLEMENTED. That is the
# point: this run tells you what pilot readiness still needs, rather than showing green for work
# nobody has done.
set -u
export SOAK_MINUTES="${SOAK_MINUTES:-120}"
export SOAK_REASON="${SOAK_REASON:-pilot readiness (P-10)}"
exec bash "$(dirname -- "$0")/nightly/launch.sh" pilot "$@"
