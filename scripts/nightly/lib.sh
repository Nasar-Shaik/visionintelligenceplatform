#!/usr/bin/env bash
# Shared helpers for the unattended verification framework.
#
# ⚠️ Written for **bash 3.2** — the version macOS ships and therefore the one this will actually run
# on. No associative arrays, no `mapfile`, no `${var^^}`. If you reach for one of those the script
# will fail at 02:00 on the machine it was written for, which is the worst possible time to find out.

# ── time ─────────────────────────────────────────────────────────────────────────────────────────
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_epoch() { date +%s; }

# Human duration from seconds: 4210 → "1h 10m 10s"
human_duration() {
  local s="$1" h m
  h=$((s / 3600))
  m=$(((s % 3600) / 60))
  s=$((s % 60))
  if [ "$h" -gt 0 ]; then
    printf '%dh %dm %ds' "$h" "$m" "$s"
  elif [ "$m" -gt 0 ]; then
    printf '%dm %ds' "$m" "$s"
  else
    printf '%ds' "$s"
  fi
}

# ── logging ──────────────────────────────────────────────────────────────────────────────────────
# Everything goes to a file. `say` also reaches the terminal, because a run you cannot watch is a
# run you cannot abort.
say() { printf '%s\n' "$*"; }
log_line() { printf '[%s] %s\n' "$(now_iso)" "$*"; }

# ── JSON ─────────────────────────────────────────────────────────────────────────────────────────
# ⚠️ Minimal on purpose. Bash has no business building nested JSON — stages that need structure emit
# it from node instead. This escapes only what a status line can contain.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/ /g' | tr -d '\n\r'
}

# Append one event to the run's append-only journal. The report reads this, not the console.
# ⚠️ Append-only and one line per event, so a killed run still leaves a readable history.
journal() {
  local kind="$1" id="$2" status="$3" detail="$4" extra="$5"
  [ -n "$RUN_DIR" ] || return 0
  printf '{"at":"%s","kind":"%s","id":"%s","status":"%s","detail":"%s"%s}\n' \
    "$(now_iso)" "$(json_escape "$kind")" "$(json_escape "$id")" \
    "$(json_escape "$status")" "$(json_escape "$detail")" \
    "${extra:+,$extra}" >>"$RUN_DIR/journal.jsonl"
}

# ── portable timeout ─────────────────────────────────────────────────────────────────────────────
# macOS ships no `timeout(1)` and this tool must not require coreutils. A stage that hangs at 03:00
# would otherwise consume the whole night and produce nothing.
#
# ⚠️ Returns 124 on timeout, matching GNU `timeout`, so callers can tell "failed" from "never
# finished" — they need different fixes and the summary reports them differently.
run_with_timeout() {
  local secs="$1"
  shift
  if [ "$secs" -le 0 ]; then
    "$@"
    return $?
  fi

  "$@" &
  local pid=$! waited=0 rc=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM "$pid" 2>/dev/null
      sleep 5
      kill -KILL "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 2
    waited=$((waited + 2))
  done
  wait "$pid"
  rc=$?
  return $rc
}

# ── config ───────────────────────────────────────────────────────────────────────────────────────
# Values already in the environment win, so a one-off override needs no file edit:
#   SOAK_MINUTES=5 RUN_MUTATION=false ./scripts/nightly.sh
load_config() {
  local file="$1"
  [ -f "$file" ] || die "config not found: $file"
  # shellcheck disable=SC1090
  . "$file"
}

# Is a stage switched on? Unset counts as on — a new stage added to a profile should run rather than
# silently do nothing because nobody updated their config file.
stage_enabled() {
  local var="$1"
  [ -n "$var" ] || return 0
  eval "local value=\${$var:-true}"
  case "$value" in
    true | 1 | yes | on) return 0 ;;
    false | 0 | no | off) return 1 ;;
    *) die "config: $var must be true or false, got '$value'" ;;
  esac
}

die() {
  printf 'nightly: %s\n' "$*" >&2
  exit 2
}

# ── repo helpers ─────────────────────────────────────────────────────────────────────────────────
git_commit() { git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown; }

# Files changed in tracked source, ignoring anything this framework itself writes. Used to prove a
# run put the tree back exactly as it found it.
tree_fingerprint() {
  git -C "$REPO" status --porcelain 2>/dev/null |
    grep -v -E ' (reports|logs)/nightly/' |
    sort
}
