#!/usr/bin/env sh
# Thin wrapper so every production compose command carries the same file and env-file.
#
#   infra/docker/prod.sh up -d --build
#   infra/docker/prod.sh ps
#   infra/docker/prod.sh logs -f gateway
#
# ⚠️ Not sugar. Forgetting `--env-file .env.production` makes compose fall back to `.env` — the
# *development* file — so the stack comes up with the dev JWT secret and the dev Mongo password
# while every container reports healthy. Wrapping it removes the chance to get it wrong.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
exec docker compose \
  -f "$ROOT/infra/docker/docker-compose.prod.yml" \
  --env-file "${VIP_ENV_FILE:-$ROOT/.env.production}" \
  "$@"
