#!/usr/bin/env sh
# Full backup of a running VIP deployment (P-5.8).
#
#   infra/docker/backup.sh [destination-dir]        # default: ./backups/<UTC timestamp>
#
# Produces three artefacts, because a deployment has three independent states and restoring any two
# of them leaves an unusable system:
#
#   mongo.archive.gz   the operational database — incidents, evidence manifests, custody, rules,
#                      users, cameras, audit history
#   objects.tar.gz     object storage — the recordings and evidence bytes themselves
#   config.env         the environment file
#
# ⚠️ **config.env is the one you cannot regenerate.** `CREDENTIAL_ENCRYPTION_KEY` derives the key
# that encrypts camera credentials at rest; restore the database without it and every stored
# credential is permanently unreadable. It contains live secrets, so this script writes it 0600 and
# says so — treat the backup directory with the same care as the deployment itself.
#
# ⚠️ The database dump is taken with `--oplog`-free `mongodump` against a single node. That is
# consistent per-collection, not point-in-time across collections. For a deployment that cannot
# tolerate that, run against a replica set and add `--oplog`; recorded as TD-38 rather than implied.
#
# Restore with: infra/docker/restore.sh <backup-dir>
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/infra/docker/prod.sh"
ENV_FILE="${VIP_ENV_FILE:-$ROOT/.env.production}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="${1:-$ROOT/backups/$STAMP}"
mkdir -p "$DEST"

# Read what we need from the env file without exporting the whole thing into this shell.
value_of() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
MONGO_USER=$(value_of MONGO_USER)
MONGO_PASSWORD=$(value_of MONGO_PASSWORD)
MINIO_USER=$(value_of MINIO_ROOT_USER)
MINIO_PASSWORD=$(value_of MINIO_ROOT_PASSWORD)
BUCKET=$(value_of S3_RECORDINGS_BUCKET)
[ -n "$BUCKET" ] || BUCKET=vip-recordings

echo "▸ backing up to $DEST"

# ── 1. MongoDB ──────────────────────────────────────────────────────────────────────────────────
echo "  • mongodump …"
"$COMPOSE" exec -T mongodb sh -c \
  "mongodump --quiet --username='$MONGO_USER' --password='$MONGO_PASSWORD' --authenticationDatabase=admin --archive --gzip" \
  > "$DEST/mongo.archive.gz"

# ── 2. Object storage ───────────────────────────────────────────────────────────────────────────
# ⚠️ Copied through `mc` rather than by tarring MinIO's data directory. A raw volume copy captures
# MinIO's own on-disk format and its internal state, which only restores into an identical MinIO
# version; an object-level mirror restores into any S3-compatible target.
#
# ⚠️ Mirrored into a bind-mounted directory, not piped through `tar` in the container: the
# `minio/mc` image ships no `tar` (found the direct way — the first version of this script failed
# with `tar: command not found`). The archive is built on the host, where tar certainly exists.
echo "  • object storage ($BUCKET) …"
mkdir -p "$DEST/objects"
"$COMPOSE" run --rm --no-deps -T \
  --volume "$DEST/objects:/out" \
  --entrypoint sh \
  -e MC_HOST_src="http://$MINIO_USER:$MINIO_PASSWORD@minio:9000" \
  createbuckets -c "mc mirror --quiet --overwrite src/$BUCKET /out" >/dev/null
tar -C "$DEST" -czf "$DEST/objects.tar.gz" objects
rm -rf "$DEST/objects"

# ── 3. Configuration ────────────────────────────────────────────────────────────────────────────
echo "  • configuration (secrets — 0600) …"
cp "$ENV_FILE" "$DEST/config.env"
chmod 600 "$DEST/config.env"

# ── manifest, so a restore can tell what it is looking at ───────────────────────────────────────
{
  echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname)"
  echo "bucket=$BUCKET"
  echo "mongo_bytes=$(wc -c < "$DEST/mongo.archive.gz" | tr -d ' ')"
  echo "objects_bytes=$(wc -c < "$DEST/objects.tar.gz" | tr -d ' ')"
  echo "images=$("$COMPOSE" images --format json 2>/dev/null | head -c 2000 | tr '\n' ' ')"
} > "$DEST/MANIFEST"

echo "▸ done:"
ls -lh "$DEST" | tail -n +2 | awk '{printf "    %-20s %s\n", $9, $5}'
echo
echo "  ⚠️ config.env holds live secrets, including the credential-encryption key that cannot be"
echo "     regenerated. Store this directory as securely as the deployment itself."
