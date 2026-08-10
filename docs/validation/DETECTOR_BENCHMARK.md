# Detector benchmark — observational report

**2026-08-10T19:05:40Z** · corpus `detector-corpus-2026-08-10`

> ⛔ **THIS REPORT DOES NOT NAME A WINNER, AND CANNOT.**
> 
> 0 of 31 required scenarios are covered by real footage. Every case in this corpus is authored or photographic, so these numbers describe how each detector handles *this corpus* — not how it handles people. See `CORPUS_COVERAGE.md`.
> 
> ⛔ **Every metric below is OBSERVATIONAL, not an accuracy metric.** No case carries ground truth, so precision, recall, false-positive/negative rates, IoU and mAP are absent rather than estimated. A detection count is not an accuracy: more detections per frame may mean finding people or finding coat racks, and nothing here separates the two.

## Model provenance

| Model | Version | Licence | Artifact | sha256 | Input | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `yolox-nano` | 1.0.0 | Apache-2.0 | yolox-nano-1.0.0.onnx | `c789161ed43c…` | 416×416 letterbox | enabled |
| `rtdetr-r18vd` | 1.0.0 | Apache-2.0 | rtdetr-r18vd-1.0.0.onnx | `80d3c1f1ab46…` | 640×640 stretch | disabled |

⚠️ The checksum is the identity of the measurement. Two artifacts under one model id produce different numbers, and only this column distinguishes them.

⚠️ **`gitSha 4227ed7` is the _parent_ commit.** This run was made from the P3.1 working tree before
P3.1 was committed, so the recorded sha names the tree it was built on rather than the source that
produced it. Any rerun on the committed tree records the P3.1 commit itself. ⛔ The sha is captured
because the image has no work tree of its own and would otherwise record `unknown`.

### ⚠️ What the first run of this report got wrong

The first 34-cell matrix published a path in the `sha256` column, an empty latency column beside a
populated FPS column, and `Tracks`/`Reassign` at zero for every cell — four wrong attribute or key
names, each degrading to a plausible default rather than raising. The numbers below come from the
repaired instrument. `Reassign` remains 0 and is **not a measurement**; see the note under the table.

# Benchmark Summary

**2026-08-10T19:05:40Z** · corpus `detector-corpus-2026-08-10`

> **Environment.** at `2026-08-10T18:50:33Z` · cpuCount `10` · gitSha `4227ed7` · hostContended `False` · inContainer `True` · machine `aarch64` · onnxruntime `1.19.2` · platform `Linux-6.12.76-linuxkit-aarch64-with-glibc2.41` · providers `AzureExecutionProvider,CPUExecutionProvider` · python `3.12.13` · targetFps `2.0` · warmupFrames `3`

Compared over **17** case(s) every detector completed.

| Detector | Cases | Frames | Det/frame | Tracks | Reassign | Events | Inference avg ms | p95 | FPS | RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `rtdetr-r18vd` | 17 | 962 | 1.702 | 46 | 0 | 1624 | 763.761 | 1041.619 | 1.191 | 475.124 |
| `yolox-nano` | 17 | 962 | 1.504 | 44 | 0 | 1469 | 45.1 | 74.055 | 13.662 | 167.741 |

## What this table does not say

⛔ **Precision and recall are absent.** They require per-frame ground truth; a detection count is not an accuracy. A detector with more detections per frame may be finding people or may be finding coat racks, and nothing here distinguishes them.

⛔ **`Reassign` is structurally zero and is not a measurement.** It was described as counting how often a tracker-assigned `trackingId` changed within one `identityId`; the runtime publishes no such counter, and cannot — a trackId is never reused, because re-entry is modelled as a link rather than a reassignment, and track diagnostics carry no `identityId` at this tier. Read the column as *not measured*, never as *no ID switches occurred*: measuring ID switches needs the annotated footage the corpus does not have.

⚠️ **Incidents are absent by architecture.** The runtime emits events and creates no incidents; incident counts come from the deployed platform tier.
