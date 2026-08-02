# Rule engine — scale baseline

**Recorded:** 2026-08-03 (P-4.1, Architect rec 13) · **Harness:** `services/rules/bench/rule-scale.bench.ts`
**Run it:** `pnpm --filter @vip/service-rules bench` (`--json` for the machine-readable form)

---

## ⚠️ What these numbers are

A **baseline for comparison on the machine that produced them.** Nothing more.

They are not thresholds, not a capacity model, and not transferable to another machine. A millisecond
figure from a laptop says nothing about a production node, and quoting one as though it did is how a
benchmark stops being useful and starts being misleading.

What _is_ transferable is the **shape**: cost per rule should stay flat as the rule count grows. That is
the property a regression breaks, it is measured as a ratio rather than a duration, and it is what
[`services/rules/test/scale.test.ts`](../../services/rules/test/scale.test.ts) asserts on every run.

Same discipline as the P-3 close-out recommendation on benchmark documentation, and the same reason
[FOUNDATION_PRINCIPLES §3](../project/FOUNDATION_PRINCIPLES.md) exists: a measurement is only evidence
of what it actually measured.

---

## Reference run

**Apple M1 Pro · Node v26.5.0 · 20,000 events per scale · in-process, no I/O**

| Rules | Compile (ms) | Event p50 (µs) | Event p95 (µs) | **Per rule (ns)** | Cache hit | Heap (MB) |
| ----- | ------------ | -------------- | -------------- | ----------------- | --------- | --------- |
| 100   | 0.44         | 8.2            | 12.7           | **81.7**          | 100.00%   | 1.6       |
| 500   | 0.43         | 42.1           | 49.5           | **84.2**          | 100.00%   | 0.8       |
| 1,000 | 0.71         | 81.6           | 96.4           | **81.6**          | 100.00%   | -4.3      |
| 5,000 | 2.46         | 428.2          | 586.0          | **85.6**          | 100.00%   | -6.6      |

### Reading it

- **Per-rule cost is flat** — 81.7 ns at 100 rules, 85.6 ns at 5,000. Fifty times the rules costs fifty
  times as much, which is the only claim being made here. A quadratic regression would show as roughly
  50× per-rule cost at the top of the table and would fail the gate long before anyone read this file.
- **Compilation is linear and cheap.** 5,000 rules compile in ~2.5 ms, so the warm-up an authoring
  write triggers (rec 5) is invisible to the person who clicked save.
- **The cache is 100% after the first event**, which is what "zero per-event queries" looks like from
  the outside: 20,000 events, one store call.
- **Heap deltas are noise** and go negative because the GC runs during the measurement. They are
  reported for completeness, not because a number this unstable means anything; run with `--expose-gc`
  if a real figure is ever needed.

### What the workload is

Not 5,000 copies of one rule — that would measure the branch predictor. Every fourth rule is scoped to
a zone (so most events miss its scope, the common shape in a large estate), every third has a nested
condition, and every other one pre-filters on event type. Events land in a covered zone one time in ten.
The mix is fixed in the harness, so two runs are comparable.

---

## Related

- [ADR-0027](../adr/ADR-0027-rule-operations-diagnostics-and-portability.md) — the operations slice this
  measures.
- [ADR-0026](../adr/ADR-0026-rule-scope-validation-and-explainability.md) — the compiled rule set that
  makes the numbers look like this.
- [PRODUCTION_KPIS](future/PRODUCTION_KPIS.md) — the AI runtime's equivalent baseline (AI-5a).
