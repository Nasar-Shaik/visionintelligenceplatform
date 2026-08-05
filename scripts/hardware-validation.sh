#!/usr/bin/env bash
# Hardware validation (P-9) — real cameras, real NVRs.
#
# ⚠️ Almost nothing here is implemented, and the run says so. L-1 stands: no Hikvision, Dahua,
# CP Plus, UNV or Axis device has ever been connected to this platform. This profile exists so that
# fact is reported by a run instead of remembered by a person — and so the stages have somewhere to
# land the day the hardware arrives.
set -u
export SOAK_MINUTES="${SOAK_MINUTES:-120}"
export SOAK_REASON="${SOAK_REASON:-hardware validation (P-9): first real camera streams}"
exec bash "$(dirname -- "$0")/nightly/launch.sh" hardware "$@"
