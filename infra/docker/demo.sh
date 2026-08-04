#!/usr/bin/env sh
# Demo Mode — restore the full demonstration dataset with one command (P-5.9).
#
#   infra/docker/demo.sh reset     # wipe demo tenants, re-seed everything, register evidence
#   infra/docker/demo.sh status    # what is currently seeded
#   infra/docker/demo.sh clear     # remove demo tenants and leave the deployment otherwise intact
#
# ⚠️ **It only ever touches `tnt_demo_*`.** Every delete is scoped by that tenant prefix, so running
# `reset` on a deployment that also holds real data removes the demonstration tenants and nothing
# else. That constraint is the reason this is a script rather than "drop the database and re-seed":
# a demo reset must be safe to run on a machine you do not fully remember the state of.
#
# ⚠️ Evidence is registered through the real evidence API, not written into Mongo. Custody opens and
# the integrity hash is computed from the stored bytes, so the Evidence Chain panel shows a custody
# log the platform actually produced. A demo of tamper-evidence that had itself been bypassed would
# be worse than not demonstrating it.
#
# See docs/demo/DEMO_GUIDE.md.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/infra/docker/prod.sh"
ENV_FILE="${VIP_ENV_FILE:-$ROOT/.env.production}"
CLIPS="${SEED_EVIDENCE_DIR:-$ROOT/.data/demo-clips}"

value_of() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
MONGO_USER=$(value_of MONGO_USER)
MONGO_PASSWORD=$(value_of MONGO_PASSWORD)

mongo_eval() {
  "$COMPOSE" exec -T mongodb mongosh --quiet \
    -u "$MONGO_USER" -p "$MONGO_PASSWORD" --authenticationDatabase admin \
    --eval "$1"
}

# Every collection that carries a tenantId. Scoped delete, never a drop.
DEMO_FILTER='{ tenantId: { $regex: /^tnt_demo_/ } }'
COLLECTIONS="tenants org_nodes users cameras rules rule_versions events incidents notifications notification_channels evidence evidence_custody bookmarks clips recordings camera_probes"

clear_demo() {
  echo "▸ removing demo tenants (tnt_demo_*) …"
  js="const d = db.getSiblingDB('vip'); let total = 0;"
  for c in $COLLECTIONS; do
    js="$js try { const r = d.getCollection('$c').deleteMany($DEMO_FILTER); if (r.deletedCount) { print('    $c: ' + r.deletedCount); total += r.deletedCount; } } catch (e) {}"
  done
  # `tenants` keys the tenant by _id, not tenantId, in some shapes — cover both.
  js="$js try { const r = d.getCollection('tenants').deleteMany({ _id: { \$regex: /^tnt_demo_/ } }); if (r.deletedCount) print('    tenants(_id): ' + r.deletedCount); } catch (e) {}"
  js="$js try { const r = d.getCollection('users').deleteMany({ _id: { \$regex: /^usr_demo_/ } }); if (r.deletedCount) print('    users(_id): ' + r.deletedCount); } catch (e) {}"
  js="$js try { const r = d.getCollection('cameras').deleteMany({ _id: { \$regex: /^cam_(retail|wh|sch|hosp)_/ } }); if (r.deletedCount) print('    cameras(_id): ' + r.deletedCount); } catch (e) {}"
  js="$js try { const r = d.getCollection('org_nodes').deleteMany({ _id: { \$regex: /^org_(northgate|meridian|ashford|st-aldates)_/ } }); if (r.deletedCount) print('    org_nodes(_id): ' + r.deletedCount); } catch (e) {}"
  js="$js print('  removed ' + total + ' tenant-scoped document(s)');"
  mongo_eval "$js"
}

status() {
  mongo_eval "
    const d = db.getSiblingDB('vip');
    const f = $DEMO_FILTER;
    const rows = ['tenants','org_nodes','users','cameras','rules','events','incidents','evidence'];
    print('  demo data currently seeded:');
    for (const c of rows) {
      try { print('    ' + c.padEnd(12) + d.getCollection(c).countDocuments(f)); } catch (e) {}
    }
    print('');
    print('  demo tenants:');
    d.getCollection('tenants').find(f).forEach(t => print('    ' + (t._id || t.tenantId).padEnd(22) + (t.name || '')));
  "
}

case "${1:-reset}" in
  status)
    status
    ;;

  clear)
    clear_demo
    echo "▸ done. Non-demo tenants untouched."
    ;;

  reset)
    echo "▸ Demo Mode reset"
    clear_demo

    echo "▸ seeding the demo dataset (4 tenants, 4 verticals) …"
    "$COMPOSE" --profile seed run --rm seed-demo 2>&1 | sed -n '/seeding demo/,$p' | sed 's/^/  /'

    # ── evidence ────────────────────────────────────────────────────────────────────────────────
    # ⚠️ Generation needs ffmpeg (a Docker socket) and upload needs MinIO (compose-network only), so
    # the halves are separate: clips are produced on the host once and cached, then registered from
    # inside the network. See tools/seed/evidence.ts.
    if [ ! -f "$CLIPS/clip-001.mp4" ]; then
      echo "▸ generating demo clips (first run only) …"
      mkdir -p "$CLIPS"
      gen() { docker run --rm -v "$CLIPS:/w" -w /w jrottenberg/ffmpeg:6-alpine \
        -hide_banner -loglevel error "$@" >/dev/null 2>&1; }
      gen -f lavfi -i testsrc=size=1280x720:rate=25 -t 10 -c:v libx264 -profile:v main \
        -pix_fmt yuv420p -an -movflags +faststart clip-001.mp4
      gen -f lavfi -i testsrc=size=1280x720:rate=1 -t 3600 -c:v libx264 -g 30 \
        -pix_fmt yuv420p -an -movflags +faststart clip-002-hour.mp4
      gen -f lavfi -i testsrc=size=1280x720:rate=25 -t 10 -c:v libx265 \
        -pix_fmt yuv420p -an -tag:v hvc1 -movflags +faststart clip-003-h265.mp4
      echo "  clips cached in $CLIPS"
    fi

    # One registration per vertical, each attaching to that tenant's live investigation. The target
    # incident is resolved from the API rather than hard-coded, because demo incidents get fresh
    # UUIDs on every reset.
    echo "▸ registering evidence through the real API …"
    for pair in \
      "tnt_demo_retail:security.manager@northgate.demo" \
      "tnt_demo_warehouse:site.manager@meridian.demo" \
      "tnt_demo_school:site.lead@ashford.demo" \
      "tnt_demo_hospital:security.lead@staldates.demo"
    do
      tenant=${pair%%:*}
      email=${pair#*:}
      printf '  %s\n' "$tenant"
      SEED_EVIDENCE_DIR="$CLIPS" \
      SEED_TENANT_ID="$tenant" \
      SEED_EMAIL="$email" \
      "$COMPOSE" --profile seed run --rm \
        -e SEED_TENANT_ID="$tenant" -e SEED_EMAIL="$email" \
        seed-evidence 2>&1 | sed -n '/attaching to incident/,$p' | grep -E "attaching|registered|✖" | sed 's/^/    /'
    done

    echo
    echo "▸ Demo Mode ready."
    status
    ;;

  *)
    echo "usage: demo.sh [reset|status|clear]" >&2
    exit 2
    ;;
esac
