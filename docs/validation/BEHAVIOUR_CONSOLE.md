# The investigation behaviour console — slice 2.8

`behaviour timeline · graph viewer · identity history · primitive inspector · reasoning chain`

Measured against the deployed stack at `https://localhost`, 2026-08-10. Every number below came from
the built images, not from a test fixture.

---

## What was built

Five surfaces on the investigation page, reading **four endpoints of one computation**. The timeline,
graph and primitives are three shapes of a single pass over track history (`behaviour_graph.py` is
built from `timeline_for`'s entries and nothing else); the fourth read is that history itself, which
is the only source of per-frame position.

⭐ **The console derives no behaviour fact.** Its entire arithmetic is placing a fact in the video
(`footage.ts`) and tallying facts it was handed (`identity.ts`). A console that computed a dwell of
its own would eventually disagree with the runtime about one, and nothing on the page could say which
was right.

| Surface | What it shows | Read |
| --- | --- | --- |
| Timeline | every primitive in footage order, expandable, each seeking the video | `GET /api/behaviour/timeline` |
| Graph | identity · zone · object · group · line nodes; relations bundled with counts | `GET /api/behaviour/graph` |
| Identity | trajectory, zones, tracks, detector confidence, behaviour summary, incidents | `GET /api/track-history` |
| Primitives | every primitive with its **mechanism, thresholds and meaning** | `GET /api/behaviour/primitives` |
| Reasoning | a composed rule, its candidates, and the WHY chain link by link | `POST /api/rules/rules/behaviour/evaluate` |

---

## Four defects found by running it, not by reasoning about it

### ⛔ 1. `streamId` was accepted at every layer and applied at none

Declared on media's route, forwarded to the runtime, named in the runtime's own docstring, honoured
by `TrackHistoryStore.records` — and the runtime's handler called that method without it.

| read | before | after |
| --- | ---: | ---: |
| `GET /api/track-history?streamId=ases_26cd…` | **5 014 records · 73 366 579 bytes** | **2 records · 30 340 bytes** |

Every one of those 5 014 records was a real movement path, and none of them was about the run that
was asked for. Nothing failed. This is precisely the run independence [ADR-0047] promises and that
`bt.collect` has always honoured — the one reader that did not was the route.

`tests/test_track_history_routes.py` drives the **route** rather than the store, because the store's
filter has been correct since slice 2.2 and wiring is only visible from outside.

### ⛔ 2. "Membership undecided" is encoded as an ABSENT field, not a false boolean

`HistoryPoint.to_dict` omits `zoneIds` entirely when membership was never decided and emits `[]` when
something decided the answer was "inside none". There is no `zonesSettled` on the wire. The first
version of the console's `zonesOf` looked for that boolean, found `undefined`, and would have reported
**every observation as undecided on a deployment where zones work perfectly** — a confident wrong
number, which is worse than none.

### ⛔ 3. Two parameterised primitives were published as "not parameterised"

The Primitive Inspector renders a threshold beside the word it explains. `proximity` and `gap` had no
entry in `PRIMITIVE_READINGS`, so the panel said *"not parameterised"* — a claim that no threshold
decided the finding, which is the opposite of the truth for both:

- `proximity` — within **0.15** of the frame width for at least **2 s**, debounced.
- `gap` — no observation for more than **2.5×** the run's own sampling interval. ⚠️ A factor rather
  than an absolute, because an analysis at 2 fps and one at 8 fps call very different silences a gap.

Now guarded three ways: an import-time assertion that the published `thresholdNormalized` equals
`GROUP_THRESHOLD`, a Python test that every kind is either mapped to a reading or *declared*
unparameterised, and `perception-boundary.mjs` **§I**.

### ⛔ 4. A capped timeline could not be un-capped by filtering

On a live camera **1 207 of the 2 000 entries the runtime's cap allows were `gap`** — so every merge,
queue and crossing later in the run had already been cut before the browser saw anything, and the list
looked complete. Filtering what arrived would hide the noise and recover none of the loss.

`?kinds=` now narrows **in the runtime, before the cap**, and `countsByKind` is counted over the whole
run either way. Measured on the deployment:

```
countsByKind  {"approach":1,"gap":1,"groupMerge":1,"groupSplit":1,"observed":2,"proximity":1,"recede":1}
?kinds=approach  →  1 entry · kindsRequested=["approach"] · excludedByKind=7 · countsByKind unchanged
?kinds=loitering →  0 entries · kindsRequested=["loitering"] · excludedByKind=8
```

⚠️ The last line is the negative control: a kind nobody produces returns nothing **and says what was
asked**, so a mistyped filter is distinguishable from a quiet run.

---

## The clock join, which is the correctness core of the whole surface

Three clocks meet on this page and two look identical on screen:

| value | zero point |
| --- | --- |
| `entry.atSeconds` | the run's **first observation** |
| `entry.footageSeconds` | the **epoch**, on the footage clock |
| `video.currentTime` | the **first frame** of the file |

`atSeconds` is the readable one and it is *not* a video position — a run whose first person appears
eight seconds in reports that moment as `0.0 s`. Seeking to it lands eight seconds early, on a frame
where the thing being explained has not happened, presented with exactly the confidence of a correct
seek.

⛔ **A fact that cannot be placed disables the button and says so** (ADR-0039). `footage.ts` decides
the basis against the recording's own duration rather than guessing, and reports `unplaceable` rather
than a best guess.

Measured on a real analysis: `footageStartedAt=2026-08-09T10:43:08.896Z`, duration 30 s,
**8 of 8 facts placeable, 0 unplaceable**, `groupMerge` at `atSeconds=12.5` → recording offset
`12.5 s`. The browser test asserts the resulting `video.currentTime`, not the intent.

---

## Performance, measured through the edge

Five reads each, `https://localhost`, one analysis (2 identities, 8 facts, 4 nodes, 7 edges):

| read | min | median | max |
| --- | ---: | ---: | ---: |
| `behaviour/timeline` | 90 | 95 | 113 |
| `behaviour/timeline?kinds=` | 94 | 95 | 103 |
| `behaviour/graph` | 92 | 95 | 101 |
| `behaviour/primitives` | 91 | 93 | 94 |
| `track-history?streamId=&identityId=` | — | 160–176 | — |

⚠️ **Each read is a full recompute** — nothing here is stored (ADR-0054) — so the panel fetches the
graph and primitives **only when their tab is open**. Three reads on mount would make opening the page
cost all three, and the largest graph measured in slice 2.6 took **563 ms for 62 identities**.

Browser: 8 behaviour specs pass in **59.3 s** on Chromium against the real edge; the 13 pre-existing
`surface.spec.ts` tests still pass in 2.0 min, so the added panel costs the page nothing measurable.

---

## Negative controls

| control | result |
| --- | --- |
| anonymous read of any behaviour view | **HTTP 401** |
| unknown run (`streamId=ases_does_not_exist`) | HTTP 200, `entries: []`, **query echoed** |
| mistyped kind (`kinds=loitering`) | 0 entries, `kindsRequested` echoed, `excludedByKind > 0` |
| a run that has not finished | the surface says why, rather than rendering empty |
| runtime keeps no history (`enabled: false`) | stated as an alert, never as "nothing happened" |
| cross-tenant `x-tenant-id` header on a behaviour view | ignored; the token's tenant is used |

---

## What this surface refuses to do

⛔ **No confidence is attached to a primitive.** A primitive is a geometric measurement against a
published threshold: it met the threshold or it did not. The platform has no probability for
"lingered", and a number beside that word would be read as a likelihood by every person who saw it.
What *is* shown is the **detector's** confidence for the observation a fact was evidenced by, labelled
as such, in the identity panel where the observation is.

⛔ **A match is a candidate, never an incident.** The requested reading was *"incident ↓ WHY ↓ …"*;
what the platform can honestly render is *"candidate ↓ WHY ↓ …"*. Nothing on this surface creates an
incident, and the word is not used for something that is not one. A browser test asserts the card's
text contains no incident vocabulary.

⛔ **Confidence on a candidate is a coverage measure**, printed as "evidence coverage" with the
sentence *"not a probability that the label is true"* beside it.

⛔ **Incidents are attributed by the recorded link, never by the clock.** incident →
`triggeredByEventId` → timeline entry → `trackId` → the identity's `trackIds`. Matching on time is
right every time on a recording with one person, which is exactly what makes it dangerous; an incident
whose link cannot be resolved is **counted as unattributable** rather than pinned on whoever was in
shot.

⛔ **A truncated answer is never drawn as a complete one.** Three independent incompleteness signals
are surfaced separately — entries capped, scene capped, kinds filtered — because a capped *entry list*
is obviously short while a capped *scene* returns a complete-looking timeline in which nothing social
ever happened.

---

## Recorded limitations

⚠️ **`GET /api/track-history` with no filter returns the whole tenant: 73 MB, measured.** The console
never issues it (the hook requires an identity), and the route is `track:read`-scoped, but an
authenticated operator can move 73 MB through the edge in one request. Recorded rather than fixed
here: capping an existing endpoint's payload changes its semantics and deserves its own slice with its
own verification.

⚠️ **This deployment has `zoneMembership: absent` and `lineGeometry: absent`**, so the zone and
crossing surfaces render their honest "the family was inert" banners and could not be verified against
real zone data. `lineGeometry` is slice 2.9's subject.

⚠️ **Behaviour rules travel in the request body.** There is no behaviour-rule store — slice 2.7's
stated boundary — so the console composes a rule and sends it. Nothing on screen can be mistaken for a
configured rule set, because the operator had to write it.

---

## Two harness fixes, both diagnosed rather than shrugged at

Two long-standing "flakes" were machine-load measurements reported as product defects:

1. `@vip/service-tenant` — `moves a 10,000-node subtree` ran in ~2 s alone and **6.2 s** under the
   eleven-package gate, failing vitest's 5 s default. It is a correctness test at scale and carries no
   performance budget; it now declares a 30 s timeout with the reason.
2. `@vip/console` — `findBy*` inherited testing-library's 1 s default, which a React Query round trip
   through MSW can exceed under gate load. Raised to 5 s, with `testTimeout: 20 s` **strictly greater**
   so the useful "unable to find an element" failure is reachable instead of an opaque "Test timed
   out" — a distinction found immediately after making the first change.

Neither weakens an assertion. A timeout is the longest a test waits before failing, not how long it
takes to pass.

[ADR-0047]: ../adr/ADR-0047-an-analysis-run-is-part-of-an-events-identity.md
