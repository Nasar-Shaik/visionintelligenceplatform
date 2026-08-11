# Staged model artifacts

⛔ **Artifacts are never committed.** This directory exists so an artifact VIP **produces itself**
can reach the image, and it holds nothing but this file in git.

`fetch_models.py` downloads a registered model from its `source` URL and verifies the sha256. Some
models have no `source`: `rtdetr-r18vd` and `rtmpose-tiny` are exported in-house from upstream
Apache-2.0 weights, because the ready-made conversions carry provenance VIP will not ship
(no declared licence; `body7` training data with research-only terms). For those, `source` is `null`
and the artifact is *produced*, not fetched.

⭐ **No new mechanism was needed.** `fetch()` already returns early when the artifact is present and
its checksum matches — its own error even names the case: *"has no source URL and no verified
artifact on disk"*. Staging the file here before the fetch step turns that branch into the supported
path, and the checksum is still verified twice (build, then process start).

## Producing the pose artifact

```
docker build --platform linux/amd64 -f ai/mlops/Dockerfile.rtmpose-export -t vip/rtmpose-export ai/mlops
docker run --rm --platform linux/amd64 -v "$PWD/.data/models-export:/out" vip/rtmpose-export --variant tiny --out /out
cp .data/models-export/rtmpose-tiny-aic-coco-1.0.0.onnx infra/docker/models-staged/
```

Expected: `rtmpose-tiny-aic-coco-1.0.0.onnx`, 13 374 614 bytes,
sha256 `38b1d4724f679639fbe3f2ba4679b87d99b737eda01d7bc0e0666700df461a68`.
⚠️ A build with a *different* file here fails at `fetch_models.py`, which is the point.

See `docs/validation/POSE_ARTIFACT.md` for full provenance.
