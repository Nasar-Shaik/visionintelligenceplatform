#!/usr/bin/env bash
# Housekeeping — reclaim what verification runs leave behind.
#
#   ./scripts/cleanup.sh                 # show what would be reclaimed, change nothing
#   ./scripts/cleanup.sh --prune         # delete run directories older than KEEP_RUNS days
#   ./scripts/cleanup.sh --docker        # reclaim the docker build cache
#   ./scripts/cleanup.sh --fixtures      # remove leftover verification cameras and the RTSP fixture
#   ./scripts/cleanup.sh --all
#
# ⚠️ **Dry by default.** A cleanup script that deletes when you meant to look is a cleanup script you
# stop trusting, and this one runs unattended as part of the weekly profile.
set -u

REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$REPO/scripts/nightly.config"
ROOT="$REPO/${REPORT_ROOT:-scripts/reports/nightly}"

PRUNE=false
DOCKER=false
FIXTURES=false
DRY=true

while [ $# -gt 0 ]; do
  case "$1" in
    --prune) PRUNE=true; DRY=false ;;
    --docker) DOCKER=true; DRY=false ;;
    --fixtures) FIXTURES=true; DRY=false ;;
    --all) PRUNE=true; DOCKER=true; FIXTURES=true; DRY=false ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

echo ""
echo "── run directories ───────────────────────────────────────"
if [ -d "$ROOT" ]; then
  KEEP="${KEEP_RUNS:-30}"
  # ⚠️ `latest` is a symlink, never a run. Deleting it by age would break the one stable path.
  OLD=$(find "$ROOT" -maxdepth 1 -type d -mtime "+$KEEP" ! -path "$ROOT" 2>/dev/null | sort)
  COUNT=$(printf '%s' "$OLD" | grep -c . || true)
  SIZE=$(du -sh "$ROOT" 2>/dev/null | awk '{print $1}')
  echo "  $ROOT is $SIZE · $COUNT directory(ies) older than $KEEP days"
  if [ "$COUNT" -gt 0 ]; then
    printf '%s\n' "$OLD" | sed 's|^|    |'
    if [ "$PRUNE" = true ]; then
      printf '%s\n' "$OLD" | while read -r d; do [ -n "$d" ] && rm -rf "$d"; done
      echo "  removed $COUNT run(s)"
      # The index lists what exists; regenerate it from what survived.
      LATEST=$(ls -1 "$ROOT" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}' | tail -1)
      [ -n "$LATEST" ] && node "$REPO/scripts/nightly/report.mjs" --run "$ROOT/$LATEST" >/dev/null 2>&1
    else
      echo "  (dry run — pass --prune to delete)"
    fi
  fi
else
  echo "  none yet"
fi

echo ""
echo "── docker ────────────────────────────────────────────────"
docker system df 2>/dev/null | sed 's/^/  /'
if [ "$DOCKER" = true ]; then
  # ⚠️ Build cache only. Never `system prune -a`: that removes images the deployment is running from
  # and turns a housekeeping run into an outage.
  docker builder prune -f >/dev/null 2>&1 && echo "  build cache reclaimed" || echo "  build cache prune failed"
else
  echo "  (dry run — pass --docker to reclaim the build cache)"
fi

echo ""
echo "── leftover verification fixtures ────────────────────────"
FIXTURE=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -c '^vip-rtsp-fixture$' || true)
echo "  rtsp fixture containers: $FIXTURE"
if [ "$FIXTURES" = true ]; then
  # Each suite knows how to remove its own cameras; asking them is safer than deleting by pattern.
  for s in inference-soak hardening inference; do
    [ -f "$REPO/docs/review/p8/$s.mjs" ] && node "$REPO/docs/review/p8/$s.mjs" clean >/dev/null 2>&1
  done
  docker rm -f vip-rtsp-fixture >/dev/null 2>&1 || true
  echo "  verification cameras and the RTSP fixture removed"
else
  echo "  (dry run — pass --fixtures to remove them)"
fi

echo ""
[ "$DRY" = true ] && echo "nothing was changed. Use --all to act." || echo "cleanup done."
echo ""
