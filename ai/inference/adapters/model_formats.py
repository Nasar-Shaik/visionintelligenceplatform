"""Model **formats** — the two model-specific stages, expressed as data plus a decoder registry.

    frame bytes ──[preprocess(spec)]──> tensor ──[session.run]──> raw outputs ──[decode(format)]──> RawDetection[]

Both ends are driven by the catalogue entry (`model_store.InputSpec`, `outputFormat`), never by the
model's name. `preprocess` is ONE implementation covering every registered model — layout, dtype,
colour order, resize policy, padding and normalisation are all fields. Decoding is the only place a
family's tensor layout is known, and each one is a small function in a registry:

    register_decoder("yolox", decode_yolox)

Adding RT-DETR, YOLOE, GroundingDINO or SAM2 means a catalogue entry and — only if its output layout
is genuinely new — one more function here. Nothing above this module changes, and nothing above this
module can tell which family answered.

⚠️ **One decoder is registered, deliberately.** A second (`tf-object-detection`, the SSD /
Faster R-CNN head: four tensors, NMS already in the graph, boxes as ymin/xmin/ymax/xmax) was written
and MEASURED end-to-end through this same unchanged module during P-8 Phase 3 — 29 MB artifact,
0.934 on a car, 0.871 on a person — which is the evidence that the seam is real rather than a claim
about code shape. It was then removed: a decoder no shipped artifact exercises is surface a serving
container carries for nobody. The extension point is what remains, and re-adding that family is one
catalogue entry and one function.

⚠️ **Integration-only** (numpy + pillow). The stdlib `stub` backend never imports it. Its unit tests
skip when numpy is absent locally and RUN INSIDE THE DEPLOYED IMAGE, where numpy is present — the
verification script asserts they were not skipped, because a test that silently skips in the one
environment that matters is worse than no test.
"""

from __future__ import annotations

import io
from typing import Any, Callable, Dict, List, Sequence, Tuple

import numpy as np  # type: ignore
from PIL import Image  # type: ignore

from model_store import InputSpec
from pipeline import RawDetection


class Geometry:
    """How the source frame was fitted into the input tensor, so boxes can be mapped back.

    ⚠️ Without this, a letterboxed model reports boxes that are correct in tensor space and wrong on
    the operator's screen — an error that looks like a bad model rather than a bad transform.
    """

    __slots__ = ("mode", "ratio", "pad_x", "pad_y", "input_w", "input_h", "src_w", "src_h")

    def __init__(
        self,
        mode: str,
        ratio: float,
        pad_x: float,
        pad_y: float,
        input_w: int,
        input_h: int,
        src_w: int,
        src_h: int,
    ) -> None:
        self.mode = mode
        self.ratio = ratio
        self.pad_x = pad_x
        self.pad_y = pad_y
        self.input_w = input_w
        self.input_h = input_h
        self.src_w = src_w
        self.src_h = src_h


class UnknownModelFormat(LookupError):
    """No decoder is registered for a catalogue entry's `outputFormat`."""


# --- preprocessing (one implementation, driven entirely by the spec) ------------------------------


def preprocess(image_bytes: bytes, spec: InputSpec) -> Tuple[Any, Geometry]:
    """Decode a JPEG/PNG frame and produce this model's input tensor plus the geometry to undo it."""
    image = Image.open(io.BytesIO(image_bytes))
    if image.mode != "RGB":
        image = image.convert("RGB")
    src_w, src_h = image.size

    if spec.resize == "stretch":
        resized = image.resize((spec.width, spec.height))
        canvas = np.asarray(resized, dtype=np.uint8)
        geometry = Geometry("stretch", 1.0, 0.0, 0.0, spec.width, spec.height, src_w, src_h)
    else:
        ratio = min(spec.width / max(src_w, 1), spec.height / max(src_h, 1))
        new_w = max(1, int(round(src_w * ratio)))
        new_h = max(1, int(round(src_h * ratio)))
        canvas = np.full((spec.height, spec.width, 3), spec.pad_value, dtype=np.uint8)
        canvas[:new_h, :new_w] = np.asarray(image.resize((new_w, new_h)), dtype=np.uint8)
        # ⚠️ Padding is bottom/right only (the YOLOX export convention), so the offset is zero. It is
        # still carried explicitly: a centred-padding model is a spec change, not a code change.
        geometry = Geometry("letterbox", ratio, 0.0, 0.0, spec.width, spec.height, src_w, src_h)

    if spec.color_order == "BGR":
        canvas = canvas[:, :, ::-1]

    if spec.dtype == "uint8":
        tensor = np.ascontiguousarray(canvas, dtype=np.uint8)
    else:
        tensor = canvas.astype(np.float32)
        if spec.scale != 1.0:
            tensor = tensor * spec.scale
        if spec.mean != (0.0, 0.0, 0.0):
            tensor = tensor - np.asarray(spec.mean, dtype=np.float32)
        if spec.std != (1.0, 1.0, 1.0):
            tensor = tensor / np.asarray(spec.std, dtype=np.float32)

    if spec.layout == "NCHW":
        tensor = np.ascontiguousarray(np.transpose(tensor, (2, 0, 1)))
    return tensor[np.newaxis, ...], geometry


# --- shared box mapping ---------------------------------------------------------------------------


def to_source_bbox(x1: float, y1: float, x2: float, y2: float, geometry: Geometry) -> Tuple[float, float, float, float]:
    """Input-tensor pixels → `[x, y, w, h]` normalized to the ORIGINAL frame, clamped to [0,1].

    Every decoder returns tensor-pixel corners and goes through here, so "which coordinate space is
    this in?" has exactly one answer in the runtime.
    """
    ratio = geometry.ratio if geometry.ratio > 0 else 1.0
    sx1 = (x1 - geometry.pad_x) / ratio
    sy1 = (y1 - geometry.pad_y) / ratio
    sx2 = (x2 - geometry.pad_x) / ratio
    sy2 = (y2 - geometry.pad_y) / ratio
    if geometry.mode == "stretch":
        # The tensor IS the whole frame, so normalise by the tensor's own dimensions.
        width = float(geometry.input_w)
        height = float(geometry.input_h)
    else:
        width = float(geometry.src_w)
        height = float(geometry.src_h)
    left = _clamp(sx1 / max(width, 1.0))
    top = _clamp(sy1 / max(height, 1.0))
    right = _clamp(sx2 / max(width, 1.0))
    bottom = _clamp(sy2 / max(height, 1.0))
    return (left, top, max(0.0, right - left), max(0.0, bottom - top))


def nms(boxes: Any, scores: Any, iou_threshold: float) -> List[int]:
    """Greedy non-maximum suppression over `[x1,y1,x2,y2]` boxes. Returns kept indices, best first.

    ⚠️ Lives here, not in the pipeline: whether a model's head needs NMS at all is a property of the
    model (SSD's does not — it is baked into the graph), so it belongs on the model side of the seam.
    """
    if len(boxes) == 0:
        return []
    boxes = np.asarray(boxes, dtype=np.float32)
    scores = np.asarray(scores, dtype=np.float32)
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: List[int] = []
    while order.size > 0:
        best = int(order[0])
        keep.append(best)
        if order.size == 1:
            break
        rest = order[1:]
        xx1 = np.maximum(x1[best], x1[rest])
        yy1 = np.maximum(y1[best], y1[rest])
        xx2 = np.minimum(x2[best], x2[rest])
        yy2 = np.minimum(y2[best], y2[rest])
        overlap = np.maximum(0.0, xx2 - xx1) * np.maximum(0.0, yy2 - yy1)
        union = areas[best] + areas[rest] - overlap
        iou = np.where(union > 0, overlap / np.maximum(union, 1e-9), 0.0)
        order = rest[iou <= iou_threshold]
    return keep


# --- decoders ------------------------------------------------------------------------------------

Decoder = Callable[[Sequence[Any], InputSpec, Geometry, Dict[str, object]], List[RawDetection]]

_DECODERS: Dict[str, Decoder] = {}


def register_decoder(output_format: str, decoder: Decoder) -> None:
    """Add a decoder for a catalogue `outputFormat`. The extension point for a new model family."""
    _DECODERS[output_format] = decoder


def get_decoder(output_format: str) -> Decoder:
    decoder = _DECODERS.get(output_format)
    if decoder is None:
        raise UnknownModelFormat(
            f"no decoder registered for outputFormat '{output_format}' "
            f"(registered: {', '.join(sorted(_DECODERS)) or 'none'})"
        )
    return decoder


def available_decoders() -> List[str]:
    return sorted(_DECODERS)


def decode_yolox(
    outputs: Sequence[Any],
    spec: InputSpec,
    geometry: Geometry,
    params: Dict[str, object],
) -> List[RawDetection]:
    """YOLOX heads: one `[1, anchors, 5 + classes]` tensor of grid-relative predictions — centre/size
    must be decoded against the stride grid, objectness multiplied into the class score, and NMS run
    here because the graph does not do it."""
    predictions = np.asarray(outputs[0])
    if predictions.ndim == 3:
        predictions = predictions[0]
    if predictions.ndim != 2 or predictions.shape[1] < 6:
        raise ValueError(f"yolox expects [1, anchors, 5+classes], got {np.asarray(outputs[0]).shape}")

    strides = [int(s) for s in params.get("strides", [8, 16, 32])]  # type: ignore[arg-type]
    grid, stride_column = _yolox_grid(spec.width, spec.height, strides)
    if grid.shape[0] != predictions.shape[0]:
        raise ValueError(
            f"yolox grid mismatch: model produced {predictions.shape[0]} anchors, strides "
            f"{strides} at {spec.width}x{spec.height} describe {grid.shape[0]}"
        )

    centres = (predictions[:, 0:2] + grid) * stride_column
    sizes = np.exp(predictions[:, 2:4]) * stride_column
    objectness = predictions[:, 4]
    class_scores = predictions[:, 5:]
    class_ids = class_scores.argmax(axis=1)
    confidence = objectness * class_scores[np.arange(class_scores.shape[0]), class_ids]

    floor = float(params.get("scoreFloor", 0.05) or 0.0)
    kept = confidence >= floor
    if not np.any(kept):
        return []
    centres, sizes = centres[kept], sizes[kept]
    confidence, class_ids = confidence[kept], class_ids[kept]

    corners = np.empty((centres.shape[0], 4), dtype=np.float32)
    corners[:, 0] = centres[:, 0] - sizes[:, 0] / 2.0
    corners[:, 1] = centres[:, 1] - sizes[:, 1] / 2.0
    corners[:, 2] = centres[:, 0] + sizes[:, 0] / 2.0
    corners[:, 3] = centres[:, 1] + sizes[:, 1] / 2.0

    iou_threshold = float(params.get("nmsIouThreshold", 0.45) or 0.45)
    detections: List[RawDetection] = []
    # ⚠️ Per class. Class-agnostic NMS deletes the person standing in front of the car.
    for class_id in np.unique(class_ids):
        mask = class_ids == class_id
        indices = np.flatnonzero(mask)
        for local in nms(corners[mask], confidence[mask], iou_threshold):
            index = int(indices[local])
            x1, y1, x2, y2 = (float(v) for v in corners[index])
            detections.append(
                RawDetection(
                    bbox=to_source_bbox(x1, y1, x2, y2, geometry),
                    score=float(confidence[index]),
                    class_id=int(class_id),
                )
            )
    detections.sort(key=lambda d: d.score, reverse=True)
    return detections


def _yolox_grid(width: int, height: int, strides: Sequence[int]) -> Tuple[Any, Any]:
    grids = []
    stride_columns = []
    for stride in strides:
        gw, gh = width // stride, height // stride
        xs, ys = np.meshgrid(np.arange(gw), np.arange(gh))
        grids.append(np.stack((xs, ys), axis=2).reshape(-1, 2))
        stride_columns.append(np.full((gw * gh, 1), stride))
    return (
        np.concatenate(grids, axis=0).astype(np.float32),
        np.concatenate(stride_columns, axis=0).astype(np.float32),
    )


def decode_rtdetr(
    outputs: Sequence[Any],
    spec: InputSpec,
    geometry: Geometry,
    params: Dict[str, object],
) -> List[RawDetection]:
    """RT-DETR heads: two tensors, `logits [1, queries, classes]` and `pred_boxes [1, queries, 4]`.

    ⭐ **Nothing like YOLOX, which is the point of having a decoder registry.** RT-DETR is a direct
    set predictor: a fixed number of queries (300) each propose one box, and the model is trained so
    that duplicates do not arise. There is **no objectness, no anchor grid, no stride decoding and no
    NMS** — running NMS here would be a slow no-op at best and would merge two genuinely adjacent
    people at worst.

    ⚠️ **Scores are sigmoid, not softmax.** RT-DETR trains with a focal loss over independent class
    logits, so the 80 classes of one query do not sum to 1 and one query may legitimately be reported
    under two classes. Applying softmax produces confident-looking numbers that are wrong in a way no
    smoke test detects — every box still appears, with plausible scores.

    ⚠️ **Boxes are `cxcywh` normalized to the input tensor**, not corners and not pixels. They are
    converted to tensor pixels here and mapped through the same `to_source_bbox` every other decoder
    uses, so there is still exactly one answer to "which coordinate space is this in?".
    """
    logits, boxes = _rtdetr_split(outputs)

    num_classes = logits.shape[1]
    declared = params.get("numClasses")
    if declared is not None and int(declared) != num_classes:
        raise ValueError(
            f"rtdetr class-count mismatch: model emits {num_classes}, catalogue declares {int(declared)}"
        )

    scores = 1.0 / (1.0 + np.exp(-logits.astype(np.float32)))

    # The official post-process ranks over the flattened (query × class) grid rather than taking one
    # class per query — which is how a query that is genuinely ambiguous reports both readings.
    #
    # ⚠️ `k` is the number of **queries** (300), not queries × classes. That is what upstream does
    # (`topk(scores.flatten(1), num_queries)`) and it is load-bearing in both directions: a larger k
    # reports every query under several classes, a smaller one truncates real detections.
    flat = scores.reshape(-1)
    limit = int(params.get("maxDetections", logits.shape[0]) or logits.shape[0])
    limit = max(1, min(limit, flat.size))
    top = np.argpartition(flat, -limit)[-limit:]
    top = top[np.argsort(flat[top])[::-1]]

    floor = float(params.get("scoreFloor", 0.05) or 0.0)
    detections: List[RawDetection] = []
    for index in top:
        score = float(flat[index])
        if score < floor:
            break  # already sorted descending
        query, class_id = divmod(int(index), num_classes)
        cx, cy, bw, bh = (float(v) for v in boxes[query])
        x1 = (cx - bw / 2.0) * spec.width
        y1 = (cy - bh / 2.0) * spec.height
        x2 = (cx + bw / 2.0) * spec.width
        y2 = (cy + bh / 2.0) * spec.height
        detections.append(
            RawDetection(
                bbox=to_source_bbox(x1, y1, x2, y2, geometry),
                score=score,
                class_id=int(class_id),
            )
        )
    return detections


def _rtdetr_split(outputs: Sequence[Any]) -> Tuple[Any, Any]:
    """Identify which tensor is which **by shape, not by position**.

    ⛔ Reading `pred_boxes` as logits produces 300 confident detections of class 0–3 at coordinates
    derived from probabilities — output that is the right shape, the right dtype, and completely
    fictional. Export order is a property of whoever ran the export, so it is not trusted: boxes are
    the tensor whose last dimension is 4, and it must be unambiguous.
    """
    if len(outputs) < 2:
        raise ValueError(f"rtdetr expects two output tensors (logits, pred_boxes), got {len(outputs)}")
    tensors = []
    for tensor in outputs[:2]:
        array = np.asarray(tensor)
        tensors.append(array[0] if array.ndim == 3 else array)
    if any(t.ndim != 2 for t in tensors):
        raise ValueError(f"rtdetr expects 2-D tensors after batch removal, got {[t.shape for t in tensors]}")

    box_like = [i for i, t in enumerate(tensors) if t.shape[1] == 4]
    if len(box_like) != 1:
        raise ValueError(
            "rtdetr cannot tell logits from boxes by shape "
            f"({[t.shape for t in tensors]}) — exactly one tensor must have a last dimension of 4"
        )
    boxes = tensors[box_like[0]]
    logits = tensors[1 - box_like[0]]
    if logits.shape[0] != boxes.shape[0]:
        raise ValueError(
            f"rtdetr query-count mismatch: logits {logits.shape}, boxes {boxes.shape}"
        )
    return logits, boxes


def decode_yolo11(
    outputs: Sequence[Any],
    spec: InputSpec,
    geometry: Geometry,
    params: Dict[str, object],
) -> List[RawDetection]:
    """Ultralytics v8/v11 head: one `[1, 4 + classes, anchors]` tensor — **channels-first**.

    ⚠️ **Two traps, both of which produce output rather than an error.**

    1. **The layout is transposed relative to YOLOX.** YOLOX emits `[1, anchors, features]`; this
       emits `[1, features, anchors]`. Reading it the YOLOX way yields 84 "detections" whose
       "features" are 8400 anchor values — a full result set, entirely fictional.
    2. **There is no objectness column.** YOLOX multiplies objectness into the class score; doing
       that here consumes `cx`, the box centre, as a probability. Boxes still appear, ranked by
       where they are on screen rather than by how confident the model is.

    Class scores arrive already sigmoid-activated from the exported graph, so no activation is
    applied here. NMS **is** required — unlike RT-DETR, this head proposes duplicates by design.
    """
    predictions = np.asarray(outputs[0])
    if predictions.ndim == 3:
        predictions = predictions[0]
    if predictions.ndim != 2:
        raise ValueError(f"yolo11 expects [1, 4+classes, anchors], got {np.asarray(outputs[0]).shape}")

    # Anchors vastly outnumber features (8400 vs 84); the catalogue may state it explicitly.
    layout = str(params.get("layout", "channels-first"))
    if layout == "channels-first":
        predictions = predictions.T
    features = predictions.shape[1]
    declared = params.get("numClasses")
    if declared is not None and features - 4 != int(declared):
        raise ValueError(
            f"yolo11 class-count mismatch: tensor carries {features - 4} classes, "
            f"catalogue declares {int(declared)} (layout '{layout}' — a transposed read looks like this)"
        )
    if features < 5:
        raise ValueError(f"yolo11 expects at least 5 features (4 box + 1 class), got {features}")

    centres = predictions[:, 0:2].astype(np.float32)
    sizes = predictions[:, 2:4].astype(np.float32)
    class_scores = predictions[:, 4:].astype(np.float32)
    class_ids = class_scores.argmax(axis=1)
    confidence = class_scores[np.arange(class_scores.shape[0]), class_ids]

    floor = float(params.get("scoreFloor", 0.05) or 0.0)
    kept = confidence >= floor
    if not np.any(kept):
        return []
    centres, sizes = centres[kept], sizes[kept]
    confidence, class_ids = confidence[kept], class_ids[kept]

    corners = np.empty((centres.shape[0], 4), dtype=np.float32)
    corners[:, 0] = centres[:, 0] - sizes[:, 0] / 2.0
    corners[:, 1] = centres[:, 1] - sizes[:, 1] / 2.0
    corners[:, 2] = centres[:, 0] + sizes[:, 0] / 2.0
    corners[:, 3] = centres[:, 1] + sizes[:, 1] / 2.0

    iou_threshold = float(params.get("nmsIouThreshold", 0.45) or 0.45)
    detections: List[RawDetection] = []
    # ⚠️ Per class, for the same reason as YOLOX: the person in front of the car must survive.
    for class_id in np.unique(class_ids):
        mask = class_ids == class_id
        indices = np.flatnonzero(mask)
        for local in nms(corners[mask], confidence[mask], iou_threshold):
            index = int(indices[local])
            x1, y1, x2, y2 = (float(v) for v in corners[index])
            detections.append(
                RawDetection(
                    bbox=to_source_bbox(x1, y1, x2, y2, geometry),
                    score=float(confidence[index]),
                    class_id=int(class_id),
                )
            )
    detections.sort(key=lambda d: d.score, reverse=True)
    return detections


def _clamp(value: float) -> float:
    return 0.0 if value < 0.0 else (1.0 if value > 1.0 else float(value))


register_decoder("yolox", decode_yolox)
register_decoder("rtdetr", decode_rtdetr)
register_decoder("yolo11", decode_yolo11)
