# Cross-line, end to end — slice 2.9

`evaluable line zones · side-of-line · transition detection · direction · repeated crossing`

Measured against the deployed stack at `https://localhost`, 2026-08-10. Every number below came from
the built images and real footage. **Nothing was simulated.**

---

## What was actually missing

⭐ **Almost nothing.** `crossings()`, `side_of_line()`, the `lineCross` timeline kind, the `crossed`
graph edge and the `crossed` rule step had all existed and been unit-tested since slice 2.5. What did
not exist was a way for **an operator's line geometry to reach the layer that evaluates it**, so the
whole family had never fired once.

The contract's own note described its own solution:

> *"a side-of-line test carried between frames per subject. Membership is instantaneous; crossing is
> a transition, so it needs the previous frame — state the resolver does not keep."*

Every word true, and the missing state was never missing: **a trajectory is "the previous frame, per
subject"**, and [ADR-0051] made trajectories durable a milestone earlier.

### ⛔ Why the crossing is decided in the behaviour layer, not beside zone membership in media

Media has the geometry and would need one frame of per-subject state. The behaviour layer has the
whole path and needs the geometry for the length of one call. Both work live. **Only the second is
recomputable**: a line drawn today applies to an analysis from last week, and a corrected line
corrects history — the property every other fact in this milestone has (ADR-0054). A crossing
computed once, live, in media would be the only fact that could never be revisited.

So the geometry travels **with the question**: media reads the camera's line zones from the
assignment gate it is already enforcing and passes them on the behaviour read. The runtime stores no
zone geometry, has nothing to invalidate, and nothing to go stale.

```
operator draws a line ─▶ camera service ─▶ assignment plan ─▶ media (gate)
                                                                 │
                          behaviour read ◀── lines travel with the question
                                 │
             track history ─▶ crossings() ─▶ timeline ─▶ graph ─▶ reasoning ─▶ console
```

---

## Measured: propagation

| step | measured |
| --- | ---: |
| line created → in force at the behaviour read | **3.2 s** (once 6.3 s) |
| line disabled → out of force, `lineGeometry` flips to `none` | **6.3 s** |

---

## Measured: a real walk across a real line

`single-person-walking` — a real 30 s recording of one person crossing the frame — through the real
pipeline, with a tripwire at x = 0.5 drawn by an operator.

```
countsByKind   {"lineCross":1,"observed":1}
lineCross      1
  · at 12.0 s   right → left   frame 28
    "…crossed line zn-c82f3068-337 from the right side to the left side at 12 s"

graph          line nodes=1  crossed edges=1   byEdgeKind={"crossed":1}
⭐ one event, not two: timeline frames [28] === graph frames [28]
```

⛔ **The negative control, which is what makes the line above evidence:** the same run read with **no**
geometry reports `lineGeometry: absent`, **zero** crossings, and `countsByKind` identical in every
other kind.

### Direction, on footage that actually contains both

`multiple-people` — two people crossing in **opposite** directions:

```
lineCross      2
  · at 13.5 s   left → right   frame 28
  · at 16.0 s   right → left   frame 33
⭐ timeline frames [28,33] === graph frames [28,33]
```

| rule | candidates |
| --- | ---: |
| crossed this line | **2** |
| crossed **toward left** | **1** |
| crossed **toward right** | **1** |
| crossed twice (repeated) | 0 — correct, each person crossed once |
| crossed a line that does not exist | 0 |
| never crossed | 0 |

⭐ **Entry, exit, wrong direction and repeated crossing are the same primitive, differently
configured** — not four primitives. `toSide` names the direction; two `crossed` steps name a repeat.
⛔ The platform never decides that one side is "entry": that is a claim about a building, and it lives
in the rule an operator writes.

### Live webcam

The live path, with Chromium's fake device fed a **real recording of a person walking**
(`--use-file-for-fake-video-capture`). Everything else is real: `getUserMedia`, the browser encode,
the upload, live ingest, the runtime, the tracker, track history, the read.

```
141 frames accepted · lineGeometry=present · lines=[{"lineId":"…","name":"Live Tripwire"}]
lineCross entries carry the operator's own name: "Live Tripwire"
```

⚠️ Chromium's **built-in** fake device is a rolling colour pattern with no people in it. It can prove
the live path is alive and can never prove a crossing — which is why the file-backed device is used
instead. A crossing in front of a *physical* camera needs a person to walk past one and remains a
manual UAT step.

---

## Three defects, all found by running it

### ⛔ 1. A tripwire drawn 0.05 → 0.95 caught nobody, and the code was right

An operator draws a vertical line that visually spans the frame. A person walks straight through it.
**Zero crossings.** The geometry was correct: a crossing is anchored at the **foot point**, a standing
person's feet sit at **y ≈ 0.95**, and the walk passed *around the bottom end* of the drawn segment.
`segments_intersect` refused it exactly as designed — somebody walking round the end of a line has
not passed through it.

Correct, and completely invisible. Three things changed:

- the console's **Tripwire preset now spans 0 → 1**, with the measurement in the comment;
- the editor tells the operator to reach the frame edges, and why;
- ⭐ **`lineDiagnostics`** publishes `sideChanges`, `crossings` and `missedTheSegment` per line, and
  the Primitive Inspector says *"N subject(s) changed side without passing through it… people are
  walking PAST this line rather than through it — it is very likely drawn too short."*

⚠️ A diagnostic, never an event. A missed side change is **not** reported as a crossing; the fix is to
draw the line correctly, not to lower the bar.

| line | sideChanges | crossings | missedTheSegment |
| --- | ---: | ---: | ---: |
| 0.5, y 0.05 → 0.95 (too short) | 1 | **0** | **1** |
| 0.5, y 0 → 1 (correct) | 1 | **1** | 0 |

### ⛔ 2. `lineId` was on the line NODE and not on the `crossed` EDGE

A rule filters `crossed` by `step.lineId` against `edge.attributes.lineId`, exactly as it filters
`visited` by `edge.attributes.zoneId`. The `visited` edge carried its zone id; the `crossed` edge
carried only `fromSide` and `toSide`.

So **every line-scoped rule matched nothing**, while the `absent` form of the identical step correctly
reported *"1 fact(s) of that kind were examined"* — the fact was there and the filter could not see
it. A rule that silently matches nothing is indistinguishable from a scene where nothing happened.

⚠️ It survived a 315-test evaluator suite because those fixtures are **hand-built graphs**, which
carried the attribute the producer was not writing. `perception-boundary.mjs` **§J** now asserts that
every edge attribute the evaluator filters on is one the graph writes — checked across the two
languages, which is the only place it is visible.

### ⚠️ 3. A chain read "crossed line zn-c82f… — zn-c82f… line:zn-c82f… at 16 s"

The id three times in one sentence, and the operator's own name for the line nowhere. The timeline now
carries `lineName`, the graph labels the node with it, and a WHY chain names a place by name and a
subject by id — because an identity's label is a *class* ("person") and the id is the informative half.

---

## Negative controls

| control | result |
| --- | --- |
| the same run, no geometry supplied | `lineGeometry: absent`, 0 crossings, every other kind identical |
| a camera with no line zones | `lineGeometry: none` — "nobody crossed" is a *complete* answer |
| malformed geometry on the read | `lineGeometry: invalid` — ⛔ **never** folded into `absent` |
| a rule naming a line that does not exist | 0 candidates |
| a rule naming the **opposite** direction | 0 candidates |
| `never crossed` against a run that did | 0 candidates |
| a line drawn too short | 0 crossings **and** a diagnostic saying why |

⛔ **Four states, not three.** `present` · `none` · `absent` · `invalid` all render downstream as "no
crossings". Three of them are fine; one means the platform is quietly broken, and it stays broken for
as long as nobody is told.

---

## Recorded limitations

⚠️ **`none` is only reachable for a camera this media process is enforcing.** A camera the assignment
gate does not hold answers `absent` — media cannot honestly say "this camera has no line zones" for a
camera it is not responsible for.

⚠️ **The timeline and the graph read with different entry ceilings** — 2 000 and 20 000. On a busy
camera the graph legitimately holds facts the timeline did not return: measured on the live camera,
**434 crossings in `countsByKind`, 216 in a capped `entries`, 434 in the graph**. `countsByKind`
describes the run; `entries.length` describes the response. Comparing the two lengths on a busy camera
would report a correct platform as duplicating events.

⚠️ **A crossing on a physical camera is a manual step.** The automated live verification substitutes
the lens, not the pipeline.

⚠️ **`path` and `direction` remain reserved and not evaluable.** `line` was promoted by an evaluator
being written, not by a flag being flipped, and the contract test still refuses to let the other two
be promoted without one.

[ADR-0051]: ../adr/ADR-0051-track-history-becomes-durable.md
