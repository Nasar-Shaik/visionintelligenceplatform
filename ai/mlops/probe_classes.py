"""What does the deployed detector actually score, per class, on real pixels?

    python3 ai/mlops/probe_classes.py --images DIR [--model yolox-nano] [--floor 0.02] [--out JSON]

⛔ **This tool exists because an absence had four possible causes and nobody could tell them apart.**

`AssociationModule` had run on every frame since slice 2.2 without ever seeing an object. The stored
explanation was "no footage contains one". That was one of four candidates, and it was wrong:

| candidate | how to tell |
| --- | --- |
| no footage contains a carriable object | look at real photographs that plainly do |
| the object is too few pixels at CCTV scale | re-probe the same photograph larger, and cropped |
| the model cannot do these classes | drop the floor and see whether any score exists at all |
| **the floor discards them** | **compare the scores against the floor** ← this was it |

Measured 2026-08-10: `yolox-nano` scores a real `handbag` at **0.4672** and a real `backpack` at
**0.2811**, against a deployed `minConfidence` of **0.50** chosen for `person` (0.73–0.94). The
capability was not missing. It was switched off by one number, and reported exactly like a scene
where nobody had ever carried anything.

⭐ **It calls the same two functions the ONNX adapter calls** — `model_formats.preprocess()` and
whatever `get_decoder()` returns — so it cannot disagree with production about what the model saw.
The only thing it changes is the floor, which is the variable under test.

⚠️ Run it inside the inference image, where the weights and onnxruntime live:

    docker cp ai/mlops/probe_classes.py vip-prod-inference-1:/tmp/probe_classes.py
    docker cp CORPUS/. vip-prod-inference-1:/tmp/corpus/
    docker exec vip-prod-inference-1 python3 /tmp/probe_classes.py --images /tmp/corpus

⛔ **It reports scores. It never reports a verdict about the platform.** A class that scores nothing
here is a finding about the model on this corpus, and the corpus is chosen by whoever runs it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# ⚠️ Two homes, because this runs in both: from a checkout it sits beside `ai/inference`, and inside
# the deployed image it is copied to /tmp while the runtime lives at /app. Guessing one would make
# the tool work in exactly the place where the weights are not.
for _candidate in (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "inference"),
    os.environ.get("VIP_RUNTIME_DIR", "/app"),
):
    if os.path.isfile(os.path.join(_candidate, "model_store.py")):
        sys.path.insert(0, _candidate)
        break

from adapters import model_formats  # noqa: E402
from model_store import ModelStore  # noqa: E402

#: The classes association is *for*. ⚠️ Every one is a thing a person carries: a `chair` detects well
#: and is never picked up, so it would prove the detector and nothing about the primitive.
CARRIABLE = ("backpack", "handbag", "suitcase", "bottle", "cup", "wine glass", "laptop", "book", "cell phone")


def probe(model, store: ModelStore, images: list[str], floor: float) -> list[dict]:
    import onnxruntime as ort  # noqa: PLC0415

    session = ort.InferenceSession(store.artifact_path(model), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    decoder = model_formats.get_decoder(model.output_format)
    params = dict(model.output_params or {})
    labels = list(model.labels)

    rows: list[dict] = []
    for path in images:
        with open(path, "rb") as fh:
            image = fh.read()
        tensor, geometry = model_formats.preprocess(image, model.input)
        detections = decoder(session.run(None, {input_name: tensor}), model.input, geometry, params)

        # ⚠️ Best score per class, not a count. The question is "can this model see a handbag at
        # all", and one confident detection answers it where twenty weak ones do not.
        best: dict[str, float] = {}
        for detection in detections:
            label = labels[detection.class_id] if 0 <= detection.class_id < len(labels) else str(detection.class_id)
            score = float(detection.score)
            if score >= floor and score > best.get(label, 0.0):
                best[label] = round(score, 4)
        rows.append(
            {
                "file": os.path.basename(path),
                "best": dict(sorted(best.items(), key=lambda kv: -kv[1])),
                "carriable": {k: v for k, v in sorted(best.items()) if k in CARRIABLE},
                "person": best.get("person"),
                "rawDetections": len(detections),
            }
        )
    return rows


def summarise(rows: list[dict], floors: dict[str, float], default_floor: float) -> dict:
    """Per class: how strongly it scored, and what the deployed floor would have done with it.

    ⭐ `admitted` vs `seen` is the whole report. A class seen 10 times and admitted 0 times is a
    capability the deployment has switched off, and it is indistinguishable — from every read, on
    every screen — from a class that was never there.
    """
    out: dict[str, dict] = {}
    for label in CARRIABLE + ("person",):
        scores = [row["best"][label] for row in rows if label in row["best"]]
        floor = floors.get(label, default_floor)
        out[label] = {
            "seen": len(scores),
            "max": max(scores) if scores else None,
            "floor": floor,
            "admitted": sum(1 for s in scores if s >= floor),
            "scores": sorted(scores, reverse=True)[:10],
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Per-class detector scores on a real-image corpus.")
    parser.add_argument("--images", required=True, help="directory of .jpg/.png files")
    parser.add_argument("--model", default="yolox-nano")
    parser.add_argument("--catalogue", default="/app/models/registry.json")
    parser.add_argument("--artifacts", default="/opt/vip/models")
    parser.add_argument("--manifest", default="/app/manifests/perception.person-detection.json")
    parser.add_argument(
        "--floor",
        type=float,
        default=0.02,
        help="report scores at or above this. ⚠️ Deliberately far below any deployed floor: the "
        "question is what the model produced, not what the deployment kept.",
    )
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    store = ModelStore.load(args.catalogue, artifact_dir=args.artifacts)
    model = store.get(args.model)
    if model is None:
        print(f"no such model in the catalogue: {args.model}", file=sys.stderr)
        return 2

    images = sorted(
        os.path.join(args.images, name)
        for name in os.listdir(args.images)
        if name.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    if not images:
        print(f"no images in {args.images}", file=sys.stderr)
        return 2

    # ⚠️ The floors the *deployment* would apply, read from the manifest the runtime loads rather
    # than restated here. A tool carrying its own copy of the thresholds would eventually report on
    # a configuration nobody was running.
    deployed_floors: dict[str, float] = {}
    default_floor = 0.0
    if os.path.isfile(args.manifest):
        with open(args.manifest, "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
        default_floor = float(manifest.get("minConfidence", 0.0))
        deployed_floors = {k: float(v) for k, v in (manifest.get("minConfidenceByLabel") or {}).items()}

    rows = probe(model, store, images, args.floor)
    report = {
        "model": {"id": model.id, "version": model.version, "family": model.family},
        "images": len(rows),
        "reportedAtFloor": args.floor,
        "deployedFloor": default_floor,
        "deployedFloorByLabel": deployed_floors,
        "perClass": summarise(rows, deployed_floors, default_floor),
        "perImage": rows,
    }

    print(f"{'class':12} {'seen':>5} {'max':>7} {'floor':>6} {'admitted':>9}")
    for label, stats in report["perClass"].items():
        if stats["seen"] == 0 and label != "person":
            continue
        best = "-" if stats["max"] is None else format(stats["max"], ".4f")
        print(f"{label:12} {stats['seen']:>5} {best:>7} {stats['floor']:>6.2f} {stats['admitted']:>9}")

    text = json.dumps(report, indent=2)
    if args.out is not None:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
