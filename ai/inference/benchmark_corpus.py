"""The declared detector-benchmark corpus, and what it can honestly answer — P3.1.

    corpus manifest ──▶ BenchmarkCase[]  ──▶ detector_benchmark.run_matrix
                   └──▶ coverage()       ──▶ CORPUS_COVERAGE.md

⛔ **This module exists because "we benchmarked it" and "we benchmarked it on anything like reality"
are different claims, and only one of them was ever true here.**

Audited 2026-08-10: of 38 fixture clips, **31 are authored** — rendered shapes, 27 of them at
640×360 — one is derived from CC0 photographs, and six are damaged-file transport fixtures. There is
no video of real people anywhere in this repository. A detector comparison computed over that corpus
would be precise, reproducible, and about rasterisation rather than perception.

### ⭐ The rule this file enforces, in code rather than in a convention

**A scenario backed only by authored or synthetic footage can never be `AVAILABLE`.** It is capped at
`PARTIAL`, permanently, by `_state_for`. Nothing an author writes in a manifest can promote a
rendered rectangle to evidence about people — the promotion is not a policy somebody has to remember,
it is unreachable.

⚠️ That cap is deliberately annoying. It means the coverage report will read badly until real footage
exists, which is the accurate description of the situation and the reason the report is generated
rather than written.

### ⚠️ Footage kind is provenance, not quality

`AUTHORED` is not an insult and `REAL_FOOTAGE` is not automatically better for every question: an
authored clip is the *right* instrument for "does the tracker hold one id across a full crossing",
because its ground truth is known by construction. It is the wrong instrument for "does this detector
see a person", because there is no person. The kind travels with every case so a reader can tell
which question a row is answering.

Stdlib-only, pure, deterministic. No model, no video, no I/O beyond reading its own manifest.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

#: ⛔ **The closed provenance vocabulary.** Every case declares exactly one.
#:
#:   REAL_FOOTAGE  video of real people or real objects, recorded by a camera
#:   AUTHORED      deliberately constructed fixture — rendered shapes with known intent
#:   SYNTHETIC     generated pattern with no subject at all (testsrc, colour bars)
#:   PHOTOGRAPH    real imagery, but stills — or a pan constructed from stills
#:
#: ⚠️ `PARTIAL` and `MISSING` are **coverage** states, not footage kinds: they describe a scenario's
#: evidence, not a file's origin. They are named here because the brief lists all six together, and
#: conflating the two axes is exactly how "we have a clip for that" becomes "that is covered".
FOOTAGE_KINDS: Tuple[str, ...] = ("REAL_FOOTAGE", "AUTHORED", "SYNTHETIC", "PHOTOGRAPH")

#: What a scenario's evidence amounts to.
COVERAGE_STATES: Tuple[str, ...] = ("AVAILABLE", "PARTIAL", "MISSING")

#: ⭐ **Kinds that can establish a scenario on their own.** Exactly one, and that is the point.
CONCLUSIVE_KINDS: Tuple[str, ...] = ("REAL_FOOTAGE",)

#: The scenarios a detector benchmark is required to report coverage for.
#:
#: ⚠️ Ordered by what a reader should worry about first, not alphabetically: the perception basics,
#: then viewpoint, then capture conditions, then objects, then interactions. A scenario missing from
#: the top of this list is a bigger hole than one missing from the bottom.
SCENARIOS: Tuple[str, ...] = (
    "normal-person",
    "multiple-people",
    "crowd",
    "distant-person",
    "close-person",
    "side-facing-person",
    "rear-facing-person",
    "partially-occluded-person",
    "shelf-occlusion",
    "top-down-view",
    "low-angle-view",
    "portrait-video",
    "4k",
    "low-resolution-cctv",
    "backlighting",
    "poor-lighting",
    "motion-blur",
    "bottle",
    "backpack",
    "handbag",
    "suitcase",
    "cup",
    "small-merchandise",
    "person-carrying-object",
    "object-pickup",
    "object-return",
    "two-person-interaction",
    "handover",
    "two-people-one-object",
    "person-leaving-frame",
    "re-entry",
)


class CorpusError(ValueError):
    """The declared corpus is not usable as declared.

    ⛔ Raised rather than warned. A benchmark whose corpus half-loaded would compare detectors over
    whichever cases happened to resolve — the same defect `summarise()` refuses to commit when
    detectors complete different case sets, arriving one layer earlier.
    """


@dataclass(frozen=True)
class BenchmarkCase:
    """One clip, and the honest description of what it is."""

    case_id: str
    path: str
    category: str
    footage_kind: str
    #: Scenarios this case is claimed to exercise. ⚠️ A claim, checked against `SCENARIOS`.
    scenarios: Tuple[str, ...] = ()
    scene_tags: Tuple[str, ...] = ()
    #: Path to per-frame ground-truth annotations, when they exist. ⛔ `None` is the normal case
    #: today, and it is what forbids precision and recall — see `has_ground_truth`.
    ground_truth: Optional[str] = None
    note: str = ""

    def __post_init__(self) -> None:
        if self.footage_kind not in FOOTAGE_KINDS:
            raise CorpusError(
                f"case '{self.case_id}' declares footageKind '{self.footage_kind}', "
                f"expected one of {FOOTAGE_KINDS}"
            )
        unknown = [s for s in self.scenarios if s not in SCENARIOS]
        if unknown:
            raise CorpusError(
                f"case '{self.case_id}' claims unknown scenario(s) {unknown}. "
                f"A scenario that is not in SCENARIOS is not reported, so the claim would be silent."
            )

    @property
    def has_ground_truth(self) -> bool:
        return self.ground_truth is not None

    @property
    def conclusive(self) -> bool:
        """⭐ Whether this case can establish a scenario **on its own**."""
        return self.footage_kind in CONCLUSIVE_KINDS

    def to_dict(self) -> dict:
        return {
            "caseId": self.case_id,
            "path": self.path,
            "category": self.category,
            "footageKind": self.footage_kind,
            "scenarios": list(self.scenarios),
            "sceneTags": list(self.scene_tags),
            "groundTruth": self.ground_truth,
            "note": self.note,
        }


@dataclass(frozen=True)
class ScenarioCoverage:
    """What the corpus can say about one scenario."""

    scenario: str
    state: str
    cases: Tuple[str, ...] = ()
    kinds: Tuple[str, ...] = ()
    ground_truth_cases: Tuple[str, ...] = ()

    @property
    def accuracy_measurable(self) -> bool:
        """⛔ Precision and recall are permitted **only** here."""
        return bool(self.ground_truth_cases)

    def to_dict(self) -> dict:
        return {
            "scenario": self.scenario,
            "state": self.state,
            "cases": list(self.cases),
            "kinds": list(self.kinds),
            "groundTruthCases": list(self.ground_truth_cases),
            "accuracyMeasurable": self.accuracy_measurable,
        }


@dataclass(frozen=True)
class Corpus:
    """The declared cases, versioned, with the coverage they amount to."""

    version: str
    cases: Tuple[BenchmarkCase, ...]
    note: str = ""

    def case_ids(self) -> List[str]:
        return [c.case_id for c in self.cases]

    def by_id(self, case_id: str) -> BenchmarkCase:
        for case in self.cases:
            if case.case_id == case_id:
                return case
        raise CorpusError(f"no case '{case_id}' in corpus '{self.version}'")

    def kinds(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for case in self.cases:
            counts[case.footage_kind] = counts.get(case.footage_kind, 0) + 1
        return counts

    @property
    def has_any_ground_truth(self) -> bool:
        return any(c.has_ground_truth for c in self.cases)


def _state_for(cases: Sequence[BenchmarkCase]) -> str:
    """⛔ **The rule, and it is unreachable to break.**

    A scenario with no case at all is `MISSING`. A scenario backed only by authored, synthetic or
    photographic material is capped at `PARTIAL` — **there is no path by which it becomes
    `AVAILABLE`**, whatever a manifest claims, because a rendered rectangle is not evidence about
    whether a detector sees people.

    ⚠️ Only `REAL_FOOTAGE` promotes. That is a deliberately narrow gate: `PHOTOGRAPH` is real imagery
    and still cannot answer a question about motion, tracking or occlusion over time.
    """
    if not cases:
        return "MISSING"
    return "AVAILABLE" if any(c.conclusive for c in cases) else "PARTIAL"


def coverage(corpus: Corpus) -> List[ScenarioCoverage]:
    """Every required scenario, with the evidence the corpus actually holds for it."""
    out: List[ScenarioCoverage] = []
    for scenario in SCENARIOS:
        matching = [c for c in corpus.cases if scenario in c.scenarios]
        out.append(
            ScenarioCoverage(
                scenario=scenario,
                state=_state_for(matching),
                cases=tuple(c.case_id for c in matching),
                kinds=tuple(sorted({c.footage_kind for c in matching})),
                ground_truth_cases=tuple(c.case_id for c in matching if c.has_ground_truth),
            )
        )
    return out


def coverage_counts(rows: Sequence[ScenarioCoverage]) -> Dict[str, int]:
    counts = {state: 0 for state in COVERAGE_STATES}
    for row in rows:
        counts[row.state] += 1
    return counts


def load(path: str, *, root: Optional[str] = None, require_files: bool = True) -> Corpus:
    """Read a corpus manifest, and refuse it if it does not describe something runnable.

    ⚠️ `require_files` is on by default and only turned off by unit tests. A corpus that silently
    dropped a missing clip would produce a matrix over fewer cases than it claims, and the aggregate
    would be over the *easy* subset — which is the failure `summarise()` guards one layer later.
    """
    base = root if root is not None else os.path.dirname(os.path.abspath(path))
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        raise CorpusError(f"cannot read corpus manifest '{path}': {exc}") from exc

    version = str(raw.get("version") or "").strip()
    if not version:
        raise CorpusError(
            f"corpus '{path}' declares no version. ⛔ A benchmark result that cannot name the corpus "
            f"it ran against is not reproducible."
        )

    cases: List[BenchmarkCase] = []
    seen: set = set()
    for entry in raw.get("cases", []):
        case_id = str(entry.get("caseId") or "")
        if not case_id:
            raise CorpusError(f"corpus '{path}' contains a case with no caseId")
        if case_id in seen:
            raise CorpusError(f"corpus '{path}' declares '{case_id}' twice")
        seen.add(case_id)
        case = BenchmarkCase(
            case_id=case_id,
            path=str(entry.get("path") or ""),
            category=str(entry.get("category") or "uncategorised"),
            footage_kind=str(entry.get("footageKind") or ""),
            scenarios=tuple(str(s) for s in entry.get("scenarios", [])),
            scene_tags=tuple(str(s) for s in entry.get("sceneTags", [])),
            ground_truth=entry.get("groundTruth"),
            note=str(entry.get("note") or ""),
        )
        if require_files:
            resolved = os.path.join(base, case.path)
            if not os.path.isfile(resolved):
                raise CorpusError(
                    f"case '{case_id}' points at '{case.path}', which does not exist "
                    f"(resolved to '{resolved}')"
                )
            if case.ground_truth is not None:
                gt = os.path.join(base, case.ground_truth)
                if not os.path.isfile(gt):
                    # ⛔ A declared-but-absent annotation is worse than none: it would authorise
                    # precision and recall for a scenario nothing can score.
                    raise CorpusError(
                        f"case '{case_id}' declares groundTruth '{case.ground_truth}', which does "
                        f"not exist. Accuracy metrics would be emitted for a case nothing can score."
                    )
        cases.append(case)

    if not cases:
        raise CorpusError(f"corpus '{path}' declares no cases")
    return Corpus(version=version, cases=tuple(cases), note=str(raw.get("note") or ""))


def render_coverage(corpus: Corpus, rows: Sequence[ScenarioCoverage]) -> str:
    """`CORPUS_COVERAGE.md` — generated, never transcribed."""
    counts = coverage_counts(rows)
    kinds = corpus.kinds()
    lines: List[str] = ["# Detector benchmark — corpus coverage", ""]
    lines.append(f"**Corpus `{corpus.version}`** · {len(corpus.cases)} declared case(s)")
    lines.append("")
    lines.append(
        f"**{counts['AVAILABLE']} AVAILABLE · {counts['PARTIAL']} PARTIAL · "
        f"{counts['MISSING']} MISSING** of {len(rows)} required scenarios."
    )
    lines.append("")

    if counts["AVAILABLE"] == 0:
        lines.append(
            "> ⛔ **No scenario is covered by real footage.** Every row below is either authored "
            "material or absent. A detector comparison over this corpus measures how detectors "
            "handle *this corpus* — it does not measure how they handle people, and no winner may "
            "be declared from it."
        )
        lines.append("")

    lines.append("## Footage held")
    lines.append("")
    lines.append("| Kind | Cases | Can establish a scenario alone? |")
    lines.append("| --- | ---: | --- |")
    for kind in FOOTAGE_KINDS:
        if kind not in kinds:
            continue
        conclusive = "⭐ yes" if kind in CONCLUSIVE_KINDS else "⛔ no — caps a scenario at PARTIAL"
        lines.append(f"| `{kind}` | {kinds[kind]} | {conclusive} |")
    lines.append("")
    lines.append(
        "⚠️ **`AUTHORED` is provenance, not a verdict on quality.** An authored clip is the *right* "
        "instrument for \"does the tracker hold one id across a full crossing\", because its intent "
        "is known by construction. It is the wrong instrument for \"does this detector see a "
        "person\", because there is no person."
    )
    lines.append("")

    lines.append("## Scenario coverage")
    lines.append("")
    lines.append("| Scenario | State | Evidence | Kinds | Ground truth |")
    lines.append("| --- | --- | --- | --- | --- |")
    mark = {"AVAILABLE": "⭐ AVAILABLE", "PARTIAL": "⚠️ PARTIAL", "MISSING": "⛔ MISSING"}
    for row in rows:
        cases = ", ".join(f"`{c}`" for c in row.cases) if row.cases else "—"
        kind_text = ", ".join(row.kinds) if row.kinds else "—"
        gt = "✓" if row.accuracy_measurable else "—"
        lines.append(f"| `{row.scenario}` | {mark[row.state]} | {cases} | {kind_text} | {gt} |")
    lines.append("")

    if not corpus.has_any_ground_truth:
        lines.append("## ⛔ No ground truth exists")
        lines.append("")
        lines.append(
            "Not one case carries per-frame annotations, so **precision, recall, false-positive "
            "and false-negative rates, IoU and mAP cannot be computed for anything** and are absent "
            "from every report rather than estimated. What the benchmark reports instead is "
            "**observational**: latency, FPS, CPU, memory, detections per frame, confidence "
            "distribution and class coverage."
        )
        lines.append("")
        lines.append(
            "⚠️ A detection count is not an accuracy. A detector with more detections per frame may "
            "be finding people or may be finding coat racks, and no number in this corpus "
            "distinguishes them."
        )
        lines.append("")

    missing = [r.scenario for r in rows if r.state == "MISSING"]
    if missing:
        lines.append("## What to record next")
        lines.append("")
        lines.append(
            f"{len(missing)} scenario(s) have **no evidence of any kind**. See "
            "`FOOTAGE_ACQUISITION.md` for the acquisition checklist and the annotation plan."
        )
        lines.append("")
        for scenario in missing:
            lines.append(f"- `{scenario}`")
        lines.append("")
    return "\n".join(lines) + "\n"
