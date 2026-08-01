"""Capability maturity promotion (AI-5e, deliverable 7).

**The problem with the register as it stands.** `CAPABILITY_MATURITY.md` is a markdown table. Anyone
can promote Fire Detection to `Production` by typing the word, and there is no moment at which the
platform asks "on the strength of what?". Over a year that table drifts from a record of evidence into
a record of optimism, and by then nobody can tell which entries were ever measured.

**So promotion becomes a function, not an edit.** `promote()` takes a capability, a target level and
the *ids of the reports* that justify it, and returns a decision that is usually a refusal carrying
its reasons. The rules are the Architect's, stated once here and enforced everywhere:

    Experimental → Beta        needs a real-footage evaluation that passed
    Beta         → Production  needs, additionally, hardware evidence: a certified compatibility run,
                               a passed soak, and a benchmark that did not regress
    anything     → Deprecated  needs only a named successor (demotion is always allowed)

**Simulation never promotes anything.** That is the same rule as certification, expressed once more
because it is the rule that this whole milestone exists to protect: simulation proves architecture,
hardware proves production readiness, and the day those two blur is the day the register stops meaning
anything.

The register itself remains documentation — no runtime behavior reads it (CAPABILITY_MATURITY §3).
This module governs how it is *changed*, not what it does.

Stdlib-only.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from certification import is_hardware, weakest

MATURITY_LEVELS = ("experimental", "beta", "production", "deprecated")
_RANK = {level: i for i, level in enumerate(("experimental", "beta", "production"))}


@dataclass
class MaturityEvidence:
    """The reports a promotion rests on. Ids, not claims."""

    evidence_class: str = "simulated"
    benchmark_report_id: Optional[str] = None
    compatibility_report_id: Optional[str] = None
    capability_report_id: Optional[str] = None
    soak_report_id: Optional[str] = None
    certification_summary_id: Optional[str] = None
    evaluation_report_ids: List[str] = field(default_factory=list)
    #: Whether the cited certification actually reached `certified`. An id alone proves a run happened,
    #: not that it succeeded — and citing a failed run would otherwise look like citing a passing one.
    certification_status: Optional[str] = None
    #: Whether the cited soak passed, for the same reason.
    soak_passed: Optional[bool] = None
    #: Whether the cited benchmark comparison was accepted (no regression against the baseline).
    benchmark_accepted: Optional[bool] = None
    #: Whether the cited evaluations passed on real footage.
    evaluation_accepted: Optional[bool] = None

    def to_dict(self) -> dict:
        out: dict = {
            "evidenceClass": self.evidence_class,
            "evaluationReportIds": list(self.evaluation_report_ids),
        }
        for key, value in (
            ("benchmarkReportId", self.benchmark_report_id),
            ("compatibilityReportId", self.compatibility_report_id),
            ("capabilityReportId", self.capability_report_id),
            ("soakReportId", self.soak_report_id),
            ("certificationSummaryId", self.certification_summary_id),
        ):
            if value:
                out[key] = value
        return out


@dataclass
class Promotion:
    """The outcome of asking for a promotion. Refusal is the common case."""

    capability_id: str
    from_level: str
    to_level: str
    granted: bool
    evidence: MaturityEvidence
    blockers: List[str] = field(default_factory=list)
    decided_at: Optional[str] = None
    notes: Optional[str] = None

    def to_dict(self) -> dict:
        out = {
            "capabilityId": self.capability_id,
            "from": self.from_level,
            "to": self.to_level,
            "granted": self.granted,
            "evidence": self.evidence.to_dict(),
            "blockers": list(self.blockers),
            "decidedAt": self.decided_at or _now_iso(),
        }
        if self.notes:
            out["notes"] = self.notes
        return out


def promote(
    capability_id: str,
    *,
    current: str,
    target: str,
    evidence: MaturityEvidence,
    successor: Optional[str] = None,
    now_iso=None,  # noqa: ANN001
) -> Promotion:
    """Decide whether a capability may move from `current` to `target`.

    Deliberately total: every path returns a `Promotion`, and a refusal carries the full list of what
    is missing rather than the first thing that failed. An engineer who has to run the gate five times
    to discover five blockers stops running the gate.
    """
    stamp = now_iso or _now_iso
    blockers: List[str] = []
    for level, name in ((current, "current"), (target, "target")):
        if level not in MATURITY_LEVELS:
            blockers.append(f"unknown {name} maturity level '{level}'")
    if blockers:
        return Promotion(capability_id, current, target, False, evidence, blockers, stamp())

    if target == "deprecated":
        # Demotion is always allowed — but a deprecation with no successor strands whoever is using it.
        if not successor:
            blockers.append("deprecation requires a named successor capability")
        return Promotion(
            capability_id, current, target, not blockers, evidence, blockers, stamp(),
            notes=f"superseded by {successor}" if successor else None,
        )

    if current == "deprecated":
        blockers.append("a deprecated capability cannot be promoted; introduce a successor instead")
        return Promotion(capability_id, current, target, False, evidence, blockers, stamp())

    if _RANK[target] < _RANK[current]:
        # Demotion within the ladder is allowed and needs no evidence: discovering that something is
        # worse than believed must never be harder than claiming it is better.
        return Promotion(
            capability_id, current, target, True, evidence, [], stamp(),
            notes="demotion — no evidence required",
        )
    if _RANK[target] == _RANK[current]:
        return Promotion(
            capability_id, current, target, True, evidence, [], stamp(), notes="no change"
        )
    if _RANK[target] - _RANK[current] > 1:
        blockers.append(
            f"cannot skip a level: promote to '{MATURITY_LEVELS[_RANK[current] + 1]}' first"
        )

    blockers.extend(_beta_blockers(evidence))
    if target == "production":
        blockers.extend(_production_blockers(evidence))

    return Promotion(capability_id, current, target, not blockers, evidence, blockers, stamp())


def _beta_blockers(evidence: MaturityEvidence) -> List[str]:
    """Beta means "validated on limited real footage" (CAPABILITY_MATURITY §1). Simulation does not
    qualify, because a stub adapter returns whatever it was told to return."""
    out: List[str] = []
    if not evidence.evaluation_report_ids:
        out.append("beta requires at least one dataset evaluation on recorded footage")
    elif evidence.evaluation_accepted is False:
        out.append("the cited dataset evaluation did not pass")
    if evidence.evidence_class == "simulated":
        out.append(
            "evidence class is 'simulated' — beta requires recorded footage, not simulated frames"
        )
    return out


def _production_blockers(evidence: MaturityEvidence) -> List[str]:
    """Production means measured on real hardware. Every clause here maps to one of the Architect's
    four required artifacts: benchmark, compatibility, soak, certification."""
    out: List[str] = []
    if not is_hardware(evidence.evidence_class):
        out.append(
            f"evidence class is '{evidence.evidence_class}' — production requires hardware evidence"
        )
    if not evidence.compatibility_report_id:
        out.append("production requires a compatibility report from a physical device")
    if not evidence.certification_summary_id:
        out.append("production requires a certification summary")
    elif evidence.certification_status != "certified":
        out.append(
            f"the cited certification summary is '{evidence.certification_status or 'unknown'}', "
            "not 'certified'"
        )
    if not evidence.soak_report_id:
        out.append("production requires a long-duration soak report")
    elif evidence.soak_passed is not True:
        out.append("the cited soak report did not pass")
    if not evidence.benchmark_report_id:
        out.append("production requires a benchmark measured on the target hardware")
    elif evidence.benchmark_accepted is False:
        out.append("the cited benchmark regressed against the accepted baseline")
    return out


class MaturityRegister:
    """An in-memory view of the capability register, changed only through `promote()`.

    This is the enforcement point for "maturity is never edited manually": the register holds levels,
    and the only mutator applies a granted `Promotion`. A refused promotion leaves the level untouched
    and the refusal in the history, which is the record you want when someone asks in six months why
    Fire Detection is still Experimental.
    """

    def __init__(self, levels: Optional[Dict[str, str]] = None) -> None:
        self._levels: Dict[str, str] = dict(levels or {})
        self.history: List[Promotion] = []

    def level(self, capability_id: str) -> str:
        return self._levels.get(capability_id, "experimental")

    def levels(self) -> Dict[str, str]:
        return dict(self._levels)

    def request(
        self,
        capability_id: str,
        target: str,
        evidence: MaturityEvidence,
        *,
        successor: Optional[str] = None,
        now_iso=None,  # noqa: ANN001
    ) -> Promotion:
        decision = promote(
            capability_id,
            current=self.level(capability_id),
            target=target,
            evidence=evidence,
            successor=successor,
            now_iso=now_iso,
        )
        self.history.append(decision)
        if decision.granted:
            self._levels[capability_id] = target
        return decision

    def refused(self) -> List[Promotion]:
        return [p for p in self.history if not p.granted]

    def evidence_class(self) -> str:
        return weakest([p.evidence.evidence_class for p in self.history]) if self.history else "simulated"

    def render(self) -> str:
        lines = [f"{'capability':<34} {'maturity':<14}", "-" * 49]
        for capability_id in sorted(self._levels):
            lines.append(f"{capability_id[:34]:<34} {self._levels[capability_id]:<14}")
        return "\n".join(lines)


def render_promotion(promotion: Promotion) -> str:
    verb = "GRANTED" if promotion.granted else "REFUSED"
    lines = [
        f"{verb}: {promotion.capability_id} {promotion.from_level} → {promotion.to_level}",
    ]
    for blocker in promotion.blockers:
        lines.append(f"  - {blocker}")
    if promotion.notes:
        lines.append(f"  ({promotion.notes})")
    return "\n".join(lines)


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"


__all__ = [
    "MATURITY_LEVELS",
    "MaturityEvidence",
    "Promotion",
    "promote",
    "MaturityRegister",
    "render_promotion",
]
