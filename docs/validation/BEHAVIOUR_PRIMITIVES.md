# Behaviour primitives that need only tracked identities — slice 2.5

`idle · linger · follow · queue · approach · recede · group_merge · group_split · cross_line`
(plus `enter_zone` / `exit_zone`, which already existed)

Measured on the deployed stack, 2026-08-09. Companion to the P-11 soak reports; the raw numbers
below were produced by the built image, not by a test fixture.

---

## What was verified, and how

⛔ **Every one of these primitives can legitimately produce nothing**, so "no output" is never
evidence. Each family below is therefore reported with the data that *could* have produced it.

| Primitive | Fired on deployed data | Evidence |
| --- | :---: | --- |
| `idle` | ✅ 1 126 | across 2 029 analyses in the durable store |
| `linger` | ✅ 1 126 | same |
| `group_merge` | ✅ 298 | same |
| `group_split` | ✅ 298 | same |
| `queue` | ✅ 228 | same |
| `approach` | ✅ 223 | same |
| `recede` | ✅ 223 | same |
| `follow` | ✅ | one 6.5 s episode on the live camera's 789 records |
| `enter_zone` / `exit_zone` | ✅ 9 425 / 4 786 | pre-existing, unchanged |
| `cross_line` | ⛔ **never** | no line zone can exist in this platform — see below |

The scan ran **inside `vip-prod-inference-1`**, against `/var/lib/vip/track-history`, using the
image's own `behaviour_timeline`. It is the deployed code reading deployed data.

## ⛔ `cross_line` is implemented, tested, and cannot fire

`packages/contracts/src/zones/zone.ts` marks the `line` shape **storable but not evaluable**, and the
camera service refuses to create one. So there is no line geometry anywhere in the platform, and
`CrossingModule` correctly emits nothing rather than an empty crossing list — the read publishes
`lineGeometry: "absent"`, which is a different answer from *"nobody crossed a line"*.

⭐ **The contract predicted exactly what was missing.** `ZONE_EVALUATION` records the requirement
verbatim: *"a side-of-line test carried between frames per subject. Membership is instantaneous;
crossing is a transition, so it needs the previous frame — state the resolver does not keep."* The
resolver does not keep it; **a trajectory is it**. That is why crossing belongs in this layer and
membership belongs in media, and it is why the primitive is written and unit-tested now.

Making it fire needs, in one slice: flip `evaluable` for `line`, have `zone-resolver.ts` stamp each
subject's **side** of each line (instantaneous and stateless — exactly what it can do), carry it on
the channel `zoneIds` already uses, and let the behaviour layer detect the flip across frames. No new
service, no new configuration channel, no geometry in the runtime.

## ⚠️ Every word carries the number that produced it

`bp.PRIMITIVE_READINGS` is the only place a business word is attached to a threshold, and the table
is published on `/api/behaviour/primitives` and on every timeline entry as `attributes.reading`:

```
linger  → stationary_episodes, radius 0.08 frame widths, ≥ 15 s
idle    → stationary_episodes, radius 0.02 frame widths, ≥ 3 s
queue   → stationary_groups,   radius 0.08, together within 0.15, ≥ 8 s, ≥ 2 subjects
follow  → following,           within 0.30, headings agree ±45°, ≥ 3 s
```

⚠️ **These are conventions, not measurements.** Nobody has established that 15 seconds is when
standing becomes lingering. They are published so a reader of an incident can see the threshold that
produced it, and tunable because they are judgements.

⭐ `idle` and `linger` are two *readings of one mechanism*, not two implementations — an `idle()`
function beside a `linger()` function would be one geometry written twice, and the day they diverged
both would still return plausible seconds. An `idle` episode nests **inside** a `linger` episode;
summing across the two names adds one event to itself.

---

## ⛔ The defect this slice shipped, and the measurement that found it

The four new pairwise families each walked every pair while recomputing, *inside that walk*, work
that belongs to one identity. **Every unit test passed throughout** — they each author two or three
identities, where n² is 4 and nothing is slow.

| Analysis | Behaviour API read, before | after |
| --- | ---: | ---: |
| 98 identities × 120 frames | 9 689 ms | **543 ms** |
| 98 identities × 512 frames | **43 333 ms** | **2 662 ms** |

`_local_heading` was called **541 440** times where 11 760 would do. The fix is `bp.Scene`: prepare
each identity once, memoise each pair's distance series once, and prune pairs that never shared an
instant. `tools/validation/behaviour-bench` → `ai/inference/behaviour_benchmark.py` is the guard, and
`PreparationTests` in `tests/test_behaviour_primitives.py` counts operations rather than seconds so
the shape cannot regress on a shared runner.

⭐ **The timeline had never applied the cap the modules had applied since slice 2.2.** That asymmetry
was the whole defect. Both now report it, and `TimelineResult` separates the two ways an answer can
be incomplete:

- `truncated` — more facts existed than `max_entries`; the tail was cut, and it looks short.
- `relational_truncated` — more than 32 subjects were in the scene, so the pairwise families only
  considered the first 32. ⛔ **The dangerous one**: the timeline looks complete and simply has no
  merge in it.

Measured on the deployed stack, real reads: one analysis **103 ms**, the live camera's 794 records
**271 ms** with the relational cap correctly engaged (32 of 46 subjects, reported).

---

## Limitations of this result

- **`follow` was seen once**, on synthetic soak frames. Two people genuinely walking a corridor would
  exercise the case its docstring warns about — an aisle makes every pair look like a follow.
- **No footage in this platform contains anyone standing still on purpose**, so `idle` and `linger`
  fired on synthetic movement rather than on a person choosing to wait.
- **`cross_line` has never executed outside a unit test.**
- ⚠️ **The timeline's entry cap hides interesting facts behind `gap`.** On the live camera's 789
  records, 1 207 of the first 2 000 entries are `gap`, and the `follow` episode the primitives read
  reports is cut. The truncation is declared, so nothing is silently wrong — but a console rendering
  this needs to filter by kind rather than take the first 2 000.
- **One host, one tenant, one corpus.**

## Reproducing

```bash
node tools/validation/behaviour.mjs --clip .soak-real.mp4 --fps 2 --out behaviour.json
cd ai/inference && python3 -B behaviour_benchmark.py
cd ai/inference && python3 -B -m unittest discover -s tests -p 'test_behaviour*.py'
```
