"""The registered-model catalogue the deployed runtime resolves against (P-8 Phase 3).

**Why this exists.** The `onnx` backend resolved models through `MlflowModelResolver` — an MLflow
tracking server plus S3. That is the right tool for *authoring* a model and the wrong dependency for
*running* one: it puts a dev-stack service on the critical path of every production start, and it
means the model a container runs is decided by something outside the image. Here the catalogue is a
document inside the image, the artifacts are checksummed, and a container's model set is a property
of the build.

**What is model-specific lives here as data** — artifact, checksum, how a frame becomes a tensor,
how a tensor becomes detections, the label space, the licence. `model_store.py` itself knows nothing
about YOLO or SSD, and neither does anything downstream of it: the runtime reads `outputFormat` and
asks the decoder registry for a decoder (ADR-0002, and the reason `engines.py` says "YOLO is NOT
special-cased").

**Stdlib-only**, so the whole catalogue — selection rules, checksum discipline, capability binding —
is unit-tested without onnxruntime or numpy. The artifacts are the only part that needs the heavy
backend, and they are verified here before that backend ever sees them.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from contracts import ModelBinding
from selector import ModelSelector, SelectorUnresolved, matches

#: Default location of the artifacts inside the image. Deliberately **outside `/app`**: gate 0
#: (deployment-integrity §6) compares the container's `/app` byte-for-byte against `ai/inference`,
#: and 33 MB of build-time downloads living there would make every deployment look tampered with.
DEFAULT_ARTIFACT_DIR = "/opt/vip/models"

_HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CATALOGUE = os.path.join(_HERE, "models", "registry.json")

#: Read in 1 MiB blocks — an artifact must not become its own size in resident memory at startup.
_HASH_BLOCK = 1024 * 1024

#: Version of the PREPROCESSING IMPLEMENTATION (adapters/model_formats.preprocess). Bump it when the
#: pixel path changes in a way that could move a detection — a different interpolation, a different
#: pad placement — even though no catalogue entry changed. Combined with `InputSpec.fingerprint()` it
#: is what makes a result reproducible.
PREPROCESSING_VERSION = "1.0"


class ModelStoreError(RuntimeError):
    """The catalogue is unreadable, or an artifact is missing, truncated or not what was registered."""


@dataclass(frozen=True)
class InputSpec:
    """How a frame becomes this model's input tensor. Every field is read from the catalogue; none
    of it is a constant in the code, which is what keeps the adapter model-agnostic."""

    width: int
    height: int
    layout: str = "NCHW"  # NCHW | NHWC
    dtype: str = "float32"  # float32 | uint8
    color_order: str = "RGB"  # RGB | BGR
    resize: str = "letterbox"  # letterbox (aspect-preserving, padded) | stretch
    pad_value: int = 114
    scale: float = 1.0
    mean: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    std: Tuple[float, float, float] = (1.0, 1.0, 1.0)

    @staticmethod
    def from_dict(data: Mapping[str, object]) -> "InputSpec":
        def triple(key: str, fallback: Tuple[float, float, float]) -> Tuple[float, float, float]:
            raw = data.get(key)
            if isinstance(raw, (list, tuple)) and len(raw) == 3:
                return (float(raw[0]), float(raw[1]), float(raw[2]))
            return fallback

        spec = InputSpec(
            width=int(data.get("width", 0) or 0),
            height=int(data.get("height", 0) or 0),
            layout=str(data.get("layout", "NCHW")).upper(),
            dtype=str(data.get("dtype", "float32")).lower(),
            color_order=str(data.get("colorOrder", "RGB")).upper(),
            resize=str(data.get("resize", "letterbox")).lower(),
            pad_value=int(data.get("padValue", 114) or 0),
            scale=float(data.get("scale", 1.0) or 1.0),
            mean=triple("mean", (0.0, 0.0, 0.0)),
            std=triple("std", (1.0, 1.0, 1.0)),
        )
        if spec.width <= 0 or spec.height <= 0:
            raise ModelStoreError("input.width and input.height are required and must be > 0")
        if spec.layout not in ("NCHW", "NHWC"):
            raise ModelStoreError(f"unsupported input.layout '{spec.layout}' (NCHW|NHWC)")
        if spec.dtype not in ("float32", "uint8"):
            raise ModelStoreError(f"unsupported input.dtype '{spec.dtype}' (float32|uint8)")
        if spec.color_order not in ("RGB", "BGR"):
            raise ModelStoreError(f"unsupported input.colorOrder '{spec.color_order}' (RGB|BGR)")
        if spec.resize not in ("letterbox", "stretch"):
            raise ModelStoreError(f"unsupported input.resize '{spec.resize}' (letterbox|stretch)")
        if 0.0 in spec.std:
            raise ModelStoreError("input.std must not contain zero")
        return spec

    def fingerprint(self) -> str:
        """A reproducible description of how a frame becomes this model's tensor.

        ⚠️ Stamped onto every `DetectionResult` (with `PREPROCESSING_VERSION`) because without it a
        result is not reproducible: the same model, the same execution provider and the same frame
        give different detections if the resize policy, colour order or pad value changed, and no
        other version field on the document would show it.

        Human-readable on purpose — an engineer comparing two archived results should be able to see
        the difference without a lookup table.
        """
        parts = [
            self.resize,
            f"{self.width}x{self.height}",
            self.layout,
            self.dtype,
            self.color_order,
        ]
        if self.resize == "letterbox":
            parts.append(f"pad{self.pad_value}")
        if self.scale != 1.0:
            parts.append(f"s{self.scale:g}")
        if self.mean != (0.0, 0.0, 0.0) or self.std != (1.0, 1.0, 1.0):
            parts.append("norm" + ",".join(f"{v:g}" for v in (*self.mean, *self.std)))
        return "-".join(parts)

    def to_dict(self) -> dict:
        return {
            "width": self.width,
            "height": self.height,
            "layout": self.layout,
            "dtype": self.dtype,
            "colorOrder": self.color_order,
            "resize": self.resize,
            "padValue": self.pad_value,
            "scale": self.scale,
            "mean": list(self.mean),
            "std": list(self.std),
        }


@dataclass(frozen=True)
class RegisteredModel:
    """One entry in the catalogue: an immutable, checksummed model the runtime may load."""

    id: str
    name: str
    version: str
    task: str
    family: str
    engine: str
    artifact: str
    sha256: str
    output_format: str
    labels: Sequence[str]
    input: InputSpec
    accelerators: Sequence[str] = ("cpu",)
    capabilities: Sequence[str] = ()
    status: str = "enabled"
    default: bool = False
    size_bytes: int = 0
    source: str = ""
    license: str = ""
    license_holder: str = ""
    trained_on: str = ""
    output_params: Mapping[str, object] = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        return self.status == "enabled"

    def serves(self, capability_id: str) -> bool:
        return capability_id in self.capabilities

    def binding(self, accelerator: str = "cpu") -> ModelBinding:
        return ModelBinding(
            id=self.id,
            name=self.name,
            version=self.version,
            task=self.task,
            family=self.family,
            accelerator=accelerator,
        )

    def selector_view(self) -> Dict[str, object]:
        """The mapping shape `selector.matches` expects — the catalogue reuses the frozen selector
        grammar rather than inventing a second one."""
        return {
            "name": self.name,
            "version": self.version,
            "task": self.task,
            "family": self.family,
            "accelerators": list(self.accelerators),
        }

    def descriptor(self, *, artifact_dir: str = DEFAULT_ARTIFACT_DIR) -> dict:
        """What an operator (and the runtime dashboard) may see. ⚠️ No absolute artifact path and no
        source URL beyond its host — a status page is not a place to publish the filesystem."""
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "task": self.task,
            "family": self.family,
            "engine": self.engine,
            "format": self.output_format,
            "status": self.status,
            "default": self.default,
            "capabilities": list(self.capabilities),
            "accelerators": list(self.accelerators),
            "inputSize": [self.input.width, self.input.height],
            "labelCount": len([label for label in self.labels if label]),
            "sizeBytes": self.size_bytes,
            "checksum": f"sha256:{self.sha256[:12]}",
            "license": self.license,
            "trainedOn": self.trained_on,
            "artifactPresent": os.path.isfile(os.path.join(artifact_dir, self.artifact)),
        }

    @staticmethod
    def from_dict(data: Mapping[str, object]) -> "RegisteredModel":
        def text(key: str, *, required: bool = False, fallback: str = "") -> str:
            raw = data.get(key)
            value = str(raw).strip() if isinstance(raw, (str, int, float)) else ""
            if required and value == "":
                raise ModelStoreError(f"model entry is missing required field '{key}'")
            return value or fallback

        raw_input = data.get("input")
        if not isinstance(raw_input, dict):
            raise ModelStoreError(f"model '{text('id')}' is missing an 'input' spec")
        raw_labels = data.get("labels")
        if not isinstance(raw_labels, list) or not raw_labels:
            raise ModelStoreError(f"model '{text('id')}' is missing a 'labels' list")
        sha = text("sha256", required=True).lower()
        if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise ModelStoreError(f"model '{text('id')}' has a malformed sha256")
        params = data.get("outputParams")
        return RegisteredModel(
            id=text("id", required=True),
            name=text("name", fallback=text("id")),
            version=text("version", required=True),
            task=text("task", required=True),
            family=text("family", fallback="*"),
            engine=text("engine", fallback="onnx"),
            artifact=text("artifact", required=True),
            sha256=sha,
            output_format=text("outputFormat", required=True),
            labels=[str(label) for label in raw_labels],
            input=InputSpec.from_dict(raw_input),
            accelerators=[str(a) for a in data.get("accelerators", ["cpu"])] or ["cpu"],
            capabilities=[str(c) for c in data.get("capabilities", [])],
            status=text("status", fallback="enabled"),
            default=bool(data.get("default", False)),
            size_bytes=int(data.get("sizeBytes", 0) or 0),
            source=text("source"),
            license=text("license"),
            license_holder=text("licenseHolder"),
            trained_on=text("trainedOn"),
            output_params=dict(params) if isinstance(params, dict) else {},
        )


class ModelStore:
    """The catalogue, plus the artifact directory it describes."""

    def __init__(self, models: Sequence[RegisteredModel], *, artifact_dir: str = DEFAULT_ARTIFACT_DIR) -> None:
        seen: Dict[str, RegisteredModel] = {}
        for model in models:
            if model.id in seen:
                raise ModelStoreError(f"duplicate model id '{model.id}' in the catalogue")
            seen[model.id] = model
        self._models = list(models)
        self.artifact_dir = artifact_dir

    # --- loading -----------------------------------------------------------------

    @staticmethod
    def load(path: str = DEFAULT_CATALOGUE, *, artifact_dir: str = DEFAULT_ARTIFACT_DIR) -> "ModelStore":
        try:
            with open(path, "r", encoding="utf-8") as handle:
                document = json.load(handle)
        except FileNotFoundError as exc:
            raise ModelStoreError(f"model catalogue not found at {path}") from exc
        except json.JSONDecodeError as exc:
            raise ModelStoreError(f"model catalogue at {path} is not valid JSON: {exc}") from exc
        entries = document.get("models") if isinstance(document, dict) else None
        if not isinstance(entries, list) or not entries:
            raise ModelStoreError(f"model catalogue at {path} declares no models")
        return ModelStore([RegisteredModel.from_dict(e) for e in entries], artifact_dir=artifact_dir)

    def __len__(self) -> int:
        return len(self._models)

    def all(self) -> List[RegisteredModel]:
        return list(self._models)

    def get(self, model_id: str) -> Optional[RegisteredModel]:
        for model in self._models:
            if model.id == model_id:
                return model
        return None

    def artifact_path(self, model: RegisteredModel) -> str:
        return os.path.join(self.artifact_dir, model.artifact)

    # --- integrity ----------------------------------------------------------------

    def verify(self, model: RegisteredModel) -> str:
        """Hash the artifact and compare it with the catalogue. ⚠️ Run at process start, not only at
        build time: "the file is there" and "the file we registered is there" are different claims,
        and a truncated download answers the first one."""
        path = self.artifact_path(model)
        if not os.path.isfile(path):
            raise ModelStoreError(
                f"model '{model.id}' artifact is missing: {path}. "
                "Run fetch_models.py, or build the image with INFERENCE_BACKEND=onnx."
            )
        digest = sha256_file(path)
        if digest != model.sha256:
            raise ModelStoreError(
                f"model '{model.id}' artifact checksum mismatch at {path}: "
                f"registered sha256:{model.sha256[:12]}…, found sha256:{digest[:12]}…"
            )
        return path

    # --- selection ----------------------------------------------------------------

    def select(
        self,
        selector: ModelSelector,
        *,
        capability_id: Optional[str] = None,
        preferred_id: Optional[str] = None,
    ) -> RegisteredModel:
        """Resolve a capability's selector to exactly one registered model.

        ⚠️ Order matters and is deliberate: an explicit `preferred_id` (operator override) beats the
        catalogue's `default`, which beats "highest version". Silently picking a different model
        because two matched equally is how a deployment ends up running something nobody chose.
        """
        candidates = [m for m in self._models if m.enabled and matches(selector, m.selector_view())]
        if capability_id is not None:
            candidates = [m for m in candidates if m.serves(capability_id)]
        if not candidates:
            raise SelectorUnresolved(
                f"no registered model for capability={capability_id or '*'} task={selector.task} "
                f"family={selector.family} version={selector.version_range or '*'} "
                f"(catalogue holds {len(self._models)}: {', '.join(m.id for m in self._models)})"
            )
        if preferred_id is not None:
            for model in candidates:
                if model.id == preferred_id:
                    return model
            raise SelectorUnresolved(
                f"requested model '{preferred_id}' does not serve capability="
                f"{capability_id or '*'} (candidates: {', '.join(m.id for m in candidates)})"
            )
        for model in candidates:
            if model.default:
                return model
        return max(candidates, key=lambda m: _version_key(m.version))


class LocalModelResolver:
    """`ModelResolver` over the in-image catalogue — the production default for the `onnx` backend.

    Returns the same `(ModelBinding, ref)` pair every resolver returns; the `ref` carries everything
    the adapter needs and nothing it has to infer. The capability never learns which family it got.
    """

    def __init__(
        self,
        store: ModelStore,
        *,
        capability_id: Optional[str] = None,
        preferred_id: Optional[str] = None,
    ) -> None:
        self._store = store
        self._capability_id = capability_id
        self._preferred_id = preferred_id or None

    def resolve(self, selector: ModelSelector) -> Tuple[ModelBinding, dict]:
        model = self._store.select(
            selector, capability_id=self._capability_id, preferred_id=self._preferred_id
        )
        path = self._store.verify(model)
        accel = selector.accelerators[0] if selector.accelerators else "cpu"
        ref = {
            "modelId": model.id,
            "onnx_path": path,
            "labels": list(model.labels),
            "input": model.input,
            "outputFormat": model.output_format,
            "outputParams": dict(model.output_params),
            "preprocessing": f"{PREPROCESSING_VERSION}/{model.input.fingerprint()}",
            "descriptor": model.descriptor(artifact_dir=self._store.artifact_dir),
        }
        return model.binding(accel), ref


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(_HASH_BLOCK), b""):
            digest.update(block)
    return digest.hexdigest()


def _version_key(version: str) -> Tuple[int, ...]:
    parts = []
    for chunk in version.split("."):
        head = "".join(c for c in chunk if c.isdigit())
        parts.append(int(head) if head else 0)
    return tuple(parts)
