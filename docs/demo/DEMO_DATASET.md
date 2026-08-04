# Demo Dataset Guide

What `infra/docker/demo.sh reset` creates, why each piece is shaped the way it is, and how to
change it.

```
4 tenants · 28 locations · 33 cameras · 13 operators · 13 rules · 126 events · 18 incidents · 12 evidence records
```

Source: [`tools/seed/demo.ts`](../../tools/seed/demo.ts).

---

## 1 · Commands

```sh
infra/docker/demo.sh reset     # wipe demo tenants, re-seed, register evidence  (~2 min)
infra/docker/demo.sh status    # counts + tenant list
infra/docker/demo.sh clear     # remove demo tenants, leave everything else
```

In development: `pnpm seed:demo` (dataset only — evidence needs the services running).

> ⚠️ **Scoped to `tnt_demo_*`.** Every delete is filtered by that prefix, so a reset on a deployment
> that also holds real tenants removes only the demonstration ones. That is why this is a script and
> not "drop the database": a demo reset has to be safe on a machine whose state you do not fully
> remember.

---

## 2 · The four tenants

| Tenant               | Organisation           | Locations | Cameras | Incidents | Story                                                      |
| -------------------- | ---------------------- | --------- | ------- | --------- | ---------------------------------------------------------- |
| `tnt_demo_retail`    | Northgate Retail Group | 7         | 9       | 6         | Theft, loitering, after-hours stock room, checkout queues  |
| `tnt_demo_warehouse` | Meridian Logistics     | 7         | 10      | 5         | Perimeter intrusion, PPE violations, unauthorised vehicles |
| `tnt_demo_school`    | Ashford Academy Trust  | 7         | 7       | 3         | Chemical store, plant room, out-of-hours grounds           |
| `tnt_demo_hospital`  | St Aldate's Hospital   | 7         | 7       | 4         | Patient falls, ED aggression, controlled-drugs store       |

Names are deliberately fictional and tenant ids are prefixed `tnt_demo_`, because a dataset that
looks like a real customer's estate is one screenshot away from being mistaken for one.

---

## 3 · Design decisions, and why

### Incidents span the whole lifecycle

Not all six retail incidents are `raised`. The set covers `raised`, `acknowledged`, `investigating`,
`escalated`, `resolved` and `closed`, each with a lifecycle history whose transitions are
consistent with the status. A demo where everything is new never shows what resolution looks like,
and a queue of six identical rows shows nothing about the product.

### Not every camera is healthy

Four of the 33 are `degraded` or `offline`. An estate where every camera is green is not one any
customer recognises, and it hides the operational-truth work the platform did in P-2 — the trolley
bay camera being offline, and the console saying so, is a feature.

### Operator notes read like an investigator wrote them

> _"Reviewed the clip from 14:32. Subject removes two boxed items from the cabinet and moves out of
> frame toward the checkout lanes."_
>
> _"Checkout footage for the same window shows no corresponding transaction. Escalating to the duty
> manager."_

Lorem ipsum in a comments panel tells a prospect the feature is unfinished. Real investigative
prose shows what the panel is _for_.

### Every timestamp is relative to now

The most recent incident is minutes old, every time you reset. A demonstration whose newest incident
is three weeks old invites "is this thing actually running?".

### The dataset is deterministic

Pseudo-randomness is seeded per tenant, so a reset reproduces the same estate. A screenshot taken
today matches the demo given next week, and a UI review is comparable between runs.

---

## 4 · What it deliberately does NOT fabricate

This is the part that matters most.

| Not fabricated                 | Why                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Evidence bytes and custody** | Registered through the **real evidence API**, so custody opens and the integrity hash is computed from stored bytes. A hand-written evidence row would show the Evidence Chain panel a custody log the platform never produced — a demonstration of tamper-evidence that had itself been bypassed |
| **AI output**                  | No incident carries an AI summary, because nothing analysed them. AI is advisory, and must never appear to have done work it did not do                                                                                                                                                           |
| **Camera probe history**       | Cameras are seeded with a health status, not with invented latency, jitter and frame-rate measurements. Those are _measured_ values; inventing them would be inventing evidence                                                                                                                   |
| **Vendor behaviour**           | No clip claims to be from a Hikvision or Dahua device. See [CCTV_READINESS.md](../review/p59/CCTV_READINESS.md)                                                                                                                                                                                   |

### The recordings

Three ffmpeg clips, generated once and cached in `.data/demo-clips/`:

| File                | Codec              | Duration | Purpose                                                          |
| ------------------- | ------------------ | -------- | ---------------------------------------------------------------- |
| `clip-001.mp4`      | H.264 Main, `avc1` | 10 s     | Plays everywhere                                                 |
| `clip-002-hour.mp4` | H.264, 1 fps       | 1 hour   | A real span to scrub and zoom                                    |
| `clip-003-h265.mp4` | H.265, `hvc1`      | 10 s     | Demonstrates the honest "this browser has no HEVC decoder" state |

Genuine H.264/H.265 in genuine MP4 containers — the player decodes them with the same code path it
uses for a camera recording. **They are not CCTV**, and the seed says so every time it runs.

---

## 5 · Changing it

Everything is data at the top of [`tools/seed/demo.ts`](../../tools/seed/demo.ts): `RETAIL`,
`WAREHOUSE`, `SCHOOL`, `HOSPITAL`. Each declares zones, cameras, operators, rules and incidents.

To add a vertical, add a `Vertical` object and put it in `VERTICALS`. To retitle an incident, edit
its `title`. Then `infra/docker/demo.sh reset`.

Constraints the shape must respect:

- **`dedupKey` on every event.** The `events` collection has a unique `(tenantId, dedupKey)` index;
  rows without one collide. The helper mirrors the real normalizer's format so demo rows are
  indistinguishable in shape from pipeline-produced ones.
- **Event types must exist in the catalog** (`packages/contracts/src/events/catalog.ts`).
- **Every incident needs `triggeredBy.eventId`** pointing at an event that exists.
- **A camera's `zoneId` must reference a seeded `org_node`.**

---

## 6 · Using it for a UI review

The dataset exists as much for design review as for demos. One row tells you nothing about spacing,
truncation, density or sort order. P-5.9 found three defects that were invisible against the
single-camera dev seed:

- The incident queue and dashboard rendered **raw camera ids** (`cam_retail_electronics2`) in the
  column headed CAMERA. With only `cam_dev_1` seeded, an id that short reads like a name.
- Workspace panel titles **clipped mid-word with no ellipsis** on a 1024×768 tablet.
- The tablet layout hid **nine panels** while leaving 280 px of vertical space empty.

None of these was a logic error, and none would have been found by a test.
