#!/usr/bin/env sh
# Restore a VIP deployment from a backup directory (P-5.8).
#
#   infra/docker/restore.sh backups/20260804T030000Z
#
# ⚠️ This **overwrites** the database and object storage of whatever deployment `VIP_ENV_FILE`
# points at. It asks first, and the prompt names the target — a restore run against production
# because the operator forgot to switch env files is not a recoverable mistake.
#
# ⚠️ Restoring into a *clean* host is the case that matters, and it is the one the runbook is
# written for: copy `config.env` to `.env.production` FIRST, bring the stack up, then run this.
# Without the original `config.env` the database restores fine and every camera credential in it is
# unreadable, because `CREDENTIAL_ENCRYPTION_KEY` derives the key that decrypts them.
#
# See docs/guides/BACKUP.md.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/infra/docker/prod.sh"
ENV_FILE="${VIP_ENV_FILE:-$ROOT/.env.production}"

SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: restore.sh <backup-dir>" >&2; exit 2; }
[ -f "$SRC/mongo.archive.gz" ] || { echo "missing $SRC/mongo.archive.gz" >&2; exit 2; }
[ -f "$SRC/objects.tar.gz" ] || { echo "missing $SRC/objects.tar.gz" >&2; exit 2; }

value_of() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
MONGO_USER=$(value_of MONGO_USER)
MONGO_PASSWORD=$(value_of MONGO_PASSWORD)
MINIO_USER=$(value_of MINIO_ROOT_USER)
MINIO_PASSWORD=$(value_of MINIO_ROOT_PASSWORD)
BUCKET=$(value_of S3_RECORDINGS_BUCKET)
[ -n "$BUCKET" ] || BUCKET=vip-recordings

[ -f "$SRC/MANIFEST" ] && { echo "▸ backup manifest:"; sed 's/^/    /' "$SRC/MANIFEST" | head -6; }

echo
echo "▸ RESTORE TARGET"
echo "    env file : $ENV_FILE"
echo "    project  : $("$COMPOSE" ps --format '{{.Project}}' 2>/dev/null | head -1)"
echo "    ⚠️ this REPLACES the database and object storage of that deployment."
if [ "${VIP_RESTORE_ASSUME_YES:-}" != "1" ]; then
  printf "    type the word 'restore' to proceed: "
  read -r answer
  [ "$answer" = "restore" ] || { echo "aborted."; exit 1; }
fi

# ── 1. MongoDB ──────────────────────────────────────────────────────────────────────────────────
# `--drop` so the restore is the state of the backup, not the backup merged into whatever was here.
echo "  • mongorestore …"
"$COMPOSE" exec -T mongodb sh -c \
  "mongorestore --quiet --username='$MONGO_USER' --password='$MONGO_PASSWORD' --authenticationDatabase=admin --archive --gzip --drop" \
  < "$SRC/mongo.archive.gz"

# ── 2. Object storage ───────────────────────────────────────────────────────────────────────────
# Unpacked on the host (the `mc` image has no `tar`), then mirrored in from a bind mount.
echo "  • object storage ($BUCKET) …"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
tar -C "$STAGE" -xzf "$SRC/objects.tar.gz"
"$COMPOSE" run --rm --no-deps -T \
  --volume "$STAGE/objects:/in:ro" \
  --entrypoint sh \
  -e MC_HOST_dst="http://$MINIO_USER:$MINIO_PASSWORD@minio:9000" \
  createbuckets -c \
  "mc mb --ignore-existing dst/$BUCKET >/dev/null && mc mirror --overwrite --quiet /in dst/$BUCKET" >/dev/null

# ── 3. Services must re-read what changed under them ────────────────────────────────────────────
# ⚠️ Restarting is not cosmetic: services hold Mongo connections and cached index state, and a
# `--drop` restore removes the collections beneath them.
echo "  • restarting services …"
"$COMPOSE" restart identity tenant camera media events rules workflow notify evidence gateway >/dev/null

echo "▸ restore complete. Verify before declaring success:"
echo "    curl -k https://localhost/ready"
echo "    then log in and confirm incidents, evidence and playback."
