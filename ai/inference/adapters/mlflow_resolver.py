"""MlflowModelResolver — resolves a selector to a registered model in the Phase-0 MLflow Model
Registry and downloads its ONNX artifact. **Integration-only** (imports mlflow). Never imported by
the unit suite or the `stub` backend. Registry model tags carry the selector metadata
(`task`/`family`/`accelerators`/`labels`/`input_size`). Validated against the dev-stack MLflow.
"""

from __future__ import annotations

import json
import os
from typing import List, Mapping, Tuple

import mlflow  # type: ignore
from mlflow.tracking import MlflowClient  # type: ignore

from contracts import ModelBinding
from selector import ModelSelector, select


class MlflowModelResolver:
    def __init__(self, tracking_uri: str, s3_endpoint_url: str) -> None:
        os.environ.setdefault("MLFLOW_S3_ENDPOINT_URL", s3_endpoint_url)
        mlflow.set_tracking_uri(tracking_uri)
        self._client = MlflowClient(tracking_uri=tracking_uri)

    def _catalog(self) -> List[Mapping[str, object]]:
        catalog: List[Mapping[str, object]] = []
        for rm in self._client.search_registered_models():
            for mv in self._client.search_model_versions(f"name='{rm.name}'"):
                tags = mv.tags or {}
                catalog.append(
                    {
                        "name": rm.name,
                        "version": mv.version,
                        "task": tags.get("task", ""),
                        "family": tags.get("family", "*"),
                        "accelerators": json.loads(tags.get("accelerators", '["cpu"]')),
                        "labels": json.loads(tags.get("labels", "[]")),
                        "input_size": int(tags.get("input_size", "640")),
                        "source": mv.source,
                    }
                )
        return catalog

    def resolve(self, selector: ModelSelector) -> Tuple[ModelBinding, dict]:
        model = select(selector, self._catalog())
        local = mlflow.artifacts.download_artifacts(artifact_uri=str(model["source"]))
        onnx_path = _find_onnx(local)
        accel = selector.accelerators[0] if selector.accelerators else "cpu"
        binding = ModelBinding(
            name=str(model["name"]),
            version=str(model["version"]),
            task=str(model["task"]),
            family=str(model.get("family", "*")),
            accelerator=accel,
        )
        ref = {
            "onnx_path": onnx_path,
            "labels": [str(x) for x in model.get("labels", [])] or ["object"],
            "input_size": int(model.get("input_size", 640)),
        }
        return binding, ref


def _find_onnx(path: str) -> str:
    if path.endswith(".onnx"):
        return path
    for root, _dirs, files in os.walk(path):
        for f in files:
            if f.endswith(".onnx"):
                return os.path.join(root, f)
    raise FileNotFoundError(f"no .onnx artifact under {path}")
