"""Export RT-DETR (r18vd) to ONNX from the **official Apache-2.0 weights** (P-10 Workstream A2).

    docker run --rm -v "$PWD/out:/out" python:3.12-slim bash -c \
      "pip install -q torch --index-url https://download.pytorch.org/whl/cpu && \
       pip install -q transformers onnx && python /work/export_rtdetr_onnx.py --out /out"

### ⚠️ Why VIP exports this itself instead of downloading a converted artifact

The only **official** RT-DETR artifacts are PyTorch weights (`PekingU/rtdetr_r18vd`, Apache-2.0, the
model's authors). Ready-made ONNX conversions exist on the Hub, but the one that matches this model
declares **no licence of its own** — it only inherits from its stated base. Shipping an artifact with
no declared licence into a commercial, multi-tenant product is the kind of detail a licence audit
finds later and expensively.

Apache-2.0 explicitly permits derivative works, so converting the official weights is clean, and the
provenance becomes entirely ours: this script, a recorded source revision, and a sha256 that
`fetch_models.py` and `model_store.verify()` both check.

⛔ **Not run at build time and not in the serving image.** Torch is a ~200 MB dependency that the
runtime does not need — the runtime consumes ONNX through onnxruntime. This is a one-off tool whose
output is an artifact; run it when the model version changes, never in CI.

### The two decisions this file encodes

1. **Fixed batch of 1, no dynamic axes.** The runtime analyses one frame at a time through
   `FrameSink`; a dynamic batch axis would add graph complexity for a shape that is always 1.
2. **A tuple-returning wrapper.** `RTDetrForObjectDetection` returns a dataclass with ten-plus
   fields, most of them training artefacts. Exporting it directly bakes that whole surface into the
   graph and makes the output *order* an accident of the library version. The wrapper pins the
   contract to exactly `(logits, pred_boxes)`, which is what `decode_rtdetr` reads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

MODEL_ID = "PekingU/rtdetr_r18vd"
OPSET = 17
INPUT_SIZE = 640


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="/out", help="directory to write the artifact into")
    parser.add_argument("--model", default=MODEL_ID)
    parser.add_argument("--name", default="rtdetr-r18vd-1.0.0.onnx")
    args = parser.parse_args()

    import torch  # noqa: PLC0415 — heavy, and deliberately not a module-level import
    from transformers import RTDetrForObjectDetection  # noqa: PLC0415

    print(f"loading {args.model} …")
    model = RTDetrForObjectDetection.from_pretrained(args.model)
    model.eval()

    class _TupleOutput(torch.nn.Module):
        """Pins the exported graph's outputs to `(logits, pred_boxes)` — see the module docstring."""

        def __init__(self, inner: torch.nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, pixel_values: "torch.Tensor"):  # noqa: ANN201
            out = self.inner(pixel_values=pixel_values)
            return out.logits, out.pred_boxes

    wrapped = _TupleOutput(model)
    dummy = torch.randn(1, 3, INPUT_SIZE, INPUT_SIZE)

    with torch.no_grad():
        reference = wrapped(dummy)
    print(f"  logits {tuple(reference[0].shape)} · pred_boxes {tuple(reference[1].shape)}")

    os.makedirs(args.out, exist_ok=True)
    target = os.path.join(args.out, args.name)
    print(f"exporting to {target} (opset {OPSET}) …")
    with torch.no_grad():
        torch.onnx.export(
            wrapped,
            (dummy,),
            target,
            input_names=["pixel_values"],
            output_names=["logits", "pred_boxes"],
            opset_version=OPSET,
            do_constant_folding=True,
            dynamo=False,
        )

    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)

    manifest = {
        "artifact": args.name,
        "sha256": digest.hexdigest(),
        "sizeBytes": os.path.getsize(target),
        "sourceModel": args.model,
        "license": "Apache-2.0",
        "opset": OPSET,
        "inputSize": INPUT_SIZE,
        "logitsShape": list(reference[0].shape),
        "predBoxesShape": list(reference[1].shape),
        "torch": torch.__version__,
    }
    with open(os.path.join(args.out, "rtdetr-export.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
