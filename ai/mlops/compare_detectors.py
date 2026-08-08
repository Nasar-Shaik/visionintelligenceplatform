"""Run every registered detector over the **same frames, through the real runtime code** (P-10 A2).

    python compare_detectors.py --frames /frames --models /opt/vip/models --out /out/comparison.json

⭐ **Nothing here re-implements the pipeline.** It calls `model_formats.preprocess` and the decoder
that `get_decoder()` returns for each catalogue entry — the same two functions the ONNX adapter calls
in production. If this script and the runtime could disagree, the comparison would be measuring the
script.

⚠️ **Runs inside the deployed image**, because that is where onnxruntime and numpy live. A
comparison run on a developer's laptop with a different BLAS would produce latency numbers that
describe the laptop.

### What is compared, and what deliberately is not

Latency, throughput, memory and **detection agreement on identical input** are measured here.
Precision and recall are **not**: that needs the annotated corpus specified in DATASET_STRATEGY.md,
and quoting an accuracy number from unlabelled frames — however plausible it looks — is the exact
failure this project keeps finding in its own instruments.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import time
from typing import Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "inference"))

from adapters import model_formats  # noqa: E402
from model_store import ModelStore  # noqa: E402


def peak_rss_mib() -> float:
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # Linux reports KiB, macOS bytes. The image is Linux; the fallback keeps a local run honest.
    return usage / 1024.0 if sys.platform.startswith("linux") else usage / (1024.0 * 1024.0)


def percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(p * len(ordered))) - 1))
    return ordered[index]


def run_model(model, frames: List[bytes], artifact_dir: str, warmup: int) -> Dict[str, object]:
    import numpy as np  # noqa: PLC0415
    import onnxruntime as ort  # noqa: PLC0415

    path = os.path.join(artifact_dir, model.artifact)
    if not os.path.isfile(path):
        return {"modelId": model.id, "status": "artifact-missing", "path": path}

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    load_started = time.perf_counter()
    session = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - load_started) * 1000.0
    input_name = session.get_inputs()[0].name

    decoder = model_formats.get_decoder(model.output_format)
    params = dict(model.output_params or {})

    preprocess_ms: List[float] = []
    infer_ms: List[float] = []
    decode_ms: List[float] = []
    per_frame_person: List[int] = []
    per_frame_total: List[int] = []
    person_boxes: List[List[List[float]]] = []
    top_scores: List[float] = []

    for index, image in enumerate(frames):
        t0 = time.perf_counter()
        tensor, geometry = model_formats.preprocess(image, model.input)
        t1 = time.perf_counter()
        outputs = session.run(None, {input_name: tensor})
        t2 = time.perf_counter()
        detections = decoder(outputs, model.input, geometry, params)
        t3 = time.perf_counter()

        if index >= warmup:
            preprocess_ms.append((t1 - t0) * 1000.0)
            infer_ms.append((t2 - t1) * 1000.0)
            decode_ms.append((t3 - t2) * 1000.0)

        confident = [d for d in detections if d.score >= 0.30]
        people = [d for d in confident if d.class_id == 0]
        per_frame_person.append(len(people))
        per_frame_total.append(len(confident))
        person_boxes.append([list(d.bbox) for d in people])
        if people:
            top_scores.append(max(d.score for d in people))

    total_ms = [p + i + d for p, i, d in zip(preprocess_ms, infer_ms, decode_ms)]
    measured = max(1, len(total_ms))
    return {
        "modelId": model.id,
        "family": model.family,
        "outputFormat": model.output_format,
        "license": model.license,
        "status": "measured",
        "inputSize": [model.input.width, model.input.height],
        "resize": model.input.resize,
        "artifactBytes": os.path.getsize(path),
        "loadMs": round(load_ms, 1),
        "framesMeasured": measured,
        "preprocessMsAvg": round(sum(preprocess_ms) / measured, 2),
        "inferenceMsAvg": round(sum(infer_ms) / measured, 2),
        "inferenceMsP95": round(percentile(infer_ms, 0.95), 2),
        "decodeMsAvg": round(sum(decode_ms) / measured, 2),
        "totalMsAvg": round(sum(total_ms) / measured, 2),
        "fpsSingleStream": round(1000.0 / max(0.001, sum(total_ms) / measured), 2),
        "peakRssMiB": round(peak_rss_mib(), 1),
        "personDetections": sum(per_frame_person),
        "totalDetections": sum(per_frame_total),
        "framesWithAPerson": sum(1 for n in per_frame_person if n > 0),
        "framesAnalysed": len(per_frame_person),
        "personPerFrame": round(sum(per_frame_person) / max(1, len(per_frame_person)), 3),
        "topPersonScoreAvg": round(sum(top_scores) / len(top_scores), 4) if top_scores else None,
        "perFramePersonCounts": per_frame_person,
        "personBoxes": person_boxes,
    }


def _iou(a: List[float], b: List[float]) -> float:
    """IoU over two `[x, y, w, h]` boxes in the same normalized space."""
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    overlap = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = a[2] * a[3] + b[2] * b[3] - overlap
    return overlap / union if union > 0 else 0.0


def localisation_agreement(a: Dict[str, object], b: Dict[str, object]) -> Dict[str, object]:
    """⭐ **Do the two detectors put the boxes in the same place?**

    Counting agreement is weak evidence: a decoder with a broken coordinate transform still returns
    the right *number* of boxes, and "35 of 40 frames agree" reads as a verified decoder. Two
    independently trained models agreeing on *where* a person is cannot happen by accident — it is
    the strongest available check on `to_source_bbox` short of a labelled corpus, and it is one no
    single-model test can perform.
    """
    ious: List[float] = []
    matched = 0
    considered = 0
    for boxes_a, boxes_b in zip(a["personBoxes"], b["personBoxes"]):  # type: ignore[index]
        for box in boxes_a:
            if not boxes_b:
                continue
            considered += 1
            best = max(_iou(box, other) for other in boxes_b)
            ious.append(best)
            if best >= 0.5:
                matched += 1
    return {
        "boxesCompared": considered,
        "matchedAtIou50": matched,
        "matchRate": round(matched / considered, 3) if considered else None,
        "meanBestIou": round(sum(ious) / len(ious), 3) if ious else None,
        "medianBestIou": round(percentile(ious, 0.5), 3) if ious else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare every registered detector on identical frames.")
    parser.add_argument("--frames", required=True)
    parser.add_argument("--models", default="/opt/vip/models")
    parser.add_argument("--catalogue", default=None)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--out", default="/out/comparison.json")
    args = parser.parse_args()

    catalogue = args.catalogue or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "inference", "models", "registry.json"
    )
    store = ModelStore.load(catalogue, artifact_dir=args.models)

    names = sorted(f for f in os.listdir(args.frames) if f.lower().endswith((".jpg", ".jpeg", ".png")))
    names = names[: args.limit]
    frames = [open(os.path.join(args.frames, n), "rb").read() for n in names]
    print(f"{len(frames)} frame(s) from {args.frames}")

    results = []
    for model in store.all():
        print(f"\n── {model.id} ({model.output_format}) ──")
        result = run_model(model, frames, args.models, args.warmup)
        if result["status"] != "measured":
            print(f"  ⚠️ {result['status']}: {result.get('path')}")
        else:
            print(
                f"  inference {result['inferenceMsAvg']} ms avg · total {result['totalMsAvg']} ms · "
                f"{result['fpsSingleStream']} fps · people {result['personDetections']} "
                f"over {result['framesAnalysed']} frames"
            )
        results.append(result)

    measured = [r for r in results if r["status"] == "measured"]
    agreement = None
    if len(measured) >= 2:
        # ⭐ The same frames through both detectors: how often do they agree on how many people?
        a, b = measured[0], measured[1]
        pairs = list(zip(a["perFramePersonCounts"], b["perFramePersonCounts"]))
        agreement = {
            "a": a["modelId"],
            "b": b["modelId"],
            "framesCompared": len(pairs),
            "exactAgreement": sum(1 for x, y in pairs if x == y),
            "withinOne": sum(1 for x, y in pairs if abs(x - y) <= 1),
            "aHigher": sum(1 for x, y in pairs if x > y),
            "bHigher": sum(1 for x, y in pairs if y > x),
            "localisation": localisation_agreement(a, b),
        }
        print(
            f"\nagreement {agreement['a']} vs {agreement['b']}: "
            f"{agreement['exactAgreement']}/{agreement['framesCompared']} frames agree on count · "
            f"localisation mean IoU {agreement['localisation']['meanBestIou']} · "
            f"{agreement['localisation']['matchRate']} matched at IoU≥0.5"
        )

    # ⚠️ Per-frame box lists are evidence for the agreement figure, not a data lake; they would
    # dominate the artefact and nothing downstream reads them.
    for result in results:
        result.pop("personBoxes", None)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "frames": len(frames),
                "frameSource": args.frames,
                "warmupFrames": args.warmup,
                "confidenceFloorForCounts": 0.30,
                "results": results,
                "agreement": agreement,
            },
            handle,
            indent=2,
        )
    print(f"\nwritten to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
