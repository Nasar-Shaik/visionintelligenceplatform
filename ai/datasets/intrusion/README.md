# `intrusion/` — Intrusion

> **Maturity:** Beta · see [CAPABILITY_MATURITY](../../../docs/architecture/future/CAPABILITY_MATURITY.md).
> Maturity changes only through `maturity.promote()` with named evidence — never by editing a table.

## What this scenario is

A subject entering an area they should not be in. Perception only — 'after hours' is a rule, not a detection.

## What the runtime produces today

`BehaviorResult` of type `intrusion` plus `security.intrusion.detected` events.

Event types: `security.intrusion.detected`.

## The honest gap

The boundary between intrusion and restricted-area entry is a policy distinction; the runtime emits the same primitive for both.

## Layout

```
intrusion/
├── cases/      DatasetCase manifests (committed — these are the assertions)
└── footage/    the clips themselves (DVC-tracked; NEVER committed)
```

## Adding a case

1. Put the clip in `footage/` and track it with DVC (`dvc add ai/datasets/intrusion/footage/<clip>.mp4`).
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
python ai/inference/evaluate_cli.py --category intrusion          # this scenario
python ai/inference/evaluate_cli.py --coverage                # what the whole corpus covers
```

Cases whose footage is not present on this machine report `footage-missing` — never a pass.
