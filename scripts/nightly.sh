#!/usr/bin/env bash
# THE command. Run this before you sleep; read scripts/reports/nightly/latest/summary.md in the morning.
#
#   ./scripts/nightly.sh                        # the standard run (~2h with defaults)
#   ./scripts/nightly.sh --dry-run              # what would run, and what is switched off
#   ./scripts/nightly.sh --resume               # pick up a run that was interrupted
#   SOAK_MINUTES=15 RUN_MUTATION=false ./scripts/nightly.sh    # a quick one
#
# Everything it does is configured in scripts/nightly.config — see scripts/README.md.
exec bash "$(dirname -- "$0")/nightly/launch.sh" nightly "$@"
