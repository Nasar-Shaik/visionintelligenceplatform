# Hardware Recommendation Guide

> **Status:** governance · **Owner:** Principal Architect + Claude · _2026-08-01_ · **AI-5e**
> Commissioned at AI-5e authorization (Architect recommendation 2): _"Recommend deployment hardware
> based on camera count, expected FPS, AI workload, deployment profile. This will simplify customer
> sizing enormously."_
>
> **Every number in this document is an ESTIMATE.** It is derived from the runtime's own cost model,
> not from a measurement on the hardware named. Companion docs:
> [PRODUCTION_KPIS](PRODUCTION_KPIS.md) · [PRODUCTION_COMPATIBILITY](PRODUCTION_COMPATIBILITY.md) ·
> [CAPABILITY_MATURITY](CAPABILITY_MATURITY.md)

---

## 1. Read this first

Sizing today is answered by whoever has the most confident opinion. Every wrong answer costs either a
returned mini-PC or a customer whose system drops frames at 6pm on a Saturday. This guide replaces the
opinion with arithmetic — **and is explicit that arithmetic is not measurement**.

The generator is `ai/inference/sizing.py`, which reuses `ComputeRegistry.unit_cost()` — the _same_
function admission control uses to decide whether a session can be admitted. There is deliberately no
second set of numbers to drift out of step.

```bash
python ai/inference/certify_cli.py --sizing retail-store                # the table
python ai/inference/certify_cli.py --sizing retail-store --cameras 24   # one answer + rationale
```

**Every row below says `estimate`.** Supply a `BenchmarkReport` measured on the target class and the
same tool reports `measured` and names the report as its `basis`. Until one exists, do not quote these
numbers to a customer as a measurement.

## 2. Reference deployment classes

| class         | hardware                            | capacity (units) | accelerator | CPU / RAM   | when                                                                          |
| ------------- | ----------------------------------- | ---------------: | ----------- | ----------- | ----------------------------------------------------------------------------- |
| `edge-device` | Jetson Orin Nano or equivalent SoC  |              8.0 | CUDA        | 6c / 8 GB   | Fanless, DIN-mountable. The only class that survives a retail ceiling void.   |
| `mini-pc-i5`  | Mini PC / Intel NUC (i5, no dGPU)   |              8.0 | CPU         | 8c / 16 GB  | The single-site default. Sub-stream analysis is **essential** here.           |
| `rtx-desktop` | Tower or industrial PC + NVIDIA GPU |             64.0 | CUDA        | 16c / 32 GB | Multi-site or high camera count; the only class that scales past ~24 cameras. |
| `dev-laptop`  | Developer laptop                    |              6.0 | CPU         | 8c / 16 GB  | Engineering and demonstration only — **never a deployment target**.           |

Capacity is in the runtime's **abstract, dimensionless units** (AI-5c). Not cores, not VRAM, not
TFLOPs — because the only thing the scheduler needs is a consistent currency in which a session's cost
and a device's capability can be compared.

## 3. Retail store — tracking, loitering, queue @ 5 fps

| cameras | recommended class | required | available | headroom | fits | basis    |
| ------: | ----------------- | -------: | --------: | -------: | ---- | -------- |
|       4 | `edge-device`     |     1.15 |       8.0 |     86 % | yes  | estimate |
|       8 | `edge-device`     |     2.30 |       8.0 |     71 % | yes  | estimate |
|      16 | `edge-device`     |     4.60 |       8.0 |     42 % | yes  | estimate |
|      24 | `rtx-desktop`     |     6.90 |      64.0 |     89 % | yes  | estimate |
|      32 | `rtx-desktop`     |     9.20 |      64.0 |     86 % | yes  | estimate |
|      48 | `rtx-desktop`     |    13.80 |      64.0 |     78 % | yes  | estimate |
|      64 | `rtx-desktop`     |    18.40 |      64.0 |     71 % | yes  | estimate |

## 4. Factory floor — tracking, intrusion, PPE, crowd @ 5 fps

| cameras | recommended class | required | available | headroom | fits | basis    |
| ------: | ----------------- | -------: | --------: | -------: | ---- | -------- |
|       4 | `edge-device`     |     1.31 |       8.0 |     84 % | yes  | estimate |
|       8 | `edge-device`     |     2.62 |       8.0 |     67 % | yes  | estimate |
|      16 | `edge-device`     |     5.24 |       8.0 |     34 % | yes  | estimate |
|      24 | `rtx-desktop`     |     7.86 |      64.0 |     88 % | yes  | estimate |
|      32 | `rtx-desktop`     |    10.48 |      64.0 |     84 % | yes  | estimate |
|      48 | `rtx-desktop`     |    15.72 |      64.0 |     75 % | yes  | estimate |
|      64 | `rtx-desktop`     |    20.96 |      64.0 |     67 % | yes  | estimate |

## 5. Why the tables jump from edge to tower

An `edge-device` is CUDA and a `mini-pc-i5` is CPU-only, and inference on an accelerator costs roughly
a quarter of what it costs on a CPU. So a Jetson genuinely out-sizes a CPU-only NUC despite having the
same nominal capacity, and at 24 cameras neither fits — the next class up is the tower.

**If a customer will not accept a fanless SoC**, constrain the recommendation:

```bash
python -c "
import sys; sys.path.insert(0,'ai/inference')
from sizing import SizingRequest, recommend
print(recommend(SizingRequest(profile='retail-store', cameras=8,
                              allowed_classes=['mini-pc-i5','rtx-desktop']))['rationale'])"
```

## 6. The rules behind the numbers

**30% headroom is required, not preferred.** A box sized to 100% of its capacity has no room for the
reconnect storm after a site power cut, when every camera comes back at once and the system is at its
least able to cope. A class that fits only at 95% is reported **infeasible**, not as a tight fit.

**Smallest-that-fits, not largest-available.** Over-specifying is a real cost to a customer buying
forty sites, and a class fitting with 45% headroom is a better answer than one with 80%.

**Behaviour analysis is not free.** The workload multiplier is first-order and conservative — tracking
+5%, crowd +8%, fall detection +15%, violence +20%. An **unrecognised** analyzer costs the generic
composite rate rather than nothing: an unrecognised analyzer is still an analyzer, and sizing it at
zero is the error that produces an under-specified box.

**Frame rate is linear.** Twice the frames is twice the work. This is the honest first-order model and
the cheapest lever a deployment has: dropping 10 fps to 5 halves the compute bill.

**Sub-stream analysis is assumed.** Every figure above assumes the runtime analyzes a ~640×360
sub-stream, which is what deployment profiles configure and what ONVIF discovery selects. Analyzing a
4K main stream instead invalidates the entire table.

## 7. Turning estimates into measurements

```bash
# 1. benchmark the actual box
python ai/inference/benchmark_cli.py --deployment mini-pc-i5 --suite --output bench-out

# 2. size against what it achieved, not what it was asked for
python -c "
import json, sys; sys.path.insert(0,'ai/inference')
from sizing import SizingRequest, recommend, render_table
b = json.load(open('bench-out/benchmark-1.json'))
print(render_table([recommend(SizingRequest(profile='retail-store', cameras=n), benchmark=b)
                    for n in (4,8,16,24,32)]))"
```

A box that sustained 3 fps of a requested 5 costs 5/3 as much per camera, and the tool applies that.
Ignoring it is how a site gets sized on a benchmark it never actually met.

## 8. What this guide cannot tell you

- **Thermals.** Whether a NUC throttles at hour 14 of a 24-hour soak in a ceiling void in July is not
  a compute-capacity question, and no amount of arithmetic answers it. That is what
  [the soak framework](../../tracker/AI-5e-CERTIFICATION.md) is for.
- **Storage and network.** Recording is the DVR/NVR's job; the platform analyses. But an NVR re-stream
  concentrates every camera's bandwidth through one device, and that is a deployment decision.
- **Model cost.** Every figure assumes the current stub-shaped workload. A real detector — YOLO,
  RT-DETR — has its own cost, and the tables must be regenerated from a benchmark that used it.

**None of the hardware named here is certified.** See
[PRODUCTION_COMPATIBILITY §3](PRODUCTION_COMPATIBILITY.md) and the
[compatibility registry](../../../ai/inference/profiles/cameras/), where every device is
`Pending Validation`.
