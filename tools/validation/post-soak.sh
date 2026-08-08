#!/usr/bin/env bash
#
# Post-soak verification for a release soak (P-11).
#
#   ./tools/validation/post-soak.sh .soak-p11
#
# Runs the five checks a soak cannot make about itself and writes one file per check into
# `<dir>/post/`. Each file starts with `PASS` or `FAIL` on its own first line — that is the token
# `soak-report.mjs` reads to decide criteria C9–C13.
#
# ⛔ Nothing here stops on failure. A run that aborts at the first red leaves the remaining checks
# absent, and an absent check renders as NOT RUN — indistinguishable, at a glance, from one nobody
# needed. Every check runs, every result is written, and the report totals them.
#
# ⚠️ These are the *deployed* checks: they exercise https://localhost through the edge, not a dev
# server. A suite that passes under `pnpm dev` and fails in the container is the defect class this
# project has already been bitten by.
set -u

DIR="${1:-.soak-p11}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p "$DIR/post"

run() {
  local name="$1" label="$2"
  shift 2
  local out="$DIR/post/$name.txt"
  local log
  log="$(mktemp)"
  echo "── $label ─────────────────────────────────────────────"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    { echo "PASS  $label"; echo "command: $*"; echo "duration: $((SECONDS - start))s"; echo; tail -120 "$log"; } >"$out"
    echo "   PASS  ($((SECONDS - start))s)  → $out"
  else
    local code=$?
    { echo "FAIL  $label (exit $code)"; echo "command: $*"; echo "duration: $((SECONDS - start))s"; echo; tail -200 "$log"; } >"$out"
    echo "   FAIL  exit $code ($((SECONDS - start))s)  → $out"
  fi
  cp "$log" "$DIR/post/$name.full.log"
  rm -f "$log"
}

# 1. Is the product actually online, through the edge, with a real token?
run deployment "Deployment verification" node tools/validation/verify-deployment.mjs

# 2. Does a real browser see it? Playwright against https://localhost.
run browser "Browser certification" pnpm --filter @vip/e2e-browser certify

# 3. The repository gate: lint, typecheck, unit tests across the workspace.
run repo-gate "Repository gate (turbo lint typecheck test)" pnpm turbo lint typecheck test

# 4. The runtime modules this release added, run the way CI runs them.
#    ⚠️ `python3 -B` — a same-length mutation survives the .pyc cache and the suite passes over it.
run module-tests "Runtime module tests (behaviour, track history, scene)" \
  bash -c "cd '$ROOT/ai/inference' && python3 -B -m unittest discover -s tests -p 'test_*.py' -v 2>&1"

# 5. The contract seams: schema parity across languages, and the perception boundary.
run contracts "Contract and perception-boundary checks" pnpm verify:contracts

echo
echo "post-soak results written to $DIR/post/"
for f in "$DIR"/post/*.txt; do [ -f "$f" ] && printf '   %s\n' "$(head -n1 "$f")"; done
