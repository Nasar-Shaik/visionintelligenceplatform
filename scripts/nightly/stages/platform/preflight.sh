#!/usr/bin/env bash
# Pre-flight — is this machine in a state where the next several hours will mean anything?
#
# ⚠️ **This stage is declared `abort`.** Every measurement that follows assumes a running stack, a
# healthy runtime and enough disk to rebuild an image. Benchmarking a stack that is not up does not
# produce a bad number; it produces a *confident* bad number, which is worse — you would read it in
# the morning and believe it.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

say_kv() { printf '  %-28s %s\n' "$1" "$2"; }

echo "── docker ────────────────────────────────────────────────"
if docker info >/dev/null 2>&1; then
  ok "the docker daemon is answering"
else
  bad "the docker daemon is not answering — nothing below can run"
  headline "Docker is not running"
  finish
fi

echo ""
echo "── the containers this run needs ─────────────────────────"
MISSING=""
for name in $REQUIRED_CONTAINERS; do
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo absent)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)
  if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
    ok "$name — $state/$health"
  else
    bad "$name — $state/$health"
    MISSING="$MISSING $name"
  fi
done

echo ""
echo "── disk ──────────────────────────────────────────────────"
# ⚠️ Measured on the Docker VM's filesystem as well as the repo's. The mutation stage rebuilds
# images, and it is the daemon that runs out of room, not the checkout.
FREE_GB=$(df -g "$REPO" 2>/dev/null | awk 'NR==2 {print $4}')
[ -n "$FREE_GB" ] || FREE_GB=$(df -k "$REPO" | awk 'NR==2 {print int($4/1048576)}')
say_kv "free on the repo volume" "${FREE_GB} GB (need ${MIN_FREE_GB})"
if [ "${FREE_GB:-0}" -ge "$MIN_FREE_GB" ]; then
  ok "enough disk for image rebuilds"
else
  bad "only ${FREE_GB} GB free — the mutation stage rebuilds images and will fail part-way"
fi

RECLAIMABLE=$(docker system df 2>/dev/null | awk '/Build Cache/ {print $NF}')
[ -n "$RECLAIMABLE" ] && note "docker build cache reclaimable: $RECLAIMABLE (scripts/cleanup.sh)"

echo ""
echo "── the inference runtime ─────────────────────────────────"
RUNTIME_JSON=$(docker exec vip-prod-inference-1 python -c \
  "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8085/runtime',timeout=5).read().decode())" 2>/dev/null)
if printf '%s' "$RUNTIME_JSON" | grep -q '"health": "ok"'; then
  ok "the runtime reports health ok"
  PROVIDER=$(printf '%s' "$RUNTIME_JSON" | sed -n 's/.*"executionProvider": "\([^"]*\)".*/\1/p' | head -1)
  say_kv "execution provider" "${PROVIDER:-unknown}"
else
  bad "the runtime is not healthy — inference measurements would be meaningless"
fi

echo ""
echo "── the working tree ──────────────────────────────────────"
DIRTY=$(tree_fingerprint)
DIRTY_COUNT=$(printf '%s' "$DIRTY" | grep -c . || true)
say_kv "commit" "$(git_commit)"
say_kv "uncommitted files" "$DIRTY_COUNT"
if [ "$DIRTY_COUNT" -eq 0 ]; then
  ok "the tree is clean — a mutation restore can only put back what it took"
elif [ "$REQUIRE_CLEAN_TREE" = "true" ]; then
  # ⚠️ Not fussiness. The mutation suite edits real files and restores them; the safety of that
  # depends on knowing exactly what "restored" means. With uncommitted work in the tree, a restore
  # that goes wrong is indistinguishable from work you did yesterday, and you find out by losing it.
  bad "$DIRTY_COUNT uncommitted file(s) and REQUIRE_CLEAN_TREE=true"
  printf '%s\n' "$DIRTY" | sed 's/^/      /'
  warn "commit or stash first, or set RUN_MUTATION=false if you only want measurements"
else
  warn "$DIRTY_COUNT uncommitted file(s) — allowed by config, but the mutation stage writes to this tree"
fi

echo ""
echo "── the plan ──────────────────────────────────────────────"
say_kv "profile" "$PROFILE"
say_kv "soak" "${SOAK_MINUTES} min · ${SOAK_CAMERAS} cameras"

# The long-soak policy, enforced rather than documented. Anything over an hour has to say why, and
# the reason travels into the report so the morning knows what the night was for.
if [ "$SOAK_MINUTES" -gt 60 ]; then
  if [ -n "$SOAK_REASON" ]; then
    ok "long soak justified — $SOAK_REASON"
  else
    bad "SOAK_MINUTES=$SOAK_MINUTES needs SOAK_REASON (leak suspected, release candidate, P-9, P-10, GA)"
  fi
fi

cat >"$(metrics_path)" <<JSON
{
  "commit": "$(git_commit)",
  "freeGb": ${FREE_GB:-0},
  "uncommittedFiles": $DIRTY_COUNT,
  "soakMinutes": $SOAK_MINUTES,
  "soakCameras": $SOAK_CAMERAS,
  "soakReason": "$(json_escape "$SOAK_REASON")",
  "executionProvider": "$(json_escape "${PROVIDER:-unknown}")",
  "missingContainers": "$(json_escape "$MISSING")"
}
JSON

if [ "$STAGE_FAILURES" -eq 0 ]; then
  headline "stack up, runtime healthy, ${FREE_GB}GB free"
else
  headline "$STAGE_FAILURES pre-flight check(s) failed"
fi
finish
