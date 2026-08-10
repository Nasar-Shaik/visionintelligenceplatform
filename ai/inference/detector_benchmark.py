"""The detector benchmark matrix (P-10 Workstream B) — **model × case, one code path**.

    for each registered model:
        for each case in the corpus:
            video → decode → detect → track → behaviours → events

⛔ **There is no detector-specific benchmark code, and that is the load-bearing property.** A model
is selected by building the ref that `ModelAdapter.load()` already takes — a resolved catalogue
entry — so adding GroundingDINO, Florence-2, YOLO12 or SAM2 to this benchmark is a catalogue entry
and nothing else. If a future detector ever needs a branch in this file, the plugin architecture has
failed and the branch is the evidence.

### ⭐ Why the matrix is dense, and why a skip is recorded rather than dropped

Every model runs **every** case. A model that cannot decode a clip, or that times out, produces a
row with `status != "ok"` — it is never omitted. Omission is the quiet way a detector wins a
benchmark: the hard cases vanish from its column, its averages improve, and the summary reads as a
result rather than an absence. `summarise()` therefore refuses to aggregate a model whose completed
case set differs from another's, and says which cases differ.

### ⚠️ Two measurements this tier cannot make, stated rather than approximated

- **Incidents.** The runtime emits `EventEnvelope` and creates no incidents — that is a standing
  architectural guarantee, not a limitation of this file. Incident counts require the deployed
  platform (rules → workflow), so they are `None` here and filled by the platform tier.
- **Ground-truth ID switches.** A true MOTA-style ID switch needs per-frame identity annotations the
  corpus does not have. What is reported instead is `trackReassignments` — how often a
  tracker-assigned `trackingId` changed *within* one `identityId` — which is an observable proxy and
  is named as one. Calling it "ID switches" would be a number that looks authoritative and is not.

Stdlib-only, deterministic, no I/O of its own: the caller injects the function that runs a case, so
the matrix logic is unit-testable without a model, a video or onnxruntime.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional, Sequence

#: A row's terminal state. ⚠️ `skipped` and `error` are different questions — "the corpus does not
#: have this clip here" is an environment fact, "this detector fell over on it" is a result.
ROW_STATUSES = ("ok", "skipped", "error", "timeout")


def model_ref(model: object, artifact_dir: str, labels: Sequence[str]) -> dict:
    """Build the `ModelAdapter.load()` ref that selects **this** catalogue entry.

    ⭐ The whole model-selection mechanism, and it changes no runtime code: `load()` has always
    taken a resolved catalogue entry, so pointing it at a different registered model is a
    dictionary, not a feature.
    """
    import os

    return {
        "modelId": getattr(model, "id", ""),
        "input": getattr(model, "input"),
        "onnx_path": os.path.join(artifact_dir, getattr(model, "artifact", "")),
        "outputFormat": getattr(model, "output_format", ""),
        "outputParams": dict(getattr(model, "output_params", {}) or {}),
        "labels": list(labels),
    }


class PinnedModelAdapter:
    """A `ModelAdapter` pinned to one catalogue entry, whatever the caller asks it to load.

    ⛔ **This exists so the benchmark changes no runtime code.** `VideoAnalyzer.__init__` calls
    `adapter.load({"labels": …})` unconditionally — correct for production, where the backend
    resolves its own model from the store, and fatal for a benchmark that must run *this* detector.
    Modifying the analyzer to accept a pre-loaded adapter would be a runtime change in a milestone
    whose entire purpose is measurement.

    So the pin lives on the benchmark side: the caller's `labels` are merged into the resolved ref
    this wrapper already holds, and the wrapped adapter loads the model the benchmark chose.

    ⚠️ The wrapped adapter is loaded **once**, on the first call. A second `load()` with different
    labels would otherwise rebuild an onnxruntime session mid-run and put a model-load cost inside a
    measured frame.
    """

    def __init__(self, adapter: object, ref: Mapping[str, object]) -> None:
        self._adapter = adapter
        self._ref = dict(ref)
        self._loaded = False

    @property
    def execution_provider(self) -> str:
        return getattr(self._adapter, "execution_provider", "unknown")

    def load(self, ref: Optional[Mapping[str, object]] = None) -> None:
        if self._loaded:
            return
        merged = dict(self._ref)
        if ref and "labels" in ref:
            merged["labels"] = list(ref["labels"])  # type: ignore[index]
        self._adapter.load(merged)  # type: ignore[attr-defined]
        self._loaded = True

    def preprocess(self, ctx: object) -> object:
        return self._adapter.preprocess(ctx)  # type: ignore[attr-defined]

    def infer(self, prepared: object) -> object:
        return self._adapter.infer(prepared)  # type: ignore[attr-defined]

    def unload(self) -> None:
        self._adapter.unload()  # type: ignore[attr-defined]
        self._loaded = False


@dataclass(frozen=True)
class DetectorRun:
    """One cell of the matrix: what one detector did with one case."""

    model_id: str
    case_id: str
    category: str
    status: str = "ok"
    scene_tags: Sequence[str] = ()
    detail: Optional[str] = None

    frames: int = 0
    detections: int = 0
    tracks_created: int = 0
    track_reassignments: int = 0
    events: int = 0
    #: ⚠️ Always None at the runtime tier — the runtime creates no incidents, by design.
    incidents: Optional[int] = None

    inference_ms_avg: Optional[float] = None
    inference_ms_p95: Optional[float] = None
    wall_seconds: Optional[float] = None
    peak_rss_mib: Optional[float] = None
    cpu_percent_avg: Optional[float] = None

    def __post_init__(self) -> None:
        if self.status not in ROW_STATUSES:
            raise ValueError(f"unknown status '{self.status}' (expected one of {ROW_STATUSES})")

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @property
    def detections_per_frame(self) -> Optional[float]:
        return round(self.detections / self.frames, 4) if self.frames else None

    @property
    def fps(self) -> Optional[float]:
        if not self.wall_seconds or self.frames == 0:
            return None
        return round(self.frames / self.wall_seconds, 3)

    def to_dict(self) -> dict:
        out = {
            "modelId": self.model_id,
            "caseId": self.case_id,
            "category": self.category,
            "sceneTags": list(self.scene_tags),
            "status": self.status,
            "frames": self.frames,
            "detections": self.detections,
            "detectionsPerFrame": self.detections_per_frame,
            "tracksCreated": self.tracks_created,
            "trackReassignments": self.track_reassignments,
            "events": self.events,
            "incidents": self.incidents,
            "inferenceMsAvg": self.inference_ms_avg,
            "inferenceMsP95": self.inference_ms_p95,
            "wallSeconds": self.wall_seconds,
            "fps": self.fps,
            "peakRssMiB": self.peak_rss_mib,
            "cpuPercentAvg": self.cpu_percent_avg,
        }
        if self.detail:
            out["detail"] = self.detail
        return out


@dataclass
class BenchmarkMatrix:
    """Every cell, plus the environment that produced them."""

    rows: List[DetectorRun] = field(default_factory=list)
    corpus_version: str = "unversioned"
    environment: Mapping[str, object] = field(default_factory=dict)
    at: str = ""

    def models(self) -> List[str]:
        return sorted({r.model_id for r in self.rows})

    def cases(self) -> List[str]:
        return sorted({r.case_id for r in self.rows})

    def for_model(self, model_id: str) -> List[DetectorRun]:
        return [r for r in self.rows if r.model_id == model_id]

    def to_dict(self) -> dict:
        return {
            "at": self.at,
            "corpusVersion": self.corpus_version,
            "environment": dict(self.environment),
            "models": self.models(),
            "cases": self.cases(),
            "rows": [r.to_dict() for r in self.rows],
        }


class UnevenMatrix(ValueError):
    """Two detectors did not complete the same cases, so their aggregates are not comparable."""


def run_matrix(
    *,
    model_ids: Sequence[str],
    case_ids: Sequence[str],
    run_cell: Callable[[str, str], DetectorRun],
    corpus_version: str = "unversioned",
    environment: Optional[Mapping[str, object]] = None,
    clock: Callable[[], float] = time.time,
) -> BenchmarkMatrix:
    """Run every model against every case. `run_cell` is injected, so this is testable without a model.

    ⚠️ **Ordered model-major, and that matters for a fair comparison.** Running all of one detector's
    cases before starting the next means each model meets the corpus under whatever the host was
    doing at that moment. Interleaving would be worse, not better: a thermally-throttling laptop
    would then distribute its slowdown unevenly across models by position rather than by name.
    Neither ordering rescues a contended host — the environment block records that, and the report
    is required to print it.
    """
    rows: List[DetectorRun] = []
    for model_id in model_ids:
        for case_id in case_ids:
            row = run_cell(model_id, case_id)
            if row.model_id != model_id or row.case_id != case_id:
                raise ValueError(
                    f"run_cell returned a row for ({row.model_id}, {row.case_id}) "
                    f"when asked for ({model_id}, {case_id})"
                )
            rows.append(row)
    return BenchmarkMatrix(
        rows=rows,
        corpus_version=corpus_version,
        environment=dict(environment or {}),
        at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(clock())),
    )


def summarise(matrix: BenchmarkMatrix, *, require_even: bool = True) -> dict:
    """Per-model aggregates over the cases **every** model completed.

    ⛔ Raises `UnevenMatrix` when detectors completed different case sets. Averaging over whatever
    each model happened to finish is how a detector that crashes on the hard clips posts the best
    numbers in the table — the failure is invisible in the aggregate and obvious in the row list.
    """
    completed: Dict[str, set] = {
        model_id: {r.case_id for r in matrix.for_model(model_id) if r.ok} for model_id in matrix.models()
    }
    shared = set.intersection(*completed.values()) if completed else set()

    if require_even and len(completed) > 1:
        divergent = {m: sorted(cases - shared) for m, cases in completed.items() if cases - shared}
        if divergent:
            raise UnevenMatrix(
                "detectors did not complete the same cases, so their aggregates are not comparable: "
                + "; ".join(f"{m} additionally completed {cases}" for m, cases in sorted(divergent.items()))
            )

    def _avg(values: Sequence[float]) -> Optional[float]:
        usable = [v for v in values if isinstance(v, (int, float))]
        return round(sum(usable) / len(usable), 3) if usable else None

    per_model = {}
    for model_id in matrix.models():
        rows = [r for r in matrix.for_model(model_id) if r.ok and r.case_id in shared]
        statuses: Dict[str, int] = {}
        for row in matrix.for_model(model_id):
            statuses[row.status] = statuses.get(row.status, 0) + 1
        per_model[model_id] = {
            "casesCompared": len(rows),
            "statuses": statuses,
            "frames": sum(r.frames for r in rows),
            "detections": sum(r.detections for r in rows),
            "detectionsPerFrame": _avg([r.detections_per_frame for r in rows if r.detections_per_frame is not None]),
            "tracksCreated": sum(r.tracks_created for r in rows),
            "trackReassignments": sum(r.track_reassignments for r in rows),
            "events": sum(r.events for r in rows),
            "incidents": None if all(r.incidents is None for r in rows) else sum(r.incidents or 0 for r in rows),
            "inferenceMsAvg": _avg([r.inference_ms_avg for r in rows]),
            "inferenceMsP95": _avg([r.inference_ms_p95 for r in rows]),
            "fps": _avg([r.fps for r in rows if r.fps is not None]),
            "peakRssMiB": _avg([r.peak_rss_mib for r in rows]),
            "cpuPercentAvg": _avg([r.cpu_percent_avg for r in rows]),
        }

    return {
        "at": matrix.at,
        "corpusVersion": matrix.corpus_version,
        "environment": dict(matrix.environment),
        "comparableCases": sorted(shared),
        "perModel": per_model,
    }


def render_summary(summary: dict) -> str:
    """`BENCHMARK_SUMMARY.md` — generated, never transcribed.

    ⚠️ The environment block is printed **above** the table rather than in a footnote. Every number
    below it is a property of the host as much as of the detector, and a reader who quotes one row
    must not be able to do so without having read what produced it.
    """
    lines: List[str] = ["# Benchmark Summary", ""]
    lines.append(f"**{summary.get('at', '—')}** · corpus `{summary.get('corpusVersion', '—')}`")
    lines.append("")

    env = summary.get("environment") or {}
    if env:
        lines.append("> **Environment.** " + " · ".join(f"{k} `{v}`" for k, v in sorted(env.items())))
        lines.append("")
    contended = env.get("hostContended")
    if contended:
        lines.append(
            "> ⛔ **The host was contended during this run.** Latency, FPS and CPU below describe a "
            "busy machine and must not be quoted as detector characteristics. Detection counts, "
            "track counts and event counts are unaffected."
        )
        lines.append("")

    cases = summary.get("comparableCases") or []
    lines.append(f"Compared over **{len(cases)}** case(s) every detector completed.")
    lines.append("")
    lines.append(
        "| Detector | Cases | Frames | Det/frame | Tracks | Reassign | Events | Inference avg ms | p95 | FPS | RSS MiB |"
    )
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")

    def cell(value) -> str:  # noqa: ANN001
        return "—" if value is None else str(value)

    for model_id, stats in sorted((summary.get("perModel") or {}).items()):
        lines.append(
            f"| `{model_id}` | {stats['casesCompared']} | {stats['frames']} | "
            f"{cell(stats['detectionsPerFrame'])} | {stats['tracksCreated']} | "
            f"{stats['trackReassignments']} | {stats['events']} | "
            f"{cell(stats['inferenceMsAvg'])} | {cell(stats['inferenceMsP95'])} | "
            f"{cell(stats['fps'])} | {cell(stats['peakRssMiB'])} |"
        )
    lines.append("")

    non_ok = {
        model_id: {s: n for s, n in stats["statuses"].items() if s != "ok"}
        for model_id, stats in (summary.get("perModel") or {}).items()
    }
    if any(non_ok.values()):
        lines.append("## ⚠️ Cases that did not complete")
        lines.append("")
        for model_id, statuses in sorted(non_ok.items()):
            if statuses:
                lines.append(f"- `{model_id}`: " + ", ".join(f"{n} {s}" for s, n in sorted(statuses.items())))
        lines.append("")
        lines.append(
            "⛔ A detector's aggregate above covers only the cases **every** detector completed, so "
            "these do not flatter it — but they are the rows to read first."
        )
        lines.append("")

    lines.append("## What this table does not say")
    lines.append("")
    lines.append(
        "⛔ **Precision and recall are absent.** They require per-frame ground truth; a detection "
        "count is not an accuracy. A detector with more detections per frame may be finding people "
        "or may be finding coat racks, and nothing here distinguishes them."
    )
    lines.append("")
    lines.append(
        "⛔ **`Reassign` is structurally zero and is not a measurement.** It was described as "
        "counting how often a tracker-assigned `trackingId` changed within one `identityId`; the "
        "runtime publishes no such counter, and cannot — a trackId is never reused, because "
        "re-entry is modelled as a link rather than a reassignment, and track diagnostics carry no "
        "`identityId` at this tier. Read the column as *not measured*, never as *no ID switches "
        "occurred*: measuring ID switches needs the annotated footage the corpus does not have."
    )
    lines.append("")
    lines.append(
        "⚠️ **Incidents are absent by architecture.** The runtime emits events and creates no "
        "incidents; incident counts come from the deployed platform tier."
    )
    return "\n".join(lines) + "\n"
