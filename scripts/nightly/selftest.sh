#!/usr/bin/env bash
# Does the runner behave the way the framework claims it does?
#
#   ./scripts/nightly/selftest.sh
#
# ### ⚠️ Why this exists
#
# Everything valuable about this framework is in its **failure** semantics: a dependent stage is
# skipped rather than run, a missing script reports NOT IMPLEMENTED rather than passing, a hang is
# killed rather than eating the night, an interrupted stage is restored rather than left applied.
# None of that is exercised by a green run. Without this file those paths would be tested for the
# first time by a real failure at 03:00, which is the worst possible moment to discover the runner
# quietly does the wrong thing.
#
# Runs against synthetic stages in a temp directory. Touches no container and no real verification.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/nightly-selftest.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
check() {
  if [ "$1" = "$2" ]; then
    printf '  ✓ %s\n' "$3"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %s — expected "%s", got "%s"\n' "$3" "$2" "$1"
    FAIL=$((FAIL + 1))
  fi
}

mkdir -p "$TMP/stages" "$TMP/profiles" "$TMP/out"

cat >"$TMP/stages/pass.sh" <<'EOF'
#!/usr/bin/env bash
echo "  ✓ synthetic pass"
printf 'all good' >"$RUN_DIR/status/$STAGE_ID.headline"
exit 0
EOF

cat >"$TMP/stages/fail.sh" <<'EOF'
#!/usr/bin/env bash
echo "  ✗ synthetic failure"
printf 'deliberately broken' >"$RUN_DIR/status/$STAGE_ID.headline"
exit 1
EOF

cat >"$TMP/stages/hang.sh" <<'EOF'
#!/usr/bin/env bash
echo "sleeping longer than my timeout"
sleep 120
EOF

# Registers an undo command and then dies without cleaning up — the sleeping-laptop case.
cat >"$TMP/stages/killed.sh" <<'EOF'
#!/usr/bin/env bash
printf 'touch "%s/restored.marker"\n' "$RUN_DIR" >"$RUN_DIR/guards/$STAGE_ID.restore"
echo "registered a guard, now dying"
kill -9 $$
EOF

# The report stage under test is the REAL one. Checking that a synthetic stub "generated a summary"
# would prove nothing about the file you actually read in the morning.
cp "$REPO/scripts/nightly/stages/_preamble.sh" "$TMP/stages/_preamble.sh"
cp "$REPO/scripts/nightly/stages/platform/report.sh" "$TMP/stages/realreport.sh"

chmod +x "$TMP"/stages/*.sh

cat >"$TMP/profiles/t.stages" <<'EOF'
alpha    | passes            | pass.sh      | RUN_ALPHA   |       | continue | T_NONE
bravo    | fails             | fail.sh      | RUN_BRAVO   | alpha | continue | T_NONE
charlie  | needs bravo       | pass.sh      | RUN_CHARLIE | bravo | continue | T_NONE
delta    | needs alpha       | pass.sh      | RUN_DELTA   | alpha | continue | T_NONE
echo     | switched off      | pass.sh      | RUN_ECHO    | alpha | continue | T_NONE
foxtrot  | no script exists  | nothere.sh   | RUN_FOXTROT | alpha | continue | T_NONE
golf     | hangs             | hang.sh      | RUN_GOLF    | alpha | continue | T_SHORT
report   | always runs       | realreport.sh| RUN_REPORT  | always| continue | T_NONE
EOF

echo ""
echo "── stage semantics ───────────────────────────────────────"
REPORT_ROOT="$TMP/out" PROFILE_DIR="$TMP/profiles" STAGES_DIR="$TMP/stages" \
  RUN_ECHO=false T_SHORT=6 T_NONE=0 KEEP_AWAKE=false \
  bash "$REPO/scripts/nightly/engine.sh" --profile t --run-id st >"$TMP/run.log" 2>&1
RC=$?

S="$TMP/out/st/status"
check "$(cat "$S/alpha" 2>/dev/null)" "passed" "a stage that exits 0 passes"
check "$(cat "$S/bravo" 2>/dev/null)" "failed" "a stage that exits 1 fails"
check "$(cat "$S/charlie" 2>/dev/null)" "skipped" "⚠️ a stage whose dependency failed is SKIPPED, not run"
check "$(cat "$S/delta" 2>/dev/null)" "passed" "an independent stage still runs after an unrelated failure"
check "$(cat "$S/echo" 2>/dev/null)" "disabled" "a stage switched off reports disabled"
check "$(cat "$S/foxtrot" 2>/dev/null)" "not-implemented" "⚠️ a missing script is NOT-IMPLEMENTED, never a pass"
check "$(cat "$S/golf" 2>/dev/null)" "timeout" "⚠️ a hanging stage is killed at its timeout"
check "$(cat "$S/report" 2>/dev/null)" "passed" "an 'always' stage runs even with failures present"
check "$RC" "1" "the run exits non-zero when any stage failed"

echo ""
echo "── the report was written ────────────────────────────────"
[ -f "$TMP/out/st/summary.md" ] && check "yes" "yes" "summary.md exists" || check "no" "yes" "summary.md exists"
grep -q "RED" "$TMP/out/st/summary.md" 2>/dev/null &&
  check "RED" "RED" "the verdict is RED when stages failed" ||
  check "not-red" "RED" "the verdict is RED when stages failed"
grep -q "not-implemented" "$TMP/out/st/summary.md" 2>/dev/null &&
  check "named" "named" "the summary names the not-implemented stage" ||
  check "silent" "named" "the summary names the not-implemented stage"

echo ""
echo "── resume keeps what already passed ──────────────────────"
REPORT_ROOT="$TMP/out" PROFILE_DIR="$TMP/profiles" STAGES_DIR="$TMP/stages" \
  RUN_ECHO=false T_SHORT=6 T_NONE=0 KEEP_AWAKE=false \
  bash "$REPO/scripts/nightly/engine.sh" --profile t --run-id st --resume >"$TMP/resume.log" 2>&1
grep -q "alpha — already passed" "$TMP/resume.log" &&
  check "kept" "kept" "⚠️ resume does not re-run a stage that already passed" ||
  check "re-ran" "kept" "⚠️ resume does not re-run a stage that already passed"

echo ""
echo "── an interrupted stage is restored ──────────────────────"
cat >"$TMP/profiles/k.stages" <<'EOF'
killed | dies mid-stage | killed.sh | RUN_KILLED |  | continue | T_NONE
EOF
REPORT_ROOT="$TMP/out" PROFILE_DIR="$TMP/profiles" STAGES_DIR="$TMP/stages" \
  T_NONE=0 KEEP_AWAKE=false \
  bash "$REPO/scripts/nightly/engine.sh" --profile k --run-id kt >"$TMP/kill.log" 2>&1
[ -f "$TMP/out/kt/restored.marker" ] &&
  check "restored" "restored" "⚠️ a killed stage's undo command is run by the engine" ||
  check "left-broken" "restored" "⚠️ a killed stage's undo command is run by the engine"

echo ""
echo "── a dry run leaves nothing behind ───────────────────────"
BEFORE=$(ls -1 "$TMP/out" | wc -l | tr -d ' ')
REPORT_ROOT="$TMP/out" PROFILE_DIR="$TMP/profiles" STAGES_DIR="$TMP/stages" KEEP_AWAKE=false \
  bash "$REPO/scripts/nightly/engine.sh" --profile t --run-id dry --dry-run >/dev/null 2>&1
AFTER=$(ls -1 "$TMP/out" | wc -l | tr -d ' ')
check "$AFTER" "$BEFORE" "--dry-run creates no run directory"

echo ""
if [ "$FAIL" -eq 0 ]; then
  printf 'selftest: %d checks passed\n\n' "$PASS"
  exit 0
fi
printf 'selftest: %d passed, %d FAILED\n\n' "$PASS" "$FAIL"
echo "logs: $TMP (not deleted because the test failed)"
trap - EXIT
exit 1
