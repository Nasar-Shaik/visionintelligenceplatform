#!/bin/sh
# Watch a running soak and emit one line per thing worth acting on.
#
# ⛔ **Coverage, not just good news.** A watcher that greps only for findings is silent through a
# crashed harness, and silence looks exactly like a healthy soak. So this emits on three things:
# every finding, a periodic heartbeat carrying the numbers a drift would show up in, and — the one
# that matters — the harness process disappearing.
#
#   sh tools/validation/soak-watch.sh [.soak] [heartbeat-every-n-minutes]
set -u
OUT="${1:-.soak}"
EVERY="${2:-15}"

seen=0
tick=0

while true; do
  # ── findings ────────────────────────────────────────────────────────────────────
  if [ -f "$OUT/events.jsonl" ]; then
    n=$(grep -c '"level":"finding"\|"level":"fatal"' "$OUT/events.jsonl" 2>/dev/null || echo 0)
    if [ "$n" -gt "$seen" ]; then
      grep '"level":"finding"\|"level":"fatal"' "$OUT/events.jsonl" 2>/dev/null | tail -n $((n - seen))
      seen=$n
    fi
  fi

  # ── the harness itself ──────────────────────────────────────────────────────────
  if ! pgrep -f 'validation/soak.mjs' >/dev/null 2>&1; then
    cycles=$(grep -c cycle-complete "$OUT/ops.jsonl" 2>/dev/null || echo 0)
    echo "SOAK ENDED after ${cycles} cycles — $(tail -n 1 "$OUT/soak.log" 2>/dev/null)"
    exit 0
  fi

  # ── heartbeat ───────────────────────────────────────────────────────────────────
  tick=$((tick + 1))
  if [ $((tick % EVERY)) -eq 0 ]; then
    cycles=$(grep -c cycle-complete "$OUT/ops.jsonl" 2>/dev/null || echo 0)
    fails=$(grep -c '"ok":false' "$OUT/ops.jsonl" 2>/dev/null || echo 0)
    last=$(tail -n 1 "$OUT/metrics.jsonl" 2>/dev/null)
    echo "HEARTBEAT cycles=${cycles} findings=${seen} failed-ops=${fails} $(
      printf '%s' "$last" | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
          try {
            const m = JSON.parse(s);
            const mem = Object.entries(m.containers ?? {})
              .sort((a, b) => b[1].memMb - a[1].memMb).slice(0, 3)
              .map(([k, v]) => `${k}:${v.memMb}MB`).join(" ");
            const pend = (m.jetstream?.streams ?? []).reduce((a, x) => Math.max(a, x.maxPending ?? 0), 0);
            const fds = Object.entries(m.fds ?? {}).map(([k, v]) => `${k}:${v}`).join(",");
            process.stdout.write(
              `elapsed=${m.elapsedMin}min disk=${m.disk?.availGb}GB api=${m.api?.ms}ms ` +
              `fps=${m.runtime?.fps} p95=${m.runtime?.latencyP95Ms} q=${m.runtime?.queueDepth} ` +
              `pending=${pend} fds=${fds} top-mem=${mem}`,
            );
          } catch { process.stdout.write("(no metrics sample yet)"); }
        });
      ' 2>/dev/null
    )"
  fi

  sleep 60
done
