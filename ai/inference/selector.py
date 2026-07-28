"""Model selection — the model-AGNOSTIC binding (ADR-0002). A capability declares WHAT it needs
(`{task, family, version-range, accelerator}`); the adapter resolves that to a concrete model from
the registry. Swapping the model is a registry/selector change, never a code change. Pure + stdlib.

Version-range grammar (Phase 1, intentionally small): "" / "*" match anything; an exact "1.2.0"
matches that version; ">=N" matches integer-major >= N; "N.x" matches that major. Richer semver
ranges are a later extension.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Mapping, Sequence


@dataclass(frozen=True)
class ModelSelector:
    task: str
    family: str = "*"
    version_range: str = ""
    accelerators: Sequence[str] = ("cpu",)


class SelectorUnresolved(LookupError):
    """No registry model satisfies the selector — the capability is unhealthy (no partial output)."""


def _major(version: str) -> int:
    head = version.split(".", 1)[0]
    return int(head) if head.isdigit() else 0


def version_matches(version_range: str, version: str) -> bool:
    vr = (version_range or "").strip()
    if vr in ("", "*"):
        return True
    if vr.startswith(">="):
        try:
            return _major(version) >= int(vr[2:].strip().split(".", 1)[0])
        except ValueError:
            return False
    if vr.endswith(".x"):
        return _major(version) == _major(vr[:-2])
    return vr == version


def matches(selector: ModelSelector, model: Mapping[str, object]) -> bool:
    """Does a registry model (dict with task/family/version/accelerators) satisfy the selector?"""
    if model.get("task") != selector.task:
        return False
    fam = str(model.get("family", "*"))
    if selector.family not in ("*", "") and fam not in ("*", selector.family):
        return False
    if not version_matches(selector.version_range, str(model.get("version", ""))):
        return False
    model_accels = set(map(str, model.get("accelerators", ["cpu"])))
    if selector.accelerators and not (set(selector.accelerators) & model_accels):
        return False
    return True


def select(selector: ModelSelector, available: List[Mapping[str, object]]) -> Mapping[str, object]:
    """Pick the best-matching model (highest version among matches), or raise SelectorUnresolved."""
    candidates = [m for m in available if matches(selector, m)]
    if not candidates:
        raise SelectorUnresolved(
            f"no model for task={selector.task} family={selector.family} "
            f"version={selector.version_range or '*'}"
        )
    return max(candidates, key=lambda m: _major(str(m.get("version", "0"))))
