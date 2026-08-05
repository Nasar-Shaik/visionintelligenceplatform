#!/usr/bin/env bash
# Benchmark — warm-up cost, reproducibility, and the capacity ladder that sizes a deployment.
#
# Wraps `docs/review/p8/hardening.mjs` and keeps its raw samples.
#
# ### ⚠️ This does NOT overwrite docs/project/AI_RUNTIME_BENCHMARK.md
#
# The brief asks for a generated benchmark document, and it also says never to modify architecture
# documents automatically. Both are right, and they resolve the same way: the freshly measured
# document is written **into the run** as `benchmark.md`, and promoting it over the committed one is
# an explicit act — `scripts/benchmark.sh --promote`. A permanent reference that a machine can
# silently rewrite at 03:00 is not a reference; the whole value of that page is that a human stood
# behind the numbers on it.
. "${STAGES_DIR:?stage must be run by the engine}/_preamble.sh"

HARDENING="docs/review/p8/hardening.mjs"
[ -f "$HARDENING" ] || {
  bad "missing $HARDENING"
  headline "benchmark script not found"
  finish
}

# Same reason as the soak: it creates cameras and a fixture through the real API.
guard "cd '$REPO' && node $HARDENING clean"

# ⚠️ Into the run, not the tracked tree — see the note in stability.sh.
SAMPLES="$(metrics_path benchmark)"
rm -f "$SAMPLES"

note "capacity ladder, warm-up and reproducibility"
echo ""

OUT="$SAMPLES" node "$HARDENING"
RC=$?

unguard

if [ -f "$SAMPLES" ]; then
  ok "capacity samples captured"
else
  bad "no capacity samples were written — the ladder did not complete"
fi

if [ "$RC" -eq 0 ]; then
  ok "benchmark checks passed"
else
  bad "the benchmark reported failures (exit $RC)"
fi

if [ -f "$SAMPLES" ]; then
  SUMMARY=$(node -e '
    const d = require(process.argv[1]);
    const rows = d.rows || [];
    if (!rows.length) { console.log("no rungs"); process.exit(0); }
    const budget = 2;
    let sustainable = 0;
    for (const r of rows) {
      if (r.dropPercent <= budget && r.failed === 0) sustainable = r.cameras; else break;
    }
    const at = rows.find((r) => r.cameras === sustainable);
    const top = rows[rows.length - 1];
    console.log(
      `sizing ${sustainable} cameras` +
      (at ? ` (p95 ${at.latencyP95Ms.toFixed(0)}ms, ${at.runtimeCpu.toFixed(0)}% CPU)` : "") +
      ` · top rung ${top.cameras} cams ${top.dropPercent.toFixed(1)}% dropped`,
    );
  ' "$SAMPLES" 2>/dev/null)
  headline "${SUMMARY:-completed}"
else
  headline "did not complete"
fi

finish
