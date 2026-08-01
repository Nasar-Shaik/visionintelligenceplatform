"""The CCTV dataset library (AI-5e, Architect priorities 1 & 3).

**What problem this solves.** The runtime has been proved against simulated sources and stub adapters.
That proves it *runs*. Whether it actually notices someone loitering by a till is a different question,
and the only thing that can answer it is real surveillance footage with a human's judgement written
down beside it. This module is the catalogue of those clips and those judgements.

**A case is a manifest, not a video.** Footage bytes live in DVC/object storage (see
ai/datasets/README.md) and are never committed — surveillance footage of real people is exactly the
category of data that must not be casually copied into a git history. A case therefore records where
the footage is, under what licence or consent basis, and what the platform should make of it. When the
bytes are not present locally the case reports `footage-missing`, which is **never** a pass: a dataset
suite that goes green because it evaluated nothing is worse than no suite at all.

**Why the category list is closed.** `SCENARIO_CATEGORIES` mirrors the contract enum. An open string
would let cases accumulate under three spellings of "loitering" and quietly stop functioning as a
regression suite — the failure mode of every test corpus that was ever allowed to grow organically.

Stdlib-only. Nothing here touches the perception pipeline; a dataset case is configuration + assertions.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Dict, Iterable, Iterator, List, Optional, Sequence

#: Mirrors `ScenarioCategory` in @vip/contracts. Order is the order the library reports in.
SCENARIO_CATEGORIES = (
    "person_detection",
    "tracking",
    "queue",
    "crowd",
    "loitering",
    "intrusion",
    "restricted_area",
    "shoplifting",
    "cashier_theft",
    "suspicious_behavior",
    "fire",
    "smoke",
    "violence",
    "abandoned_object",
    "fall_detection",
    "ppe",
    "customer_movement",
    "staff_movement",
)

FOOTAGE_ORIGINS = ("public-dataset", "synthetic", "customer-pilot", "internal-capture")
EXPECTATION_KINDS = ("detection", "track", "behavior", "composite", "event", "incident")

#: Repo-relative root of the library. Cases live at `<root>/<category>/cases/<slug>.json`.
DATASETS_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "datasets")
)


class DatasetError(ValueError):
    """A malformed dataset manifest. Raised eagerly at load time: a case that cannot be parsed must
    not silently disappear from the suite, because a silently-absent regression test is the same as a
    passing one."""


@dataclass(frozen=True)
class FootageReference:
    """Where the footage is and whether we are allowed to have it."""

    path: str
    origin: str
    licence: str
    sha256: Optional[str] = None
    duration_seconds: Optional[float] = None
    fps: Optional[float] = None
    resolution: Optional[str] = None
    anonymisation: Optional[str] = None

    def __post_init__(self) -> None:
        if self.origin not in FOOTAGE_ORIGINS:
            raise DatasetError(f"unknown footage origin '{self.origin}'")
        if not self.licence.strip():
            raise DatasetError("footage must record a licence or consent basis")

    def resolve(self, root: Optional[str] = None) -> str:
        """Absolute path to the footage, whether or not it exists."""
        base = root or os.path.dirname(DATASETS_ROOT)
        return self.path if os.path.isabs(self.path) else os.path.abspath(os.path.join(base, self.path))

    def available(self, root: Optional[str] = None) -> bool:
        return os.path.isfile(self.resolve(root))

    def verify(self, root: Optional[str] = None) -> Optional[bool]:
        """Check the footage digest. `None` when the case declares none (nothing to verify) or the
        file is absent; `False` means the bytes changed and any result derived from them is void."""
        if not self.sha256 or not self.available(root):
            return None
        digest = hashlib.sha256()
        with open(self.resolve(root), "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest() == self.sha256

    def to_dict(self) -> dict:
        out = {"path": self.path, "origin": self.origin, "licence": self.licence}
        for key, value in (
            ("sha256", self.sha256),
            ("durationSeconds", self.duration_seconds),
            ("fps", self.fps),
            ("resolution", self.resolution),
            ("anonymisation", self.anonymisation),
        ):
            if value is not None:
                out[key] = value
        return out


@dataclass(frozen=True)
class Expectation:
    """One thing the platform should — or must not — produce from the footage.

    Expectations are **temporal and countable, not pixel-exact**. The platform's job is to notice that
    someone dwelt near the counter between 0:12 and 0:31; holding it to a bounding-box IoU it was never
    labelled for would make the corpus expensive to maintain and dishonest about what it proves.
    """

    kind: str
    type: str
    count: Optional[int] = None
    count_tolerance: int = 0
    from_seconds: Optional[float] = None
    to_seconds: Optional[float] = None
    zone_id: Optional[str] = None
    min_confidence: Optional[float] = None
    absent: bool = False
    notes: Optional[str] = None

    def __post_init__(self) -> None:
        if self.kind not in EXPECTATION_KINDS:
            raise DatasetError(f"unknown expectation kind '{self.kind}'")
        if self.absent and self.count:
            raise DatasetError(
                f"expectation '{self.type}' is both absent and expects {self.count} occurrences"
            )
        if (
            self.from_seconds is not None
            and self.to_seconds is not None
            and self.to_seconds < self.from_seconds
        ):
            raise DatasetError(f"expectation '{self.type}' has an inverted window")

    @property
    def window(self) -> Optional[str]:
        if self.from_seconds is None and self.to_seconds is None:
            return None
        lo = "start" if self.from_seconds is None else f"{self.from_seconds:.1f}"
        hi = "end" if self.to_seconds is None else f"{self.to_seconds:.1f}"
        return f"{lo}-{hi}s"

    def within(self, seconds: Optional[float]) -> bool:
        """Whether an occurrence at `seconds` falls in the asserted window. An occurrence with no
        timestamp is accepted — a missing timestamp is the evaluator's gap, not the runtime's fault,
        and failing a case over it would produce noise instead of signal."""
        if seconds is None:
            return True
        if self.from_seconds is not None and seconds < self.from_seconds:
            return False
        if self.to_seconds is not None and seconds > self.to_seconds:
            return False
        return True

    def satisfied_by(self, observed: int) -> bool:
        if self.absent:
            return observed == 0
        target = 1 if self.count is None else self.count
        return abs(observed - target) <= self.count_tolerance

    def to_dict(self) -> dict:
        out: dict = {
            "kind": self.kind,
            "type": self.type,
            "countTolerance": self.count_tolerance,
            "absent": self.absent,
        }
        for key, value in (
            ("count", self.count),
            ("fromSeconds", self.from_seconds),
            ("toSeconds", self.to_seconds),
            ("zoneId", self.zone_id),
            ("minConfidence", self.min_confidence),
            ("notes", self.notes),
        ):
            if value is not None:
                out[key] = value
        return out


@dataclass
class DatasetCase:
    """One evaluable clip plus what it should produce."""

    id: str
    category: str
    title: str
    footage: FootageReference
    description: Optional[str] = None
    zones: List[dict] = field(default_factory=list)
    profile: Optional[str] = None
    options: dict = field(default_factory=dict)
    expectations: List[Expectation] = field(default_factory=list)
    notes: Optional[str] = None
    future_improvements: List[str] = field(default_factory=list)
    added_at: Optional[str] = None
    #: Where this case was loaded from — used by the CLI to point at the file that needs editing.
    manifest_path: Optional[str] = None

    def __post_init__(self) -> None:
        if self.category not in SCENARIO_CATEGORIES:
            raise DatasetError(
                f"case '{self.id}' declares unknown category '{self.category}'; "
                f"add it to SCENARIO_CATEGORIES and the ScenarioCategory contract first"
            )

    @property
    def positive_expectations(self) -> List[Expectation]:
        return [e for e in self.expectations if not e.absent]

    @property
    def negative_expectations(self) -> List[Expectation]:
        return [e for e in self.expectations if e.absent]

    def available(self, root: Optional[str] = None) -> bool:
        return self.footage.available(root)

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "category": self.category,
            "title": self.title,
            "footage": self.footage.to_dict(),
            "zones": list(self.zones),
            "options": dict(self.options),
            "expectations": [e.to_dict() for e in self.expectations],
            "futureImprovements": list(self.future_improvements),
        }
        for key, value in (
            ("description", self.description),
            ("profile", self.profile),
            ("notes", self.notes),
            ("addedAt", self.added_at),
        ):
            if value:
                out[key] = value
        return out


def case_from_dict(payload: dict, *, manifest_path: Optional[str] = None) -> DatasetCase:
    """Parse a `DatasetCase` manifest. Strict: an unparseable case raises rather than being skipped."""
    try:
        footage_raw = payload["footage"]
        footage = FootageReference(
            path=str(footage_raw["path"]),
            origin=str(footage_raw["origin"]),
            licence=str(footage_raw["licence"]),
            sha256=footage_raw.get("sha256"),
            duration_seconds=_opt_float(footage_raw.get("durationSeconds")),
            fps=_opt_float(footage_raw.get("fps")),
            resolution=footage_raw.get("resolution"),
            anonymisation=footage_raw.get("anonymisation"),
        )
        expectations = [
            Expectation(
                kind=str(e["kind"]),
                type=str(e["type"]),
                count=_opt_int(e.get("count")),
                count_tolerance=int(e.get("countTolerance") or 0),
                from_seconds=_opt_float(e.get("fromSeconds")),
                to_seconds=_opt_float(e.get("toSeconds")),
                zone_id=e.get("zoneId"),
                min_confidence=_opt_float(e.get("minConfidence")),
                absent=bool(e.get("absent", False)),
                notes=e.get("notes"),
            )
            for e in payload.get("expectations") or []
        ]
        return DatasetCase(
            id=str(payload["id"]),
            category=str(payload["category"]),
            title=str(payload["title"]),
            footage=footage,
            description=payload.get("description"),
            zones=list(payload.get("zones") or []),
            profile=payload.get("profile"),
            options=dict(payload.get("options") or {}),
            expectations=expectations,
            notes=payload.get("notes"),
            future_improvements=list(payload.get("futureImprovements") or []),
            added_at=payload.get("addedAt"),
            manifest_path=manifest_path,
        )
    except KeyError as exc:
        where = manifest_path or payload.get("id", "<unknown>")
        raise DatasetError(f"dataset case {where} is missing required field {exc}") from exc


class DatasetLibrary:
    """The catalogue. Loads every `<root>/<category>/cases/*.json` manifest.

    The library is **inventory, not execution**: it knows what cases exist, which have footage on this
    machine, and how the corpus is distributed across scenarios. Running a case is `evaluation.py`'s
    job — keeping those apart is what lets `vip dataset list` work in CI, where no footage is pulled.
    """

    def __init__(self, root: Optional[str] = None) -> None:
        self.root = os.path.abspath(root or DATASETS_ROOT)
        self._cases: Dict[str, DatasetCase] = {}

    # --- loading ----------------------------------------------------------

    def load(self) -> "DatasetLibrary":
        self._cases.clear()
        for category in SCENARIO_CATEGORIES:
            case_dir = os.path.join(self.root, category, "cases")
            if not os.path.isdir(case_dir):
                continue
            for name in sorted(os.listdir(case_dir)):
                if not name.endswith(".json"):
                    continue
                path = os.path.join(case_dir, name)
                with open(path, encoding="utf-8") as fh:
                    payload = json.load(fh)
                case = case_from_dict(payload, manifest_path=path)
                if case.category != category:
                    raise DatasetError(
                        f"case '{case.id}' declares category '{case.category}' but lives under "
                        f"'{category}/' — the directory is the source of truth"
                    )
                if case.id in self._cases:
                    raise DatasetError(f"duplicate dataset case id '{case.id}'")
                self._cases[case.id] = case
        return self

    def add(self, case: DatasetCase) -> DatasetCase:
        """Register a case directly. Used by tests and by in-memory corpora."""
        if case.id in self._cases:
            raise DatasetError(f"duplicate dataset case id '{case.id}'")
        self._cases[case.id] = case
        return case

    # --- inventory --------------------------------------------------------

    def __len__(self) -> int:
        return len(self._cases)

    def __iter__(self) -> Iterator[DatasetCase]:
        return iter(self.cases())

    def cases(self, *, category: Optional[str] = None, available_only: bool = False) -> List[DatasetCase]:
        out = [c for c in self._cases.values() if category is None or c.category == category]
        if available_only:
            out = [c for c in out if c.available(os.path.dirname(self.root))]
        return sorted(out, key=lambda c: (SCENARIO_CATEGORIES.index(c.category), c.id))

    def get(self, case_id: str) -> Optional[DatasetCase]:
        return self._cases.get(case_id)

    def categories(self) -> List[str]:
        return [c for c in SCENARIO_CATEGORIES if any(x.category == c for x in self._cases.values())]

    def coverage(self) -> List[dict]:
        """Per-scenario coverage — how many cases exist and how many have footage on this machine.

        This is the milestone's honest scoreboard: it makes the *gaps* visible. A scenario with zero
        cases is not a scenario the platform handles, and printing that next to one with fifteen is
        the difference between a roadmap and a claim.
        """
        base = os.path.dirname(self.root)
        out = []
        for category in SCENARIO_CATEGORIES:
            cases = [c for c in self._cases.values() if c.category == category]
            out.append(
                {
                    "category": category,
                    "cases": len(cases),
                    "withFootage": sum(1 for c in cases if c.available(base)),
                    "expectations": sum(len(c.expectations) for c in cases),
                    "negativeExpectations": sum(len(c.negative_expectations) for c in cases),
                }
            )
        return out

    def missing_footage(self) -> List[DatasetCase]:
        base = os.path.dirname(self.root)
        return [c for c in self.cases() if not c.available(base)]


def render_coverage(coverage: Sequence[dict]) -> str:
    """A one-screen coverage table. Scenarios with no cases are printed too — the empty rows are the
    most informative part of the table."""
    lines = [
        f"{'scenario':<22} {'cases':>6} {'footage':>8} {'expects':>8} {'negative':>9}",
        "-" * 57,
    ]
    for row in coverage:
        lines.append(
            f"{row['category']:<22} {row['cases']:>6} {row['withFootage']:>8} "
            f"{row['expectations']:>8} {row['negativeExpectations']:>9}"
        )
    totals = {
        key: sum(int(r[key]) for r in coverage)
        for key in ("cases", "withFootage", "expectations", "negativeExpectations")
    }
    lines.append("-" * 57)
    lines.append(
        f"{'total':<22} {totals['cases']:>6} {totals['withFootage']:>8} "
        f"{totals['expectations']:>8} {totals['negativeExpectations']:>9}"
    )
    return "\n".join(lines)


def _opt_int(value) -> Optional[int]:  # noqa: ANN001
    return None if value is None else int(value)


def _opt_float(value) -> Optional[float]:  # noqa: ANN001
    return None if value is None else float(value)
