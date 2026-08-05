#!/usr/bin/env bash
# The stage runner. Profiles are data; this file is the only thing that executes them.
#
#   scripts/nightly/engine.sh --profile nightly [--resume] [--run-id 2026-08-06] [--dry-run]
#
# ### What a stage is
#
# One line in `profiles/<name>.stages`, one script in `stages/`. The script gets a working directory,
# a log file and a metrics directory, and returns 0 for pass. That is the whole contract — which is
# what lets hardware validation, ONVIF or tracking benchmarks be added later without touching this
# file.
#
# ### ⚠️ Why a failed stage does not end the night
#
# The point of running unattended is to come back to *evidence*, and one broken thing should not cost
# you the other six answers. So a failure is recorded and the run continues — except where continuing
# would produce numbers that are not true. A stage declares `abort` when its failure invalidates what
# follows (pre-flight is the obvious one: benchmarking a stack that is not up measures nothing), and
# every stage names what it `requires` so dependents are **skipped and reported as skipped**, never
# quietly passed over.

set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
export REPO
. "$REPO/scripts/nightly/lib.sh"

PROFILE=nightly
RESUME=false
DRY_RUN=false
RUN_ID=""
CONFIG="$REPO/scripts/nightly.config"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --resume) RESUME=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

load_config "$CONFIG"
[ -f "$REPO/scripts/nightly.config.local" ] && . "$REPO/scripts/nightly.config.local"

# Overridable so the framework can be tested with synthetic stages. ⚠️ A stage runner nobody can
# exercise on fake stages is one whose failure semantics are only ever tested by a real failure at
# 03:00 — see scripts/nightly/selftest.sh.
PROFILE_DIR="${PROFILE_DIR:-$REPO/scripts/nightly/profiles}"
STAGES_DIR="${STAGES_DIR:-$REPO/scripts/nightly/stages}"
export STAGES_DIR

MANIFEST="$PROFILE_DIR/$PROFILE.stages"
[ -f "$MANIFEST" ] || die "no such profile: $PROFILE (looked for $MANIFEST)"

# ── the run directory ────────────────────────────────────────────────────────────────────────────
[ -n "$RUN_ID" ] || RUN_ID=$(date +%Y-%m-%d)
case "${REPORT_ROOT:-scripts/reports/nightly}" in
  /*) RUN_ROOT="${REPORT_ROOT}" ;;
  *) RUN_ROOT="$REPO/${REPORT_ROOT:-scripts/reports/nightly}" ;;
esac
RUN_DIR="$RUN_ROOT/$RUN_ID"

# ⚠️ A second run on the same day must not overwrite the morning's evidence. Resume reuses the
# directory deliberately; otherwise the new run gets its own suffix.
if [ -d "$RUN_DIR" ] && [ "$RESUME" != true ] && [ "$DRY_RUN" != true ]; then
  RUN_ID="$RUN_ID-$(date +%H%M)"
  RUN_DIR="$RUN_ROOT/$RUN_ID"
fi
export RUN_DIR RUN_ID PROFILE

# ⚠️ A dry run creates nothing. It exists to answer "what would tonight do?", and a planning command
# that leaves an empty run directory behind pollutes the index it is meant to help you read.
if [ "$DRY_RUN" != true ]; then
  mkdir -p "$RUN_DIR/logs" "$RUN_DIR/metrics" "$RUN_DIR/status" "$RUN_DIR/guards"

  # One stable path, so "look at last night" never needs a date. Repointed at the START of a run,
  # not the end — a run that dies half-way is exactly the one you want to open in the morning.
  rm -f "$RUN_ROOT/latest"
  ln -s "$RUN_ID" "$RUN_ROOT/latest" 2>/dev/null || true
fi

case "${LOG_ROOT:-scripts/logs/nightly}" in
  /*) LOG_LINK_DIR="${LOG_ROOT}" ;;
  *) LOG_LINK_DIR="$REPO/${LOG_ROOT:-scripts/logs/nightly}" ;;
esac

RUN_LOG=/dev/null
if [ "$DRY_RUN" != true ]; then
  # `<LOG_ROOT>/current` is a pointer, not a copy. The logs have exactly one home — inside the run
  # they belong to — so there is never a question of which of two files is authoritative.
  mkdir -p "$LOG_LINK_DIR"
  rm -f "$LOG_LINK_DIR/current"
  ln -s "$RUN_DIR/logs" "$LOG_LINK_DIR/current" 2>/dev/null || true
  RUN_LOG="$RUN_DIR/logs/run.log"
fi
STARTED_EPOCH=$(now_epoch)

# ── restoring the tree if the night ends badly ───────────────────────────────────────────────────
# Some stages edit real source files and rebuild real images (the mutation suite does both). If the
# machine sleeps, the terminal closes or someone hits ^C, those edits must not survive until morning.
# A stage registers an undo command; this trap runs every one that is still outstanding.
cleanup_guards() {
  local guard
  for guard in "$RUN_DIR"/guards/*.restore; do
    [ -f "$guard" ] || continue
    say ""
    say "⚠️  restoring after an interrupted stage: $(basename "$guard" .restore)"
    log_line "trap: running restore for $(basename "$guard" .restore)" >>"$RUN_LOG"
    sh "$guard" >>"$RUN_LOG" 2>&1 || say "⚠️  restore reported an error — see $RUN_LOG"
    rm -f "$guard"
  done
}

on_exit() {
  local rc=$?
  [ "$DRY_RUN" = true ] || cleanup_guards
  rm -f "$LOG_LINK_DIR/current"
  exit $rc
}
trap on_exit EXIT
trap 'say ""; say "interrupted — restoring before exit"; exit 130' INT TERM

# ── run metadata ─────────────────────────────────────────────────────────────────────────────────
TREE_BEFORE=$(tree_fingerprint)
COMMIT=$(git_commit)

[ "$DRY_RUN" = true ] || cat >"$RUN_DIR/run.json" <<JSON
{
  "runId": "$RUN_ID",
  "profile": "$PROFILE",
  "startedAt": "$(now_iso)",
  "commit": "$COMMIT",
  "host": "$(hostname)",
  "resumed": $RESUME
}
JSON

say ""
say "════════════════════════════════════════════════════════════════════"
say "  VIP unattended verification · profile: $PROFILE"
say "  run $RUN_ID · commit $COMMIT · started $(now_iso)"
say "  reports → ${REPORT_ROOT:-scripts/reports/nightly}/$RUN_ID"
say "  follow  → tail -f ${LOG_ROOT:-scripts/logs/nightly}/current/run.log"
say "════════════════════════════════════════════════════════════════════"
say ""

{
  log_line "run $RUN_ID profile=$PROFILE commit=$COMMIT resume=$RESUME"
} >>"$RUN_LOG"

# ── the stage loop ───────────────────────────────────────────────────────────────────────────────
FAILED_IDS=""
PASSED_IDS=""
ABORTED=false

status_of() {
  local id="$1"
  [ -f "$RUN_DIR/status/$id" ] && cat "$RUN_DIR/status/$id" || echo ""
}

# Write the run-level verdicts the report needs to see.
#
# ⚠️ Called BEFORE any `always` stage as well as after the loop, because the report is itself a stage
# — and a report generated before these were written showed "Duration —" and "Working tree —" on
# every run. Idempotent: the second call refreshes rather than duplicates.
FINALISED=false
finalise_run() {
  local after
  after=$(tree_fingerprint)
  if [ "$TREE_BEFORE" = "$after" ]; then
    printf 'clean' >"$RUN_DIR/status/_tree"
  else
    printf 'dirty' >"$RUN_DIR/status/_tree"
    {
      echo "tree before:"; printf '%s\n' "$TREE_BEFORE"
      echo "tree after:";  printf '%s\n' "$after"
    } >"$RUN_DIR/logs/tree-drift.log"
    [ "$FINALISED" = true ] || say "  ⚠️  THE WORKING TREE CHANGED during this run — see logs/tree-drift.log"
  fi
  cat >"$RUN_DIR/finished.json" <<JSON
{
  "finishedAt": "$(now_iso)",
  "seconds": $(($(now_epoch) - STARTED_EPOCH)),
  "aborted": $ABORTED,
  "failed": "$(printf '%s' "$FAILED_IDS" | sed -e 's/^ *//')",
  "passed": "$(printf '%s' "$PASSED_IDS" | sed -e 's/^ *//')"
}
JSON
  FINALISED=true
}

set_status() {
  printf '%s' "$2" >"$RUN_DIR/status/$1"
}

# Every dependency must have passed. A dependency that was disabled or skipped is not a pass: the
# evidence it would have produced does not exist, so anything downstream cannot be trusted either.
#
# ⚠️ The token `always` means "run even if the run aborted". Exactly one stage uses it — the report.
# The first version of this loop skipped everything after an abort, including the summary, so the
# night most in need of a written explanation was the one that produced none.
deps_satisfied() {
  local requires="$1" dep
  [ -n "$requires" ] || return 0
  [ "$requires" = "always" ] && return 0
  for dep in $(printf '%s' "$requires" | tr ',' ' '); do
    [ "$(status_of "$dep")" = "passed" ] || return 1
  done
  return 0
}

while IFS='|' read -r ID TITLE SCRIPT ENABLE_VAR REQUIRES ON_FAIL TIMEOUT_VAR; do
  case "$ID" in '' | \#*) continue ;; esac

  # Trim the padding the manifest uses for readability.
  ID=$(printf '%s' "$ID" | tr -d ' ')
  SCRIPT=$(printf '%s' "$SCRIPT" | tr -d ' ')
  ENABLE_VAR=$(printf '%s' "$ENABLE_VAR" | tr -d ' ')
  REQUIRES=$(printf '%s' "$REQUIRES" | tr -d ' ')
  ON_FAIL=$(printf '%s' "$ON_FAIL" | tr -d ' ')
  TIMEOUT_VAR=$(printf '%s' "$TIMEOUT_VAR" | tr -d ' ')
  TITLE=$(printf '%s' "$TITLE" | sed -e 's/^ *//' -e 's/ *$//')

  STAGE_PATH="$STAGES_DIR/$SCRIPT"

  if [ "$DRY_RUN" = true ]; then
    stage_enabled "$ENABLE_VAR" && say "  would run  $ID — $TITLE" || say "  disabled   $ID — $TITLE ($ENABLE_VAR)"
    continue
  fi

  # ⚠️ Disabled is checked BEFORE aborted, and the order is the whole point. A stage you switched off
  # yourself did not "get skipped because something else broke" — reporting it that way sends the
  # morning looking for a failure that never happened.
  if ! stage_enabled "$ENABLE_VAR"; then
    set_status "$ID" "disabled"
    journal stage "$ID" disabled "$ENABLE_VAR is false" ""
    say "  ○  $ID — disabled ($ENABLE_VAR=false)"
    continue
  fi

  if [ "$ABORTED" = true ] && [ "$REQUIRES" != "always" ]; then
    set_status "$ID" "skipped"
    journal stage "$ID" skipped "an earlier stage aborted the run" ""
    say "  ⏭  $ID — skipped (run aborted earlier)"
    continue
  fi

  if [ "$RESUME" = true ] && [ "$(status_of "$ID")" = "passed" ]; then
    say "  ↩︎  $ID — already passed in this run, keeping it"
    PASSED_IDS="$PASSED_IDS $ID"
    continue
  fi

  # ⚠️ A stage whose script does not exist is **not** a pass. Profiles for milestones that have not
  # happened yet (hardware validation, ONVIF, pilot) deliberately reference scripts that do not
  # exist, and the summary must say "not implemented" rather than showing a green tick for work
  # nobody has done.
  if [ ! -f "$STAGE_PATH" ]; then
    set_status "$ID" "not-implemented"
    journal stage "$ID" not-implemented "no script at stages/$SCRIPT" ""
    say "  ⚠️  $ID — NOT IMPLEMENTED (stages/$SCRIPT does not exist)"
    continue
  fi

  if ! deps_satisfied "$REQUIRES"; then
    set_status "$ID" "skipped"
    journal stage "$ID" skipped "requires $REQUIRES" ""
    say "  ⏭  $ID — skipped (needs $REQUIRES)"
    continue
  fi

  # An `always` stage is a finalisation stage — give it the run-level verdicts before it starts.
  [ "$REQUIRES" = "always" ] && finalise_run

  eval "STAGE_TIMEOUT=\${$TIMEOUT_VAR:-0}"
  [ -n "$STAGE_TIMEOUT" ] || STAGE_TIMEOUT=0

  STAGE_LOG="$RUN_DIR/logs/$ID.log"
  export STAGE_ID="$ID" STAGE_LOG METRICS_DIR="$RUN_DIR/metrics"
  set_status "$ID" "running"
  journal stage "$ID" running "$TITLE" ""

  say "  ▶  $ID — $TITLE"
  STAGE_START=$(now_epoch)
  {
    echo "════ $ID · $TITLE"
    echo "started $(now_iso) · timeout ${STAGE_TIMEOUT}s"
    echo ""
  } >"$STAGE_LOG"

  run_with_timeout "$STAGE_TIMEOUT" bash "$STAGE_PATH" >>"$STAGE_LOG" 2>&1
  RC=$?
  STAGE_SECONDS=$(($(now_epoch) - STAGE_START))

  # A stage may leave a one-line headline for the report; otherwise the report falls back to the log.
  HEADLINE=""
  [ -f "$RUN_DIR/status/$ID.headline" ] && HEADLINE=$(cat "$RUN_DIR/status/$ID.headline")

  if [ "$RC" -eq 0 ]; then
    set_status "$ID" "passed"
    PASSED_IDS="$PASSED_IDS $ID"
    journal stage "$ID" passed "$HEADLINE" "\"seconds\":$STAGE_SECONDS"
    say "     ✓ passed in $(human_duration "$STAGE_SECONDS")${HEADLINE:+ — $HEADLINE}"
  elif [ "$RC" -eq 124 ]; then
    set_status "$ID" "timeout"
    FAILED_IDS="$FAILED_IDS $ID"
    journal stage "$ID" timeout "exceeded ${STAGE_TIMEOUT}s" "\"seconds\":$STAGE_SECONDS"
    say "     ✗ TIMED OUT after $(human_duration "$STAGE_SECONDS")"
  else
    set_status "$ID" "failed"
    FAILED_IDS="$FAILED_IDS $ID"
    journal stage "$ID" failed "${HEADLINE:-exit $RC}" "\"seconds\":$STAGE_SECONDS,\"exit\":$RC"
    say "     ✗ FAILED (exit $RC) after $(human_duration "$STAGE_SECONDS")${HEADLINE:+ — $HEADLINE}"
  fi

  # ⚠️ A surviving guard means the stage did NOT clean up after itself — it crashed, was killed, or
  # timed out before reaching its own teardown. Run the undo now rather than at the end of the run,
  # so every later stage measures a restored deployment instead of a mutated one.
  #
  # The first version deleted the guard here unconditionally, on the assumption that a finished stage
  # had tidied up. That threw away the undo instruction in exactly the case it was written for: the
  # self-test's stage that registers a guard and then dies left the mutation applied and the recovery
  # command deleted.
  if [ -f "$RUN_DIR/guards/$ID.restore" ]; then
    say "     ⚠️ $ID left work behind — running its restore"
    sh "$RUN_DIR/guards/$ID.restore" >>"$STAGE_LOG" 2>&1 ||
      say "     ⚠️ the restore itself reported an error — see logs/$ID.log"
    rm -f "$RUN_DIR/guards/$ID.restore"
  fi

  if [ "$RC" -ne 0 ] && [ "$ON_FAIL" = "abort" ]; then
    ABORTED=true
    journal run "$ID" aborting "this stage's failure invalidates everything after it" ""
    say ""
    say "  ⚠️  $ID is declared 'abort' — later stages would measure a broken stack, so they are skipped."
  fi
done <"$MANIFEST"

[ "$DRY_RUN" = true ] && exit 0

# ── did we leave the tree as we found it? ────────────────────────────────────────────────────────
# ⚠️ Asked because this framework runs suites that edit source and rebuild images. A night that
# leaves a mutation applied is worse than a night that ran nothing, and it must be impossible to
# discover that by accident in the morning.
finalise_run

TOTAL_SECONDS=$(($(now_epoch) - STARTED_EPOCH))

say ""
say "  finished in $(human_duration "$TOTAL_SECONDS")"
say ""

[ -z "$(printf '%s' "$FAILED_IDS" | tr -d ' ')" ] && exit 0
exit 1
