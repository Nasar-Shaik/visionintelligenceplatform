# `shoplifting/` — Shoplifting

> **Maturity:** Experimental · see [CAPABILITY_MATURITY](../../../docs/architecture/future/CAPABILITY_MATURITY.md).
> Maturity changes only through `maturity.promote()` with named evidence — never by editing a table.

## What this scenario is

Concealment behaviour: an item leaving a shelf and not reaching a basket, prolonged dwell with body-blocking, exit without a till transaction.

## What the runtime produces today

A `CompositeBehavior` composed from dwell, zone transitions and counting — configured, not coded.

Event types: `behavior.theft.suspected`.

## The honest gap

This is a composition of weak signals and will produce false positives. Negative cases (ordinary browsing that must NOT alert) matter more here than positive ones.

## Layout

```
shoplifting/
├── cases/      DatasetCase manifests (committed — these are the assertions)
└── footage/    the clips themselves (DVC-tracked; NEVER committed)
```

## Adding a case

1. Put the clip in `footage/` and track it with DVC (`dvc add ai/datasets/shoplifting/footage/<clip>.mp4`).
2. Write `cases/<slug>.json` — see [the library README](../README.md#a-dataset-case) for the shape.
3. Record the **licence or consent basis**. A clip of real people with no recorded basis is not usable,
   and the manifest will refuse to load without one.
4. Write the expectations from what a **human** sees in the clip, before running the platform over it.
   Expectations derived from the current output are not a test; they are a snapshot of today's bugs.
5. Include at least one **negative** expectation (`"absent": true`). In surveillance analytics a false
   positive costs more than a miss, because an operator paged four times a night for nothing stops
   reading the alerts entirely — and then the misses stop mattering too.

## Running

```bash
python ai/inference/evaluate_cli.py --category shoplifting          # this scenario
python ai/inference/evaluate_cli.py --coverage                # what the whole corpus covers
```

Cases whose footage is not present on this machine report `footage-missing` — never a pass.
