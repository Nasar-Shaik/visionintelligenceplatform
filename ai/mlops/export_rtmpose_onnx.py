"""Export RTMPose (AIC+COCO) to ONNX from the **official Apache-2.0 weights** (P3.3a).

    docker build -f ai/mlops/Dockerfile.rtmpose-export -t vip/rtmpose-export ai/mlops
    docker run --rm -v "$PWD/out:/out" vip/rtmpose-export --variant tiny --out /out

### ⚠️ Why VIP exports this itself instead of downloading the published ONNX

OpenMMLab publishes ready-made RTMPose ONNX bundles, and **every one of them is a `body7` model** —
trained on AI Challenger, COCO, CrowdPose, MPII, sub-JHMDB, Halpe and PoseTrack18. Apache-2.0 covers
MMPose's *code*; it does not by itself clear weights derived from datasets whose own terms are
research-oriented. `models/registry.json` already warns: do not silently treat "open source" as
"commercially unrestricted".

⭐ The narrowest published provenance for a 17-keypoint RTMPose is **AIC+COCO**, and it exists only
as a PyTorch checkpoint. So VIP converts it, exactly as it already does for `rtdetr-r18vd`: the
artifact becomes ours, `source` is `null`, and the provenance is this script plus a sha256 that
`fetch_models.py` and `model_store.verify()` both check.

⛔ **Not run at build time and not in the serving image.** torch + mmpose is a multi-hundred-MB
toolchain the runtime does not need — it consumes ONNX through onnxruntime. One-off tool; run it
when the model version changes, never in CI.

### The decisions this file encodes

1. **Batch of 1, no dynamic axes.** Top-down pose runs once per person crop and the runtime analyses
   one frame at a time. ⚠️ A dynamic batch would let several people share one inference call; that is
   a real optimisation and deliberately not taken here, because a fixed shape is the thing the
   existing `preprocess`/verify path already understands. Revisit it with a measurement, not a guess.
2. **The graph returns exactly `(simcc_x, simcc_y)`.** RTMPose's SimCC head emits two 1-D coordinate
   classification maps; everything else on the module is a training artefact. Pinning the tuple makes
   the output *order* part of the artifact rather than an accident of the mmpose version, which is
   what `decode_rtmpose` will read.
3. **No decoding inside the graph.** argmax → coordinate → normalization stays in Python where it is
   testable and where `visible` can be derived separately from `confidence`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request

OPSET = 17
#: 256×192 is the input every published RTMPose body checkpoint is trained at (H×W).
INPUT_H, INPUT_W = 256, 192

#: ⛔ AIC+COCO only. The `body7` variants are deliberately absent — see the module docstring.
VARIANTS = {
    "tiny": {
        "checkpoint": (
            "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/"
            "rtmpose-tiny_simcc-aic-coco_pt-aic-coco_420e-256x192-cfc8f33d_20230126.pth"
        ),
        "config": "rtmpose-t_8xb256-420e_coco-256x192.py",
        "bytes": 13439631,
    },
    "s": {
        "checkpoint": (
            "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/"
            "rtmpose-s_simcc-aic-coco_pt-aic-coco_420e-256x192-fcb2599b_20230126.pth"
        ),
        "config": "rtmpose-s_8xb256-420e_coco-256x192.py",
        "bytes": 22007763,
    },
}


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, dest: str, *, expected_bytes: int) -> str:
    """Fetch the upstream checkpoint. ⚠️ The size is asserted, not assumed.

    ⛔ This does not verify a checksum, because upstream publishes none for these files — which is
    precisely why the *exported* artifact carries one that we compute and register. Recording the
    byte count at least makes a silently substituted file visible.
    """
    if os.path.isfile(dest) and os.path.getsize(dest) == expected_bytes:
        print(f"  = checkpoint already present ({expected_bytes} bytes)")
        return dest
    print(f"  ↓ {url}")
    with urllib.request.urlopen(url, timeout=300) as response, open(dest, "wb") as out:  # noqa: S310
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
    size = os.path.getsize(dest)
    if size != expected_bytes:
        raise SystemExit(
            f"⛔ checkpoint is {size} bytes, expected {expected_bytes}. The upstream file changed; "
            f"do not export it until the difference is understood."
        )
    print(f"  ✓ {size} bytes")
    return dest


class _SimCCOnly:
    """Wrapper pinning the exported graph to `(simcc_x, simcc_y)`. See decision 2."""

    def __init__(self, model):  # noqa: ANN001
        import torch  # noqa: WPS433

        self._torch = torch
        self.model = model

    def build(self):  # noqa: ANN201
        torch = self._torch
        model = self.model

        class Wrapper(torch.nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.inner = model

            def forward(self, image):  # noqa: ANN001, ANN201
                feats = self.inner.extract_feat(image)
                simcc_x, simcc_y = self.inner.head(feats)
                return simcc_x, simcc_y

        wrapper = Wrapper()
        wrapper.eval()
        return wrapper


def export(variant: str, out_dir: str) -> str:
    import torch  # noqa: WPS433

    # ⛔ Built from the registry rather than through `mmpose.apis.init_model`. That convenience API
    # lives in the *demo* package: importing it pulls the top-down inference helpers, which import
    # `mmdet` — a whole second detection framework this export never calls, and one more
    # version-coupled dependency to pin. `MODELS.build` + `load_checkpoint` is the same construction
    # with none of that surface.
    from mmengine.config import Config  # noqa: WPS433
    from mmengine.registry import init_default_scope  # noqa: WPS433
    from mmengine.runner import load_checkpoint  # noqa: WPS433
    from mmpose.registry import MODELS  # noqa: WPS433

    spec = VARIANTS[variant]
    os.makedirs(out_dir, exist_ok=True)
    checkpoint = download(
        spec["checkpoint"],
        os.path.join(out_dir, os.path.basename(spec["checkpoint"])),
        expected_bytes=spec["bytes"],
    )

    config = _find_config(spec["config"])
    print(f"  · config {config}")
    cfg = Config.fromfile(config)
    init_default_scope(cfg.get("default_scope", "mmpose"))
    model = MODELS.build(cfg.model)

    # ⛔ `strict=True`: a config that does not match the checkpoint loads with missing keys and
    # produces a model that runs and returns plausible garbage rather than raising. That is the
    # failure this whole export exists to avoid — an artifact that looks fine and describes nothing.
    load_checkpoint(model, checkpoint, map_location="cpu", strict=True)
    model.eval()
    wrapper = _SimCCOnly(model).build()

    dummy = torch.zeros(1, 3, INPUT_H, INPUT_W, dtype=torch.float32)
    with torch.no_grad():
        simcc_x, simcc_y = wrapper(dummy)
    print(f"  · simcc_x {tuple(simcc_x.shape)} · simcc_y {tuple(simcc_y.shape)}")

    target = os.path.join(out_dir, f"rtmpose-{variant}-aic-coco-1.0.0.onnx")
    torch.onnx.export(
        wrapper,
        dummy,
        target,
        opset_version=OPSET,
        input_names=["image"],
        output_names=["simcc_x", "simcc_y"],
        do_constant_folding=True,
        dynamic_axes=None,  # decision 1
    )

    digest = sha256_file(target)
    meta = {
        "artifact": os.path.basename(target),
        "sha256": digest,
        "sizeBytes": os.path.getsize(target),
        "opset": OPSET,
        "input": {"width": INPUT_W, "height": INPUT_H, "layout": "NCHW", "dtype": "float32"},
        "outputs": {"simcc_x": list(simcc_x.shape), "simcc_y": list(simcc_y.shape)},
        "trainedOn": "AI Challenger + COCO 2017",
        "license": "Apache-2.0",
        "licenseHolder": "OpenMMLab (MMPose / RTMPose)",
        "upstreamCheckpoint": spec["checkpoint"],
        "note": "Exported in-house because every published RTMPose ONNX is a body7 model.",
    }
    with open(os.path.join(out_dir, f"rtmpose-{variant}.export.json"), "w", encoding="utf-8") as h:
        json.dump(meta, h, indent=2)
        h.write("\n")
    print(json.dumps(meta, indent=2))
    print(f"\n✓ {target}\n  sha256 {digest}")
    return digest


def _find_config(name: str) -> str:
    """Locate the packaged mmpose config. ⛔ Never guessed — a wrong config silently builds a
    different architecture, and the state_dict would then load with missing keys."""
    import mmpose  # noqa: WPS433

    roots = [
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(mmpose.__file__))),
                     "projects", "rtmpose", "rtmpose", "body_2d_keypoint"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(mmpose.__file__))),
                     "configs", "body_2d_keypoint", "rtmpose", "coco"),
        "/opt/mmpose/projects/rtmpose/rtmpose/body_2d_keypoint",
        "/opt/mmpose/configs/body_2d_keypoint/rtmpose/coco",
    ]
    for root in roots:
        candidate = os.path.join(root, name)
        if os.path.isfile(candidate):
            return candidate
    raise SystemExit(f"⛔ config '{name}' not found under any of: {roots}")


def selftest(variant: str) -> int:
    """Build the network from its config, with no checkpoint and no network access.

    ⛔ **The build-time check, and it has to be this rather than a list of imports.** Three separate
    import-based smoke tests passed over a toolchain that could not run: `import mmpose` missed
    `xtcocotools`, importing `mmpose.apis` would have missed nothing but pulled `mmdet`, and
    importing `mmpose.registry` missed that `MODELS.build` *lazily* imports `mmpose.models` — which
    eagerly loads every head, including one coupled to `mmdet`. The only check that covers the real
    path is the real path, so this performs the actual construction the export performs.
    """
    from mmengine.config import Config  # noqa: WPS433
    from mmengine.registry import init_default_scope  # noqa: WPS433
    from mmpose.registry import MODELS  # noqa: WPS433

    config = _find_config(VARIANTS[variant]["config"])
    cfg = Config.fromfile(config)
    init_default_scope(cfg.get("default_scope", "mmpose"))
    model = MODELS.build(cfg.model)
    params = sum(p.numel() for p in model.parameters())
    print(f"✓ selftest: built {type(model).__name__} from {os.path.basename(config)} · {params:,} params")
    return 0


def main(argv=None) -> int:  # noqa: ANN001
    parser = argparse.ArgumentParser(description="Export RTMPose (AIC+COCO) to ONNX")
    parser.add_argument("--variant", choices=sorted(VARIANTS), default="tiny")
    parser.add_argument("--out", default="/out")
    parser.add_argument("--selftest", action="store_true",
                        help="build the network from config only — no download, no export")
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest(args.variant)
    print(f"RTMPose export · variant {args.variant} · AIC+COCO · Apache-2.0")
    export(args.variant, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
