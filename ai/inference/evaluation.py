"""Accuracy evaluation against recorded CCTV footage (AI-5e, Architect priority 1).

**The distinction this module exists to hold.** Every benchmark the platform has is *operational*: it
measures fps, latency, drops. None of them can tell you whether the system saw the shoplifter. This
module measures the other thing — did the expected behaviour appear, in the expected window, and did
the ones we asserted must NOT appear stay away.

**Both directions are scored, deliberately.** In surveillance analytics, false positives are the
failure mode that loses a deployment: an operator who is paged four times a night for nothing stops
reading the alerts by Thursday, and the system is then worse than useless because it also stopped
them watching. So a `DatasetCase` can assert absence as directly as presence, and `unexpected` counts
against precision exactly as `missing` counts against recall.

**What it refuses to do.** It never scores itself against an output the AI runtime does not produce.
A case may declare the incident a rule *should* raise — the corpus describes the whole platform — but
incidents belong to the rules service, so those expectations are recorded as `deferred` and excluded
from precision/recall rather than being quietly counted as either wins or losses.

**And it never passes on absent footage.** `footage-missing` is its own status. In CI, where the DVC
bytes are not pulled, a run reports every case as skipped and `accepted` is false. That is the
correct, uncomfortable answer, and making it comfortable would defeat the purpose of the corpus.

Stdlib-only at import time; real-video decoding is a lazy OpenCV path, exactly as the playground does it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from dataset import DatasetCase, Expectation

EVALUATION_STATUSES = ("pass", "fail", "footage-missing", "error")
EVALUATION_OUTCOMES = ("match", "missing", "unexpected", "out-of-tolerance", "deferred")

#: Expectation kinds this evaluator can judge. `incident` is deliberately absent — see the module
#: docstring. Adding it here without a rules-engine integration would be scoring a coin flip.
JUDGED_KINDS = ("detection", "track", "behavior", "composite", "event")


@dataclass(frozen=True)
class Finding:
    """One expectation, judged."""

    kind: str
    type: str
    outcome: str
    expected_count: Optional[int] = None
    observed_count: int = 0
    window: Optional[str] = None
    observed_at_seconds: Optional[float] = None
    detail: Optional[str] = None

    @property
    def counts_as_true_positive(self) -> bool:
        return self.outcome == "match" and self.expected_count != 0

    def to_dict(self) -> dict:
        out: dict = {
            "kind": self.kind,
            "type": self.type,
            "outcome": self.outcome,
            "observedCount": self.observed_count,
        }
        for key, value in (
            ("expectedCount", self.expected_count),
            ("window", self.window),
            ("observedAtSeconds", self.observed_at_seconds),
            ("detail", self.detail),
        ):
            if value is not None:
                out[key] = value
        return out


@dataclass
class EvaluationReport:
    """One case's result."""

    id: str
    case_id: str
    category: str
    status: str
    runtime_version: str = "1.0.0"
    model: Optional[str] = None
    engine: Optional[str] = None
    findings: List[Finding] = field(default_factory=list)
    frames_processed: int = 0
    duration_seconds: float = 0.0
    evidence_class: str = "recorded-footage"
    recorded_at: Optional[str] = None
    notes: Optional[str] = None

    # --- accuracy ---------------------------------------------------------

    @property
    def true_positives(self) -> int:
        return sum(1 for f in self.findings if f.outcome == "match" and f.expected_count != 0)

    @property
    def false_negatives(self) -> int:
        return sum(1 for f in self.findings if f.outcome in ("missing", "out-of-tolerance"))

    @property
    def false_positives(self) -> int:
        return sum(1 for f in self.findings if f.outcome == "unexpected")

    @property
    def precision(self) -> Optional[float]:
        denom = self.true_positives + self.false_positives
        return None if denom == 0 else round(self.true_positives / denom, 4)

    @property
    def recall(self) -> Optional[float]:
        denom = self.true_positives + self.false_negatives
        return None if denom == 0 else round(self.true_positives / denom, 4)

    @property
    def f1(self) -> Optional[float]:
        p, r = self.precision, self.recall
        if p is None or r is None or (p + r) == 0:
            return None
        return round(2 * p * r / (p + r), 4)

    @property
    def deferred(self) -> List[Finding]:
        return [f for f in self.findings if f.outcome == "deferred"]

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "caseId": self.case_id,
            "category": self.category,
            "status": self.status,
            "runtimeVersion": self.runtime_version,
            "findings": [f.to_dict() for f in self.findings],
            "truePositives": self.true_positives,
            "falseNegatives": self.false_negatives,
            "falsePositives": self.false_positives,
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "framesProcessed": self.frames_processed,
            "durationSeconds": round(self.duration_seconds, 4),
            "evidenceClass": self.evidence_class,
            "recordedAt": self.recorded_at or _now_iso(),
        }
        for key, value in (("model", self.model), ("engine", self.engine), ("notes", self.notes)):
            if value:
                out[key] = value
        return out


# --- observation extraction -----------------------------------------------------


@dataclass(frozen=True)
class Occurrence:
    """One thing the pipeline produced, reduced to what an expectation cares about."""

    kind: str
    type: str
    seconds: Optional[float]
    confidence: Optional[float]
    zone_id: Optional[str]


def occurrences(result, *, effective_fps: Optional[float] = None) -> List[Occurrence]:  # noqa: ANN001
    """Flatten an `AnalyzeResult` into comparable occurrences.

    Timestamps come from the per-frame view, which is the only place a frame index and a wall position
    coexist. Behaviours are counted **once per behaviorId at their first appearance**, not once per
    frame: a 19-second loiter emits a `BehaviorResult` on every frame it is active, and counting those
    as 190 loiterings would make every temporal expectation meaningless.
    """
    out: List[Occurrence] = []
    seen_behaviors: set = set()
    seen_tracks: set = set()
    for fa in getattr(result, "frames", []) or []:
        seconds = _frame_seconds(fa.frame, effective_fps)
        for det in fa.detections:
            out.append(
                Occurrence(
                    kind="detection",
                    type=str(det.get("label") or "object"),
                    seconds=seconds,
                    confidence=_opt_float(det.get("confidence")),
                    zone_id=None,
                )
            )
        for track in fa.tracks:
            key = track.get("trackId")
            if key in seen_tracks:
                continue
            seen_tracks.add(key)
            out.append(
                Occurrence(
                    kind="track",
                    type=str(track.get("label") or "track"),
                    seconds=seconds,
                    confidence=_opt_float(track.get("confidence")),
                    zone_id=track.get("zoneId"),
                )
            )
        for source, kind in ((fa.behaviors, "behavior"), (fa.composites, "composite")):
            for item in source:
                key = (kind, item.get("behaviorId"))
                if key in seen_behaviors:
                    continue
                seen_behaviors.add(key)
                out.append(
                    Occurrence(
                        kind=kind,
                        type=str(item.get("behaviorType") or "behavior"),
                        seconds=seconds,
                        confidence=_opt_float(item.get("confidence")),
                        zone_id=item.get("zoneId"),
                    )
                )
        for event in fa.events:
            out.append(
                Occurrence(
                    kind="event",
                    type=str(event.get("type") or event.get("eventType") or "event"),
                    seconds=seconds,
                    confidence=None,
                    zone_id=None,
                )
            )
    return out


def matches(expectation: Expectation, found: Sequence[Occurrence]) -> List[Occurrence]:
    """Occurrences satisfying an expectation's type, window, zone and confidence floor."""
    out = []
    for occ in found:
        if occ.kind != expectation.kind or occ.type != expectation.type:
            continue
        if not expectation.within(occ.seconds):
            continue
        if expectation.zone_id and occ.zone_id and occ.zone_id != expectation.zone_id:
            continue
        if (
            expectation.min_confidence is not None
            and occ.confidence is not None
            and occ.confidence < expectation.min_confidence
        ):
            continue
        out.append(occ)
    return out


def judge(case: DatasetCase, found: Sequence[Occurrence]) -> List[Finding]:
    """Score every expectation in a case against what the pipeline produced."""
    findings: List[Finding] = []
    for expectation in case.expectations:
        if expectation.kind not in JUDGED_KINDS:
            findings.append(
                Finding(
                    kind=expectation.kind,
                    type=expectation.type,
                    outcome="deferred",
                    expected_count=expectation.count,
                    window=expectation.window,
                    detail=(
                        f"'{expectation.kind}' is produced by the rules service, not the AI runtime; "
                        "recorded but excluded from precision/recall"
                    ),
                )
            )
            continue
        hits = matches(expectation, found)
        observed = len(hits)
        first_at = next((h.seconds for h in hits if h.seconds is not None), None)
        if expectation.absent:
            outcome = "match" if observed == 0 else "unexpected"
            detail = None if observed == 0 else f"asserted absent but produced {observed} time(s)"
        elif expectation.satisfied_by(observed):
            outcome, detail = "match", None
        elif observed == 0:
            outcome, detail = "missing", "expected but never produced"
        else:
            target = 1 if expectation.count is None else expectation.count
            outcome = "out-of-tolerance"
            detail = f"expected {target}±{expectation.count_tolerance}, produced {observed}"
        findings.append(
            Finding(
                kind=expectation.kind,
                type=expectation.type,
                outcome=outcome,
                expected_count=0 if expectation.absent else expectation.count,
                observed_count=observed,
                window=expectation.window,
                observed_at_seconds=first_at,
                detail=detail,
            )
        )
    return findings


def evaluate(
    case: DatasetCase,
    result,  # noqa: ANN001 - AnalyzeResult
    *,
    runtime_version: str = "1.0.0",
    evidence_class: str = "recorded-footage",
    effective_fps: Optional[float] = None,
    now_iso: Callable[[], str] = None,  # noqa: ANN001
) -> EvaluationReport:
    """Judge one analysed case. `status` is `pass` only when nothing missed and nothing false-fired."""
    stamp = now_iso or _now_iso
    found = occurrences(result, effective_fps=effective_fps)
    findings = judge(case, found)
    summary = getattr(result, "summary", {}) or {}
    failed = any(f.outcome in ("missing", "unexpected", "out-of-tolerance") for f in findings)
    report = EvaluationReport(
        id=f"eval_{_slug(case.id)}",
        case_id=case.id,
        category=case.category,
        status="fail" if failed else "pass",
        runtime_version=runtime_version,
        model=(summary.get("model") or {}).get("name"),
        engine=summary.get("engine"),
        findings=findings,
        frames_processed=int(summary.get("framesSampled") or len(getattr(result, "frames", []) or [])),
        duration_seconds=float(case.footage.duration_seconds or 0.0),
        evidence_class=evidence_class,
        recorded_at=stamp(),
    )
    deferred = len(report.deferred)
    if deferred:
        report.notes = f"{deferred} expectation(s) deferred to the rules service"
    return report


def skipped_report(
    case: DatasetCase,
    *,
    runtime_version: str = "1.0.0",
    reason: str = "footage not available on this machine",
    now_iso: Callable[[], str] = None,  # noqa: ANN001
) -> EvaluationReport:
    """The report for a case whose footage is not present. **Not a pass** — see the module docstring."""
    stamp = now_iso or _now_iso
    return EvaluationReport(
        id=f"eval_{_slug(case.id)}",
        case_id=case.id,
        category=case.category,
        status="footage-missing",
        runtime_version=runtime_version,
        recorded_at=stamp(),
        notes=f"{reason}: {case.footage.path}",
    )


def error_report(
    case: DatasetCase,
    exc: BaseException,
    *,
    runtime_version: str = "1.0.0",
    now_iso: Callable[[], str] = None,  # noqa: ANN001
) -> EvaluationReport:
    stamp = now_iso or _now_iso
    return EvaluationReport(
        id=f"eval_{_slug(case.id)}",
        case_id=case.id,
        category=case.category,
        status="error",
        runtime_version=runtime_version,
        recorded_at=stamp(),
        notes=f"{type(exc).__name__}: {exc}"[:2000],
    )


# --- aggregation + regression ---------------------------------------------------


def summarize(
    reports: Sequence[EvaluationReport],
    *,
    baseline: Optional[Sequence[EvaluationReport]] = None,
    runtime_version: str = "1.0.0",
    summary_id: Optional[str] = None,
    now_iso: Callable[[], str] = None,  # noqa: ANN001
) -> dict:
    """Aggregate an evaluation run and compare it against an accepted accuracy baseline.

    `accepted` is the gate, and it is deliberately hard to satisfy: no failures, no errors, no
    regressions, and **at least one case actually evaluated**. Without that last clause a machine with
    no footage would produce a green summary, which is precisely the false assurance this whole
    milestone is built to avoid.
    """
    stamp = now_iso or _now_iso
    by_id = {r.case_id: r for r in baseline or []}
    improved: List[str] = []
    regressed: List[str] = []
    for report in reports:
        prior = by_id.get(report.case_id)
        if prior is None or prior.status == "footage-missing" or report.status == "footage-missing":
            continue
        now_f1, was_f1 = report.f1, prior.f1
        if now_f1 is None or was_f1 is None:
            # Fall back to status when F1 is undefined (a case of only-negative expectations scores
            # no positives, so its F1 is legitimately None but its status is still meaningful).
            if prior.status == "pass" and report.status != "pass":
                regressed.append(report.case_id)
            elif prior.status != "pass" and report.status == "pass":
                improved.append(report.case_id)
            continue
        if now_f1 < was_f1:
            regressed.append(report.case_id)
        elif now_f1 > was_f1:
            improved.append(report.case_id)

    passed = sum(1 for r in reports if r.status == "pass")
    failed = sum(1 for r in reports if r.status in ("fail", "error"))
    skipped = sum(1 for r in reports if r.status == "footage-missing")
    evaluated = [r for r in reports if r.status in ("pass", "fail")]
    tp = sum(r.true_positives for r in evaluated)
    fn = sum(r.false_negatives for r in evaluated)
    fp = sum(r.false_positives for r in evaluated)
    by_category: Dict[str, Dict[str, float]] = {}
    for report in reports:
        bucket = by_category.setdefault(
            report.category, {"cases": 0, "passed": 0, "failed": 0, "skipped": 0}
        )
        bucket["cases"] += 1
        if report.status == "pass":
            bucket["passed"] += 1
        elif report.status == "footage-missing":
            bucket["skipped"] += 1
        else:
            bucket["failed"] += 1

    precision = _ratio(tp, tp + fp)
    recall = _ratio(tp, tp + fn)
    f1 = None
    if precision is not None and recall is not None and (precision + recall) > 0:
        f1 = round(2 * precision * recall / (precision + recall), 4)
    return {
        "id": summary_id or f"evalsum_{int(time.time())}",
        "runtimeVersion": runtime_version,
        "cases": len(reports),
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "truePositives": tp,
        "falseNegatives": fn,
        "falsePositives": fp,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "byCategory": by_category,
        "regressed": sorted(regressed),
        "improved": sorted(improved),
        "accepted": bool(evaluated) and failed == 0 and not regressed,
        "evidenceClass": "recorded-footage",
        "recordedAt": stamp(),
    }


def render_summary(summary: dict) -> str:
    """A one-screen accuracy report."""
    lines = [
        "CCTV accuracy evaluation",
        "========================",
        f"cases      : {summary['cases']} (passed {summary['passed']} · failed {summary['failed']} · "
        f"skipped {summary['skipped']})",
        f"precision  : {_pct(summary['precision'])}   recall: {_pct(summary['recall'])}   "
        f"f1: {_pct(summary['f1'])}",
        f"counts     : tp={summary['truePositives']} fn={summary['falseNegatives']} "
        f"fp={summary['falsePositives']}",
    ]
    if summary["regressed"]:
        lines.append(f"REGRESSED  : {', '.join(summary['regressed'])}")
    if summary["improved"]:
        lines.append(f"improved   : {', '.join(summary['improved'])}")
    if summary["skipped"]:
        lines.append(
            f"note       : {summary['skipped']} case(s) had no footage on this machine and were NOT "
            "counted as passing"
        )
    lines.append(f"accepted   : {'YES' if summary['accepted'] else 'NO'}")
    return "\n".join(lines)


# --- running a case over real footage (lazy OpenCV path) ------------------------


def analyze_case(
    case: DatasetCase,
    *,
    engine: str = "stub",
    tenant_id: str = "tnt_dataset",
    root: Optional[str] = None,
    max_frames: Optional[int] = None,
) -> Tuple[object, float]:
    """Decode + analyse one case's footage through the standard pipeline.

    Uses the **same** `VideoAnalyzer` the playground and the live runtime use, which is the point: an
    accuracy result that came from a bespoke evaluation path would say nothing about production.
    Returns `(AnalyzeResult, effective_fps)`.
    """
    from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: WPS433
    from video_decoder import IterableFrameDecoder, OpenCvFrameDecoder  # noqa: WPS433
    from video_sampler import FrameSampler  # noqa: WPS433
    from playground import build_adapter  # noqa: WPS433

    path = case.footage.resolve(root)
    decoder = OpenCvFrameDecoder(path)
    frames = list(decoder.decode())
    if max_frames is not None:
        frames = frames[:max_frames]
    source_fps = decoder.source_fps or case.footage.fps or 30.0
    target_fps = _opt_float(case.options.get("targetFps"))
    sampler = FrameSampler(source_fps=source_fps, target_fps=target_fps)
    sampled = list(sampler.sample(frames))
    effective_fps = source_fps / max(1, sampler.stride)

    options = AnalyzeOptions(
        tenant_id=tenant_id,
        camera_id=case.options.get("cameraId", "cam_dataset"),
        engine=engine,
        labels=tuple(case.options.get("labels") or ("person",)),
        min_confidence=float(case.options.get("minConfidence", 0.5)),
        source=case.footage.path,
        session_id=f"sess_{_slug(case.id)}",
        zones=tuple(case.zones),
        enable_behaviors=bool(case.options.get("enableBehaviors", True)),
        behavior_options=dict(case.options.get("behaviors") or {}),
        enable_composites=bool(case.options.get("enableComposites", True)),
    )
    analyzer = VideoAnalyzer(build_adapter(engine), options)
    result = analyzer.analyze(
        IterableFrameDecoder(sampled, source_video=case.footage.path, source_fps=source_fps),
        FrameSampler(stride=1),
    )
    return result, effective_fps


def run_case(
    case: DatasetCase,
    *,
    engine: str = "stub",
    root: Optional[str] = None,
    runtime_version: str = "1.0.0",
    max_frames: Optional[int] = None,
) -> EvaluationReport:
    """Evaluate one case end to end, degrading honestly: missing footage → `footage-missing`, a
    changed digest → `error` (a result attributed to the wrong bytes is worse than no result)."""
    if not case.available(root):
        return skipped_report(case, runtime_version=runtime_version)
    verified = case.footage.verify(root)
    if verified is False:
        return error_report(
            case,
            ValueError("footage digest does not match the manifest; the clip has been replaced"),
            runtime_version=runtime_version,
        )
    try:
        result, effective_fps = analyze_case(case, engine=engine, root=root, max_frames=max_frames)
    except Exception as exc:  # noqa: BLE001 - one bad clip must not end the run
        return error_report(case, exc, runtime_version=runtime_version)
    return evaluate(
        case, result, runtime_version=runtime_version, effective_fps=effective_fps
    )


# --- helpers --------------------------------------------------------------------


def _frame_seconds(frame: dict, effective_fps: Optional[float]) -> Optional[float]:
    """Wall position of a frame. Prefers the frame's own timestamp (`"1.5s"`); falls back to
    index/fps, which is exact for a constant-rate sampled stream."""
    raw = frame.get("timestamp")
    if isinstance(raw, str) and raw.endswith("s"):
        try:
            return float(raw[:-1])
        except ValueError:
            pass
    if isinstance(raw, (int, float)):
        return float(raw)
    index = frame.get("frameIndex")
    if isinstance(index, int) and effective_fps:
        return round(index / effective_fps, 4)
    return None


def _ratio(numerator: int, denominator: int) -> Optional[float]:
    return None if denominator == 0 else round(numerator / denominator, 4)


def _pct(value: Optional[float]) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _opt_float(value) -> Optional[float]:  # noqa: ANN001
    return None if value is None else float(value)


def _slug(value: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in value).strip("_")


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
