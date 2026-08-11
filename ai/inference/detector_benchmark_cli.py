"""Run the detector benchmark matrix over the declared corpus — P3.1.

    python3 detector_benchmark_cli.py --models yolox-nano,rtdetr-r18vd --out /tmp/bench
    python3 detector_benchmark_cli.py --coverage-only          # what the corpus can answer
    python3 detector_benchmark_cli.py --list-models

⭐ **This file drives; it does not aggregate.** The matrix, the uneven-matrix guard and the summary
rendering are `detector_benchmark.py`, which has existed since P-10. What was missing was everything
*around* it: a declared corpus, a runner, environment capture, model provenance and a report.

⚠️ It measures in exactly one place — `TimedAdapter`, wrapping the adapter's `infer()`. Per-frame
latency exists nowhere else: the runtime accumulates `StageTimings` across a whole run and keeps no
per-frame record, so a distribution cannot be recovered from a completed `AnalyzeResult`.

### ⛔ What this refuses to produce

- **A winner, while the corpus cannot support one.** The banner is computed from coverage, not
  written: as long as no scenario reaches `AVAILABLE` it says so at the top rather than in a
  footnote. ⚠️ The committed corpus is in that state today; declaring real footage changes what the
  report is *allowed* to say, which is why the declaration is guarded (`benchmark_corpus`).
- **Precision or recall.** Not one case carries ground truth. Every number here is *observational*:
  latency, FPS, CPU, memory, detections per frame, confidence distribution, class coverage. A
  detection count is not an accuracy.
- **A comparison across environments.** The environment block is captured per run and printed above
  the table, because every latency below it is a property of the host as much as of the detector.

### ⚠️ Warm-up is discarded and said out loud

Session load is 24.1 ms for yolox-nano and 279.9 ms for rtdetr-r18vd — measured. A benchmark that
included the first frame would be reporting the loader, and would penalise the larger model twice.

Stdlib + onnxruntime, like the runtime it measures. Runs inside the built image.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import resource
import subprocess
import sys
import time
from typing import Dict, List, Mapping, Optional, Sequence

import benchmark_corpus as bc
import detector_benchmark as db

#: Frames discarded before timing starts. ⚠️ Named once, reported in every artifact — a warm-up that
#: is not declared is indistinguishable from a detector that is faster than it is.
WARMUP_FRAMES = 3

#: Frames per second sampled from each clip.
#:
#: ⭐ **Production's rate, deliberately.** Analysis sessions run at `analysisFrameRate: 2`, so a
#: benchmark at 2 fps measures what the platform actually does. ⚠️ It is also the difference between
#: a 17-minute run and a two-hour one: at native 15 fps, RT-DETR's 944 ms/frame over 17 clips is
#: ~2 hours of measuring the same thing 450 times per clip. Per-frame latency does not improve with
#: more frames — only the p95's sample count does, and 60 frames is ample for that.
TARGET_FPS = 2.0

DEFAULT_CORPUS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "benchmarks", "detector-corpus.json")
DEFAULT_FIXTURES = "/opt/vip/fixtures/media"
DEFAULT_ARTIFACTS = "/opt/vip/models"


# --- environment + provenance -----------------------------------------------------------------


def environment(*, contended: bool = False, git_sha: str = "") -> Dict[str, object]:
    """What produced these numbers.

    ⚠️ `hostContended` is an **input**, not a detection: only the operator knows whether something
    else was running. It defaults to `False` and the report prints a standing warning either way —
    a flag nobody sets is not evidence the host was quiet.
    """
    try:
        import onnxruntime  # noqa: WPS433 - optional, and its absence is a fact worth recording

        ort = onnxruntime.__version__
        providers = ",".join(onnxruntime.get_available_providers())
    except Exception:  # noqa: BLE001 - a missing runtime is reported, never fatal here
        ort = "absent"
        providers = "absent"
    return {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpuCount": os.cpu_count() or 0,
        "onnxruntime": ort,
        "providers": providers,
        "inContainer": os.path.exists("/.dockerenv"),
        # ⚠️ The caller's value wins: inside the image `git rev-parse` has no work tree to read, so
        # a run that is otherwise fully reproducible would record `unknown` for the one field that
        # says *which source produced it*.
        "gitSha": git_sha or _git_sha(),
        "warmupFrames": WARMUP_FRAMES,
        "hostContended": bool(contended),
    }


def _git_sha() -> str:
    """⚠️ `unknown` inside the built image, which is correct — the image has no work tree."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return out.stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def provenance(models: Sequence[object], store=None) -> List[dict]:  # noqa: ANN001
    """Licence, checksum and origin per model — ⛔ read from the catalogue, never restated here.

    A benchmark that named a model without naming the artifact it ran is not reproducible: two
    `yolox-nano` files with different weights produce different numbers under one name.
    """
    out = []
    for model in models:
        out.append(
            {
                "modelId": getattr(model, "id", ""),
                "version": getattr(model, "version", ""),
                "family": getattr(model, "family", ""),
                "artifact": getattr(model, "artifact", ""),
                # ⭐ **Verified, not transcribed.** The digest is computed from the artifact on disk
                # (see `_verified_sha`), so this column says "the bytes we ran" rather than "the
                # bytes the catalogue claims". A benchmark quoting a registered checksum it never
                # checked would survive an artifact swap without noticing.
                "sha256": _verified_sha(store, model),
                "sizeBytes": getattr(model, "size_bytes", None),
                "license": getattr(model, "license", None),
                "licenseHolder": getattr(model, "license_holder", None),
                "source": getattr(model, "source", None),
                "trainedOn": getattr(model, "trained_on", None),
                "status": getattr(model, "status", ""),
                "input": _input_of(model),
                "outputFormat": getattr(model, "output_format", ""),
            }
        )
    return out


def _verified_sha(store, model) -> Optional[str]:  # noqa: ANN001
    """The digest of the bytes on disk, or a reported failure — ⛔ never the catalogue's claim.

    ⚠️ `ModelStore.verify` returns the artifact **path**, not the digest: it re-hashes the file and
    *raises* on a mismatch. Publishing its return value put a path in the checksum column of the
    first run — the check had passed, but the artifact the column named was unverifiable. So the
    digest is computed here, and only after `verify` has vouched for it.
    """
    from model_store import sha256_file  # noqa: WPS433 - matches the lazy import in `main`

    if store is None:
        return None
    try:
        path = store.verify(model)  # raises unless the file matches its registered checksum
        return sha256_file(path)
    except Exception as exc:  # noqa: BLE001 - a failed verification is a REPORTED fact
        return f"UNVERIFIED: {type(exc).__name__}"


def _input_of(model: object) -> dict:
    spec = getattr(model, "input", None)
    if spec is None:
        return {}
    return {
        "width": getattr(spec, "width", None),
        "height": getattr(spec, "height", None),
        "resize": getattr(spec, "resize", None),
        "colorOrder": getattr(spec, "color_order", None),
    }


# --- the cell runner --------------------------------------------------------------------------


def _probe_fps(path: str, *, fallback: float = 15.0) -> float:
    """The clip's declared frame rate. ⚠️ `fallback` only when the container declares none — which
    is a fact about the file, and one the row's `detail` should eventually carry."""
    try:
        import cv2  # noqa: WPS433 - already a dependency of the decoder

        capture = cv2.VideoCapture(path)
        try:
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        finally:
            capture.release()
        return fps if fps > 0 else fallback
    except Exception:  # noqa: BLE001
        return fallback


def _peak_rss_mib() -> float:
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # ⚠️ Linux reports KiB, macOS bytes. Getting this wrong by 1024× would be very visible, which is
    # the only reason it is safe to branch on the platform rather than measure it.
    return round(usage / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


class TimedAdapter:
    """Records how long each `infer()` took — ⭐ the only place per-frame latency can be observed.

    ⛔ The runtime does not retain it. `StageTimings.inference_ms` is *cumulative* across the run and
    `FrameAnalysis` carries frame metadata only, so an average is recoverable from a completed run
    but a distribution is not. The first benchmark asked `FrameAnalysis` for `.timings`, got nothing
    for every frame, and published an empty latency column beside a populated FPS column.

    ⚠️ Timing here rather than reimplementing `VideoAnalyzer.analyze` is deliberate: the adapter is
    the seam the benchmark already owns (`PinnedModelAdapter` wraps it for exactly this reason), so
    the measured pipeline stays the deployed one. It also measures *inference alone* — decode,
    preprocess and postprocess are excluded, which is what the column claims.
    """

    def __init__(self, inner: object) -> None:
        self._inner = inner
        self.samples: List[float] = []

    @property
    def execution_provider(self) -> str:
        return getattr(self._inner, "execution_provider", "unknown")

    def load(self, ref=None) -> None:  # noqa: ANN001
        self._inner.load(ref)  # type: ignore[attr-defined]

    def preprocess(self, ctx: object) -> object:
        return self._inner.preprocess(ctx)  # type: ignore[attr-defined]

    def infer(self, prepared: object) -> object:
        started = time.perf_counter()
        try:
            return self._inner.infer(prepared)  # type: ignore[attr-defined]
        finally:
            self.samples.append((time.perf_counter() - started) * 1000.0)

    def unload(self) -> None:
        self._inner.unload()  # type: ignore[attr-defined]


def _percentile(values: Sequence[float], fraction: float) -> Optional[float]:
    """Nearest-rank percentile. ⚠️ Returns None below 20 samples rather than a p95 drawn from five
    frames, which is a maximum wearing a percentile's name."""
    if len(values) < 20:
        return None
    ordered = sorted(values)
    # Nearest-rank: rank = ceil(fraction × N), 1-indexed. ⚠️ `round(f×N + 0.5)` is NOT that — it
    # lands one element high on exact multiples (p95 of 1..100 gave 96.0, not 95.0).
    index = min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))
    return round(ordered[index], 3)


def _score_case(
    scores: Dict[str, object],
    case: bc.BenchmarkCase,
    model_id: str,
    frames: Sequence[object],
    target_fps: float,
    fixtures_root: str,
    real_root: str,
) -> None:
    """Score one cell against its Tier-1 ground truth — ⛔ or record precisely why it was not.

    ⚠️ A refusal is **stored**, never dropped. "This clip has no accuracy number" and "this clip's
    annotations did not match its pixels" look identical in a report that omits both, and the second
    is a defect somebody has to fix.
    """
    import annotations as ann  # noqa: WPS433 - only needed when ground truth actually exists
    import detection_scoring as ds  # noqa: WPS433

    key = f"{model_id}::{case.case_id}"
    path = os.path.join(bc.root_for(case, fixtures_root, real_root), case.ground_truth or "")
    try:
        truth = ann.load(path)
    except ann.AnnotationError as exc:
        scores[key] = {"caseId": case.case_id, "modelId": model_id, "refused": str(exc)}
        return

    alignment = ann.align(
        truth,
        case_id=case.case_id,
        clip_sha256=case.sha256 or "",
        sampled_fps=target_fps,
        analysed_frames=len(frames),
    )
    if not alignment.aligned:
        scores[key] = {
            "caseId": case.case_id,
            "modelId": model_id,
            "refused": "; ".join(alignment.problems),
        }
        return

    predictions: Dict[int, List[ds.Prediction]] = {}
    for index, frame in enumerate(frames):
        predictions[index] = [
            ds.Prediction(
                label=str(d.get("label") or ""),
                bbox=tuple(float(v) for v in (d.get("bbox") or (0.0, 0.0, 0.0, 0.0))),
                confidence=float(d.get("confidence") or 0.0),
            )
            for d in (getattr(frame, "detections", None) or [])
            if d.get("bbox")
        ]
    scored = ds.score(truth, predictions)
    scores[key] = {"modelId": model_id, **scored.to_dict(), "identityProblems": list(ann.identity_problems(truth))}


def make_cell_runner(
    *,
    store,  # noqa: ANN001 - ModelStore
    corpus: bc.Corpus,
    fixtures_root: str,
    real_root: str,
    artifact_dir: str,
    tenant_id: str = "tnt_benchmark",
    target_fps: float = TARGET_FPS,
    scores: Optional[Dict[str, object]] = None,
):
    """Build the `run_cell` that `detector_benchmark.run_matrix` injects.

    ⭐ **The production pipeline, unmodified.** A case runs through `VideoAnalyzer` with a
    `PinnedModelAdapter` — the wrapper `detector_benchmark.py` already provides precisely so the
    benchmark needs no runtime change. Preprocessing, decoding, tracking and behaviour are the
    deployed code paths; a harness that reimplemented any of them would be measuring itself.
    """
    from adapters.onnx_adapter import OnnxModelAdapter  # noqa: WPS433 - heavy, and optional
    from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: WPS433
    from video_decoder import OpenCvFrameDecoder  # noqa: WPS433
    from video_sampler import FrameSampler  # noqa: WPS433

    def run_cell(model_id: str, case_id: str) -> db.DetectorRun:
        case = corpus.by_id(case_id)
        # ⭐ Provenance chooses the tree: real footage never lives among the committed fixtures.
        path = os.path.join(bc.root_for(case, fixtures_root, real_root), case.path)
        common = {
            "model_id": model_id,
            "case_id": case_id,
            "category": case.category,
            "scene_tags": tuple(case.scene_tags) + (case.footage_kind,),
        }
        if not os.path.isfile(path):
            # ⚠️ Recorded, never dropped. Omission is how a detector's hard cases vanish.
            return db.DetectorRun(**common, status="skipped", detail=f"missing clip {case.path}")

        try:
            model = store.get(model_id)
            if model is None:
                return db.DetectorRun(**common, status="error", detail=f"no catalogue entry '{model_id}'")
        except Exception as exc:  # noqa: BLE001
            return db.DetectorRun(**common, status="error", detail=f"catalogue: {exc}"[:200])

        labels = list(getattr(model, "labels", []) or [])
        ref = db.model_ref(model, artifact_dir, labels)
        timed_adapter = TimedAdapter(OnnxModelAdapter())
        adapter = db.PinnedModelAdapter(timed_adapter, ref)
        options = AnalyzeOptions(
            tenant_id=tenant_id,
            camera_id=f"cam_bench_{case_id}",
            model=model_id,
            model_version=str(getattr(model, "version", "")),
            engine="onnx",
            labels=labels,
            capability_id="benchmark.detect",
            # ⚠️ The production floor, so a row describes what the platform would have admitted —
            # not what the raw model emitted. A benchmark at score 0.05 measures a decoder.
            min_confidence=0.5,
            correlation_id=f"bench_{model_id}_{case_id}",
            session_id=f"sess_bench_{case_id}",
            target_fps=target_fps,
        )

        started = time.perf_counter()
        # ⚠️ CPU is measured as a DELTA across the case, not as a snapshot: `getrusage` is cumulative
        # for the process, so the absolute value after case 12 says nothing about case 12.
        cpu_before = resource.getrusage(resource.RUSAGE_SELF)
        try:
            analyzer = VideoAnalyzer(adapter, options)
            decoder = OpenCvFrameDecoder(path)
            # ⛔ **The clip's OWN frame rate, probed, never assumed.** `FrameSampler` derives its
            # stride as `source_fps / target_fps`, so a wrong source rate silently changes how many
            # frames a case contributes — and the corpus deliberately holds clips at 1, 15 and 30 fps.
            # Assuming 15 would sample the 1 fps clip 15× too sparsely and read as a fast detector.
            result = analyzer.analyze(
                decoder, FrameSampler(source_fps=_probe_fps(path), target_fps=target_fps)
            )
        except Exception as exc:  # noqa: BLE001 - a detector that falls over is a RESULT
            return db.DetectorRun(**common, status="error", detail=f"{type(exc).__name__}: {exc}"[:200])
        finally:
            try:
                adapter.unload()
            except Exception:  # noqa: BLE001
                pass
        wall = time.perf_counter() - started
        cpu_after = resource.getrusage(resource.RUSAGE_SELF)
        cpu_seconds = (cpu_after.ru_utime - cpu_before.ru_utime) + (cpu_after.ru_stime - cpu_before.ru_stime)
        # ⭐ Can exceed 100 %: onnxruntime is multi-threaded, so 380 % means it used ~3.8 cores. That
        # is the honest reading and the one that matters for sizing — a detector that is fast only
        # because it consumed the whole host is not fast on a host with four cameras on it.
        cpu_percent = round(cpu_seconds / wall * 100.0, 1) if wall > 0 else None

        frames = list(result.frames)
        timed = frames[WARMUP_FRAMES:] if len(frames) > WARMUP_FRAMES else []
        # ⛔ Scoring uses **every** sampled frame, not `timed`. Warm-up frames are excluded from the
        # latency samples but they are still analysed and still produce detections; scoring the
        # trimmed list would align annotation 0 against sampled frame 3 and shift every box by three
        # frames — a silent, plausible collapse in both precision and recall.
        if scores is not None and case.ground_truth:
            _score_case(scores, case, model_id, frames, target_fps, fixtures_root, real_root)
        # ⚠️ Warm-up is dropped from the LATENCY samples by the same index, so the discarded frames
        # are the discarded measurements — one `WARMUP_FRAMES` governing both.
        inference = timed_adapter.samples[WARMUP_FRAMES:] if len(frames) > WARMUP_FRAMES else []
        detections = sum(len(getattr(f, "detections", []) or []) for f in timed)
        return db.DetectorRun(
            **common,
            status="ok",
            frames=len(timed),
            detections=detections,
            # ⭐ `diagnostics()` — active **plus archived** tracks, so a subject that left the frame
            # still counts as a track this detector produced. `tracking_stats` has no "created" key;
            # asking it for one returned 0 for every cell of the first matrix.
            tracks_created=len(result.tracks or []),
            # ⛔ Left at 0 and NOT reported as a measurement. The runtime emits no reassignment
            # counter, and cannot: `tracking_contracts` states the trackId is never reused, because
            # re-entry is modelled as a link rather than a reassignment. Track diagnostics carry no
            # `identityId` at this tier either, so even the proxy is unavailable. See the report.
            events=len(result.events or []),
            inference_ms_avg=round(sum(inference) / len(inference), 3) if inference else None,
            inference_ms_p95=_percentile(inference, 0.95),
            wall_seconds=round(wall, 3),
            peak_rss_mib=_peak_rss_mib(),
            cpu_percent_avg=cpu_percent,
        )

    return run_cell


# --- reporting --------------------------------------------------------------------------------


def render_report(
    summary: dict,
    corpus: bc.Corpus,
    rows: Sequence[bc.ScenarioCoverage],
    models: List[dict],
    scores: Optional[Mapping[str, object]] = None,
) -> str:
    """`DETECTOR_BENCHMARK.md` — the observational report, with its ceiling stated first."""
    counts = bc.coverage_counts(rows)
    out: List[str] = ["# Detector benchmark — observational report", ""]
    out.append(f"**{summary.get('at', '—')}** · corpus `{corpus.version}`")
    out.append("")
    # ⛔ **Every clause below is computed from the corpus, never asserted.** The first version of this
    # banner hardcoded "every case in this corpus is authored or photographic" beside a coverage
    # count that was computed — so the first real-footage run printed the two contradicting each
    # other in one sentence. A report that describes a corpus it did not read is the defect this
    # whole module exists to prevent.
    kinds = corpus.kinds()
    real = kinds.get("REAL_FOOTAGE", 0)
    total = len(corpus.cases)
    out.append("> ⛔ **THIS REPORT DOES NOT NAME A WINNER, AND CANNOT.**")
    out.append("> ")
    if real == 0:
        provenance_clause = (
            "Every case in this corpus is authored or photographic, so these numbers describe how "
            "each detector handles *this corpus* — not how it handles people."
        )
    else:
        constructed = total - real
        provenance_clause = (
            f"{real} of {total} case(s) are real footage"
            + (f" and {constructed} are constructed" if constructed else "")
            + ". ⛔ A detector comparison still may not be settled here: the scenarios below that "
            "remain PARTIAL or MISSING have no real evidence at all, and no case carries ground "
            "truth, so nothing separates a detector that found more people from one that found "
            "more false positives."
        )
    out.append(
        f"> {counts['AVAILABLE']} of {len(rows)} required scenarios are covered by real footage. "
        f"{provenance_clause} See `CORPUS_COVERAGE.md`."
    )
    out.append("> ")
    out.append(
        "> ⛔ **Every metric below is OBSERVATIONAL, not an accuracy metric.** No case carries "
        "ground truth, so precision, recall, false-positive/negative rates, IoU and mAP are absent "
        "rather than estimated. A detection count is not an accuracy: more detections per frame may "
        "mean finding people or finding coat racks, and nothing here separates the two."
        if not corpus.has_any_ground_truth
        else "> ⚠️ **Accuracy metrics are permitted only for cases carrying ground truth.** Every "
        "other number here remains observational."
    )
    out.append("")
    out.append("## Model provenance")
    out.append("")
    out.append("| Model | Version | Licence | Artifact | sha256 | Input | Status |")
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for m in models:
        spec = m.get("input") or {}
        dims = f"{spec.get('width')}×{spec.get('height')} {spec.get('resize')}" if spec else "—"
        sha = (m.get("sha256") or "—")[:12]
        out.append(
            f"| `{m['modelId']}` | {m.get('version') or '—'} | {m.get('license') or '—'} | "
            f"{m.get('artifact') or '—'} | `{sha}…` | {dims} | {m.get('status') or '—'} |"
        )
    out.append("")
    out.append(
        "⚠️ The checksum is the identity of the measurement. Two artifacts under one model id "
        "produce different numbers, and only this column distinguishes them."
    )
    out.append("")
    out.append(db.render_summary(summary))
    out.append(_render_accuracy(scores or {}))
    return "\n".join(out)


def _render_accuracy(scores: Mapping[str, object]) -> str:
    """The accuracy section — ⛔ absent entirely when nothing is annotated, never zeroed.

    ⚠️ Refusals are printed rather than dropped. "This clip has no accuracy number" and "this clip's
    annotations did not describe its pixels" look identical in a report that omits both, and only the
    second is somebody's bug to fix.
    """
    import detection_scoring as ds  # noqa: WPS433 - only when ground truth exists

    if not scores:
        return ""
    measured: List = []
    refused: List[tuple] = []
    for key, value in sorted(scores.items()):
        row = dict(value)  # type: ignore[arg-type]
        if row.get("refused"):
            refused.append((key, row["refused"]))
        else:
            measured.append((row.get("modelId", "?"), row))

    lines: List[str] = []
    if measured:
        lines.append("## Accuracy — measured against Tier-1 ground truth")
        lines.append("")
        first = measured[0][1]
        lines.append(
            f"⚠️ IoU threshold **{first.get('iouThreshold')}**, class-aware, greedy by descending "
            f"confidence (the COCO convention). Precision at 0.5 and at 0.75 are different numbers."
        )
        lines.append("")
        lines.append("| Detector | Case | Frames | TP | FP | FN | Precision | Recall | F1 | Mean IoU |")
        lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for model_id, row in measured:
            lines.append(
                f"| `{model_id}` | `{row.get('caseId')}` | {row.get('framesScored')} | "
                f"{row.get('truePositives')} | {row.get('falsePositives')} | "
                f"{row.get('falseNegatives')} | {ds._num(row.get('precision'))} | "
                f"{ds._num(row.get('recall'))} | {ds._num(row.get('f1'))} | "
                f"{ds._num(row.get('meanIou'))} |"
            )
        lines.append("")
        lines.append("### Per class")
        lines.append("")
        lines.append("| Detector | Case | Class | TP | FP | FN | Precision | Recall | Mean IoU |")
        lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for model_id, row in measured:
            for c in row.get("perClass", []):
                lines.append(
                    f"| `{model_id}` | `{row.get('caseId')}` | `{c['label']}` | "
                    f"{c['truePositives']} | {c['falsePositives']} | {c['falseNegatives']} | "
                    f"{ds._num(c['precision'])} | {ds._num(c['recall'])} | {ds._num(c['meanIou'])} |"
                )
        lines.append("")
        lines.append(
            "⚠️ A blank precision means nothing was predicted for that class; a blank recall means "
            "the class does not appear in the ground truth. ⛔ Neither is a zero."
        )
    if refused:
        lines.append("")
        lines.append("### ⛔ Annotations that could not score a run")
        lines.append("")
        for key, why in refused:
            lines.append(f"- `{key}` — {why}")
        lines.append("")
        lines.append(
            "⚠️ These are **not** absent measurements. Ground truth that does not describe the "
            "pixels, the instants or the frames of the run it is compared against produces a "
            "plausible wrong number, which is why it is refused rather than approximated."
        )
    return "\n".join(lines)


# --- CLI --------------------------------------------------------------------------------------


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Detector benchmark matrix over the declared corpus")
    parser.add_argument("--corpus", default=DEFAULT_CORPUS)
    parser.add_argument("--fixtures", default=os.environ.get("VIP_FIXTURES_DIR", DEFAULT_FIXTURES))
    parser.add_argument("--artifacts", default=os.environ.get("VIP_MODEL_DIR", DEFAULT_ARTIFACTS))
    parser.add_argument(
        "--real-root",
        default=os.environ.get(bc.REAL_ROOT_ENV, bc.DEFAULT_REAL_ROOT),
        help="where REAL_FOOTAGE clips live — ⛔ outside the repository, by convention",
    )
    parser.add_argument("--models", default="", help="comma-separated model ids; default every catalogue entry")
    parser.add_argument("--cases", default="", help="comma-separated case ids; default the whole corpus")
    parser.add_argument("--out", default="", help="directory for matrix.json and the reports")
    parser.add_argument("--coverage-only", action="store_true", help="report what the corpus can answer, run nothing")
    parser.add_argument("--list-models", action="store_true")
    parser.add_argument("--host-contended", action="store_true", help="declare the host was busy")
    parser.add_argument(
        "--git-sha",
        default=os.environ.get("VIP_GIT_SHA", ""),
        help="the commit under measurement; ⚠️ required for a reproducible run inside the image, "
        "which has no work tree and would otherwise record 'unknown'",
    )
    parser.add_argument("--target-fps", type=float, default=TARGET_FPS, help="sampling rate (production is 2)")
    parser.add_argument("--allow-uneven", action="store_true", help="⛔ aggregate anyway; records why")
    args = parser.parse_args(argv)

    try:
        corpus = bc.load(args.corpus, root=args.fixtures, real_root=args.real_root)
    except bc.CorpusError as exc:
        print(f"⛔ corpus: {exc}", file=sys.stderr)
        return 2
    rows = bc.coverage(corpus)

    if args.coverage_only:
        text = bc.render_coverage(corpus, rows)
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, "CORPUS_COVERAGE.md"), "w", encoding="utf-8") as h:
                h.write(text)
        print(text)
        return 0

    from model_store import ModelStore  # noqa: WPS433 - heavy

    store = ModelStore.load(artifact_dir=args.artifacts)
    available = store.all()
    if args.list_models:
        for m in available:
            print(f"{getattr(m, 'id', '?'):<16} {getattr(m, 'status', '?'):<9} {getattr(m, 'license', '?')}")
        return 0

    wanted = [s.strip() for s in args.models.split(",") if s.strip()] or [getattr(m, "id", "") for m in available]
    models = [m for m in available if getattr(m, "id", "") in wanted]
    if not models:
        print(f"⛔ none of {wanted} are in the catalogue", file=sys.stderr)
        return 2
    case_ids = [s.strip() for s in args.cases.split(",") if s.strip()] or corpus.case_ids()

    print(f"corpus  {corpus.version} · {len(case_ids)} case(s) · kinds {corpus.kinds()}")
    print(f"models  {', '.join(getattr(m, 'id', '?') for m in models)}")
    print(f"⚠️  {bc.coverage_counts(rows)['AVAILABLE']} scenario(s) covered by real footage\n")

    # ⛔ Populated only by cases that declare ground truth. An empty dict means no accuracy section
    # is rendered at all — absent, not zeroed.
    scores: Dict[str, object] = {}
    runner = make_cell_runner(
        store=store,
        corpus=corpus,
        fixtures_root=args.fixtures,
        real_root=args.real_root,
        artifact_dir=args.artifacts,
        target_fps=args.target_fps,
        scores=scores,
    )

    def traced(model_id: str, case_id: str) -> db.DetectorRun:
        row = runner(model_id, case_id)
        mark = {"ok": "✓", "skipped": "-", "error": "⛔", "timeout": "⏱"}[row.status]
        print(f"  {mark} {model_id:<16} {case_id:<26} {row.status:<8} {row.detail or ''}")
        return row

    matrix = db.run_matrix(
        model_ids=[getattr(m, "id", "") for m in models],
        case_ids=case_ids,
        run_cell=traced,
        corpus_version=corpus.version,
        environment={
            **environment(contended=args.host_contended, git_sha=args.git_sha),
            "targetFps": args.target_fps,
        },
    )

    try:
        summary = db.summarise(matrix, require_even=not args.allow_uneven)
    except db.UnevenMatrix as exc:
        # ⛔ The guard firing is a RESULT, and the exit code says so. Aggregating anyway is possible
        # and requires an explicit flag, because "the detector that crashed on the hard clips posted
        # the best averages" is a headline nobody would question.
        print(f"\n⛔ {exc}", file=sys.stderr)
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, "matrix.json"), "w", encoding="utf-8") as h:
                json.dump(matrix.to_dict(), h, indent=2)
            print(f"matrix written to {args.out}/matrix.json — the rows are readable", file=sys.stderr)
        return 3

    prov = provenance(models, store)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "matrix.json"), "w", encoding="utf-8") as h:
            json.dump({**matrix.to_dict(), "provenance": prov, "coverage": [r.to_dict() for r in rows],
                       "accuracy": scores}, h, indent=2)
        with open(os.path.join(args.out, "DETECTOR_BENCHMARK.md"), "w", encoding="utf-8") as h:
            h.write(render_report(summary, corpus, rows, prov, scores))
        with open(os.path.join(args.out, "CORPUS_COVERAGE.md"), "w", encoding="utf-8") as h:
            h.write(bc.render_coverage(corpus, rows))
        print(f"\nwrote {args.out}/matrix.json, DETECTOR_BENCHMARK.md, CORPUS_COVERAGE.md")
    else:
        print()
        print(render_report(summary, corpus, rows, prov, scores))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
