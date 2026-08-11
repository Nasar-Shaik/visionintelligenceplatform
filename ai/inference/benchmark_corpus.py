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

#: ⛔ **Real footage of real people never enters this repository.** The manifest that describes it is
#: committed; the pixels live here, git-ignored, and are bound to the manifest by checksum. This is
#: the convention `object-corpus.mjs` established for photographs, applied to video.
DEFAULT_REAL_ROOT = ".data/real"
REAL_ROOT_ENV = "VIP_REAL_FOOTAGE_DIR"

#: Kinds whose files are rendered or constructed and therefore **belong in the repository**.
AUTHORED_KINDS: Tuple[str, ...] = ("AUTHORED", "SYNTHETIC", "PHOTOGRAPH")

#: The scenarios a detector benchmark is required to report coverage for.
#:
#: ⚠️ Ordered by what a reader should worry about first, not alphabetically: the perception basics,
#: then viewpoint, then capture conditions, then objects, then interactions. A scenario missing from
#: the top of this list is a bigger hole than one missing from the bottom.
SCENARIOS: Tuple[str, ...] = (
    # --- the person, seen at all ---
    "normal-person",
    "multiple-people",
    "crowd",
    "distant-person",
    "close-person",
    # --- orientation: which way the subject faces the lens ---
    "front-facing-person",
    "side-facing-person",
    "rear-facing-person",
    # --- posture. ⚠️ Recorded now, scored later: these are the footage a pose model would
    # eventually be measured on, and the recording is worth doing before the model is approved.
    # ⛔ They are *observations of body configuration*, never intent.
    "person-standing",
    "person-sitting",
    "person-bending",
    "hands-raised",
    # --- occlusion ---
    "partially-occluded-person",
    "shelf-occlusion",
    # --- viewpoint and capture ---
    "top-down-view",
    "low-angle-view",
    "portrait-video",
    "4k",
    "low-resolution-cctv",
    "backlighting",
    "poor-lighting",
    "motion-blur",
    # --- objects ---
    "bottle",
    "backpack",
    "handbag",
    "suitcase",
    "cup",
    "small-merchandise",
    # --- object handling ---
    "person-carrying-object",
    "object-pickup",
    "object-putdown",
    "object-return",
    # --- interaction ---
    "two-person-interaction",
    "handover",
    "two-people-one-object",
    # --- movement through the frame, and the geometry rules read ---
    "person-entering-frame",
    "person-leaving-frame",
    "re-entry",
    "approach-recede",
    "zone-crossing",
    "line-crossing",
)


def _is_sha256(value: str) -> bool:
    """⚠️ 64 hex characters. A path, a prefix or a placeholder cannot satisfy this — which is the
    assertion that would have caught P3.1's checksum column publishing a file path."""
    return len(value) == 64 and all(c in "0123456789abcdef" for c in value.lower())


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
    #: ⛔ Required for `REAL_FOOTAGE`, forbidden otherwise. The digest binds the manifest to the
    #: bytes, so a clip swapped under a declaration fails loudly instead of silently re-measuring.
    sha256: Optional[str] = None
    #: How it was recorded — device, date, dimensions, duration. Required for `REAL_FOOTAGE`.
    capture: Optional[Mapping[str, object]] = None
    #: ⛔ Required for `REAL_FOOTAGE`: the lawful basis for holding video of identifiable people.
    #: A reference an auditor can follow, never a boolean — "true" records no decision.
    consent: Optional[str] = None

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
        self._check_provenance()

    def _check_provenance(self) -> None:
        """⛔ **The classification guard, and it runs in both directions.**

        P3.1 made it impossible to promote authored material to `AVAILABLE`. The opposite mistake is
        now the live one: real footage misfiled as `AUTHORED` would be silently demoted — a genuine
        measurement discarded as though it were a rendered rectangle, and a clip of identifiable
        people held with no consent record attached.

        ⭐ So the two kinds are not distinguished by a label anyone can retype. `REAL_FOOTAGE` must
        carry a checksum, capture metadata and a lawful basis; the constructed kinds must carry
        *none* of those, because a rendered rectangle has no subject who could consent. Relabelling
        a case in either direction fails here, and `load()` additionally resolves the two kinds under
        different roots, so a mislabel is a missing file rather than a quiet reclassification.
        """
        if self.footage_kind == "REAL_FOOTAGE":
            missing = [
                name
                for name, value in (("sha256", self.sha256), ("capture", self.capture), ("consent", self.consent))
                if not value
            ]
            if missing:
                raise CorpusError(
                    f"case '{self.case_id}' is REAL_FOOTAGE but declares no {', '.join(missing)}. "
                    f"⛔ Real footage of identifiable people is admitted only with a checksum that "
                    f"binds it to these bytes, capture metadata, and a lawful basis on record."
                )
            if not _is_sha256(self.sha256 or ""):
                raise CorpusError(
                    f"case '{self.case_id}' declares sha256 '{self.sha256}', which is not a "
                    f"64-character hex digest"
                )
            return

        present = [
            name
            for name, value in (("sha256", self.sha256), ("capture", self.capture), ("consent", self.consent))
            if value
        ]
        if present:
            raise CorpusError(
                f"case '{self.case_id}' is {self.footage_kind} but declares {', '.join(present)}. "
                f"⛔ Those fields describe a recording of real subjects; a constructed fixture has "
                f"nobody to consent and no capture device. Did this case mean footageKind "
                f"'REAL_FOOTAGE'?"
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
            "sha256": self.sha256,
            "capture": dict(self.capture) if self.capture else None,
            "consent": self.consent,
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


def root_for(case: BenchmarkCase, fixtures_root: str, real_root: str) -> str:
    """Which tree a case's file lives in — ⛔ decided by provenance, never by the manifest author.

    ⚠️ Annotations resolve under the same root as their clip. Ground truth for real footage is
    derived data rather than imagery and could be committed, but it is worthless without the footage
    it describes, so the two are kept together rather than split across a third location.
    """
    return real_root if case.footage_kind == "REAL_FOOTAGE" else fixtures_root


def real_cases(corpus: Corpus) -> Tuple[BenchmarkCase, ...]:
    return tuple(c for c in corpus.cases if c.footage_kind == "REAL_FOOTAGE")


def verify_real_footage(corpus: Corpus, real_root: str, *, hasher=None) -> List[Tuple[str, str]]:
    """Re-hash every declared real clip. Returns `(case_id, problem)` for each that does not match.

    ⛔ **A mismatch is never repaired by re-declaring the digest.** Commons files get overwritten and
    phones re-encode on export; a measurement quietly re-run against different pixels produces a
    plausible number that describes nothing. `object-corpus.mjs` settled this for photographs and the
    reasoning is unchanged for video.

    ⚠️ Returns findings rather than raising, so a caller can report *every* bad clip in one pass
    instead of stopping at the first.
    """
    hasher = hasher or _sha256_file
    findings: List[Tuple[str, str]] = []
    for case in real_cases(corpus):
        resolved = os.path.join(real_root, case.path)
        if not os.path.isfile(resolved):
            findings.append((case.case_id, f"absent at '{resolved}'"))
            continue
        try:
            digest = hasher(resolved)
        except OSError as exc:
            findings.append((case.case_id, f"unreadable: {exc}"))
            continue
        if digest != case.sha256:
            findings.append(
                (case.case_id, f"declared sha256:{(case.sha256 or '')[:12]}…, found sha256:{digest[:12]}…")
            )
    return findings


def _sha256_file(path: str) -> str:
    import hashlib  # noqa: WPS433 - only needed when real footage is actually declared

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def coverage_counts(rows: Sequence[ScenarioCoverage]) -> Dict[str, int]:
    counts = {state: 0 for state in COVERAGE_STATES}
    for row in rows:
        counts[row.state] += 1
    return counts


def load(
    path: str,
    *,
    root: Optional[str] = None,
    real_root: Optional[str] = None,
    require_files: bool = True,
) -> Corpus:
    """Read a corpus manifest, and refuse it if it does not describe something runnable.

    ⚠️ `require_files` is on by default and only turned off by unit tests. A corpus that silently
    dropped a missing clip would produce a matrix over fewer cases than it claims, and the aggregate
    would be over the *easy* subset — which is the failure `summarise()` guards one layer later.

    ⭐ **Two roots, chosen by footage kind.** Constructed fixtures resolve under `root`, inside the
    repository; `REAL_FOOTAGE` resolves under `real_root`, which is git-ignored and holds recordings
    of real people. This is what makes the classification guard structural rather than clerical: a
    real clip relabelled `AUTHORED` is looked for among the committed fixtures and is simply not
    there, and a fixture relabelled `REAL_FOOTAGE` fails its checksum and consent requirements first.

    ⚠️ A corpus that declares no real footage still loads. That is the state today, and a loader that
    refused it would leave nothing able to report the gap.
    """
    base = root if root is not None else os.path.dirname(os.path.abspath(path))
    real_base = real_root if real_root is not None else os.environ.get(REAL_ROOT_ENV, DEFAULT_REAL_ROOT)
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
            sha256=entry.get("sha256"),
            capture=entry.get("capture"),
            consent=entry.get("consent"),
        )
        if require_files:
            resolved = os.path.join(root_for(case, base, real_base), case.path)
            if not os.path.isfile(resolved) and case.footage_kind not in CONCLUSIVE_KINDS:
                # ⛔ Constructed fixtures live in git, so an absent one is corruption.
                raise CorpusError(
                    f"case '{case_id}' points at '{case.path}', which does not exist "
                    f"(resolved to '{resolved}')"
                )
            # ⭐ **A real clip that is not on this machine is the expected state, not a fault.**
            # Real footage is deliberately git-ignored — the manifest entry is what gets committed,
            # the pixels are not — so it is absent on every machine except the one that recorded it.
            # Raising here made the first committed real declaration fail the suite for everyone,
            # including the machine holding the file, because the check resolved `.data/real`
            # against the caller's working directory.
            #
            # ⚠️ Absence is **not** silently promoted to health. `verify_real_footage` is the check
            # that the bytes are present and match their digest, and it is deliberately separate:
            # coverage answers "what does the corpus DECLARE" — a committed, machine-independent
            # fact — while verification answers "does this machine hold it". Folding presence into
            # coverage would make CORPUS_COVERAGE.md say different things on different laptops.
            if case.ground_truth is not None:
                gt = os.path.join(root_for(case, base, real_base), case.ground_truth)
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

    # ⛔ **The disclaimer must survive the arrival of real footage.** It used to be printed only
    # while `AVAILABLE == 0`, so the first real clip would have silently deleted the strongest
    # warning in the document at exactly the moment over-claiming became possible. Coverage and
    # scoreability are different questions: footage of real people makes a scenario *covered*, and
    # only human annotations make it *measurable*.
    real_scored = [c for c in corpus.cases if c.footage_kind in CONCLUSIVE_KINDS and c.has_ground_truth]
    if counts["AVAILABLE"] == 0:
        lines.append(
            "> ⛔ **No scenario is covered by real footage.** Every row below is either authored "
            "material or absent. A detector comparison over this corpus measures how detectors "
            "handle *this corpus* — it does not measure how they handle people, and no winner may "
            "be declared from it."
        )
        lines.append("")
    elif not real_scored:
        lines.append(
            f"> ⛔ **Real footage is declared, and no winner may be declared from it.** "
            f"{counts['AVAILABLE']} scenario(s) are now covered by footage of real people, which is "
            f"what makes them *observable* — but no real clip carries human annotations, so nothing "
            f"makes them **measurable**. Precision, recall and IoU about people remain uncomputable, "
            f"and the numbers below any real clip are observational only: detections per frame, "
            f"latency, track counts. ⚠️ A detector that leads on those has not been shown to be "
            f"more accurate; it has been shown to emit more boxes."
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
