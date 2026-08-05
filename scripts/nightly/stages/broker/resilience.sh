#!/usr/bin/env bash
# The broker goes away and comes back — and recording must not notice.
#
# ⚠️ **This stage STOPS NATS on the running deployment.** Every service on the platform shares that
# broker, so for the duration of the outage window the whole stack is degraded on purpose. The
# underlying script restarts it in a `finally` and the guard below repeats that if the stage is
# killed; nothing else in the night may assume a broker while this is running, which is why it is
# ordered after the functional stages and before nothing.
#
# ⚠️ The assertion that matters is not that events survive — they are explicitly allowed not to.
# It is that SEGMENTS keep being written while they do not. Events are the thing that may be lost;
# recording is evidence.
#
# It also covers the half of Camera Processing Assignment that already exists: a camera that stops
# offering frames and starts again must resume publishing. It did not, once — the ordering gate held
# a stale sequence and stranded the camera silently — which is a milestone-ahead defect this stage
# now guards.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

SCRIPT="docs/review/p8/event-bridge-resilience.mjs"
[ -f "$SCRIPT" ] || { bad "missing $SCRIPT"; headline "broker resilience script not found"; finish; }

node docs/review/p8/tracking-fixtures.mjs >/dev/null || {
  bad "could not build the motion fixtures"
  headline "fixtures unavailable"
  finish
}

# ⚠️ Starting the broker comes FIRST in the undo. A killed run that left NATS stopped takes every
# later stage with it, and "the night failed" would be attributed to whatever ran next.
guard "docker start vip-prod-nats-1; cd '$REPO' && node $SCRIPT clean"

SAMPLES="$(metrics_path broker-resilience)"
rm -f "$SAMPLES"
warn "this stage stops the broker on the running deployment and restarts it"
OUT="$SAMPLES" node "$SCRIPT"
RC=$?
unguard

if [ "$RC" -eq 0 ]; then
  ok "the bridge survived a broker outage and a camera being switched off — recording never stopped"
else
  bad "broker resilience verification failed (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const h = d.samples?.healthy ?? {};
    const o = d.samples?.outage ?? {};
    const r = d.samples?.recovered ?? {};
    console.log(
      `outage: broker ${o.brokerStatus ?? "?"}, ${o.failed ?? "?"} failed, queue ${o.queueDepth ?? "?"}/${o.queuePerCamera ?? "?"}, ` +
      `segments ${h.segments ?? "?"}→${o.segments ?? "?"} · recovered ${r.brokerStatus ?? "?"} unaided`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
