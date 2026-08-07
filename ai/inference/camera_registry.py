"""The camera compatibility registry (AI-5e, Architect recommendation 1).

**Why this compounds.** Everything else in AI-5e is a procedure that runs once per device. This is the
thing that makes the *second* deployment of a Hikvision cheaper than the first: what firmware it was
on, which sub-stream actually worked, that its ONVIF `GetStreamUri` returns a credentialed URI you
must strip, that it needs RTSP-over-TCP because its UDP is unusable on wifi. That knowledge currently
lives in whoever happened to do the install. Written down, it becomes an asset; unwritten, it is
re-learned at every site at full cost.

**Every entry starts at `pending-validation` and stays there until hardware says otherwise.** The
registry ships pre-populated with the vendors the pilot market will meet — Hikvision, Dahua, CP Plus,
Axis, UNV, generic ONVIF, generic RTSP, DVR/NVR — with **no compatibility claim attached to any of
them**. Those rows are a to-do list, not a support matrix, and `certify()` is the only way a row's
status changes.

Entries are JSON under `profiles/cameras/`, so adding a device is a data change, never a code change —
the same discipline as deployment and recovery profiles.

Stdlib-only.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence

from certification import CERTIFICATION_STATUSES, is_hardware, verdict_for, weakest

REGISTRY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "profiles", "cameras")

TARGET_KINDS = ("camera", "dvr", "nvr", "encoder", "edge-device", "recording")


class RegistryError(ValueError):
    """A malformed or contradictory registry entry."""


@dataclass
class CameraRegistryEntry:
    """One device the platform has met, or expects to meet."""

    id: str
    manufacturer: str
    model: str
    kind: str = "camera"
    firmware: List[str] = field(default_factory=list)
    transports: List[str] = field(default_factory=list)
    onvif: bool = False
    stream_profiles: List[dict] = field(default_factory=list)
    known_issues: List[str] = field(default_factory=list)
    recommended_settings: dict = field(default_factory=dict)
    status: str = "pending-validation"
    certification_version: Optional[str] = None
    certified_at: Optional[str] = None
    evidence: List[str] = field(default_factory=list)
    evidence_class: str = "simulated"
    updated_at: Optional[str] = None
    notes: Optional[str] = None

    def __post_init__(self) -> None:
        if self.status not in CERTIFICATION_STATUSES:
            raise RegistryError(f"unknown certification status '{self.status}'")
        if self.kind not in TARGET_KINDS:
            raise RegistryError(f"unknown target kind '{self.kind}'")
        # The invariant that keeps the registry honest: a certified row must be able to point at the
        # evidence. Without this, "certified" degrades into "someone was fairly sure".
        if self.status == "certified" and not self.evidence:
            raise RegistryError(f"entry '{self.id}' claims certification with no evidence")
        if self.status == "certified" and not is_hardware(self.evidence_class):
            raise RegistryError(
                f"entry '{self.id}' claims certification on '{self.evidence_class}' evidence; "
                "certification requires a run against physical hardware"
            )

    @property
    def label(self) -> str:
        return f"{self.manufacturer} {self.model}"

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "kind": self.kind,
            "firmware": list(self.firmware),
            "transports": list(self.transports),
            "onvif": self.onvif,
            "knownIssues": list(self.known_issues),
            "recommendedSettings": dict(self.recommended_settings),
            "status": self.status,
            "evidence": list(self.evidence),
            "evidenceClass": self.evidence_class,
            "updatedAt": self.updated_at or _now_iso(),
        }
        if self.stream_profiles:
            out["streamProfiles"] = list(self.stream_profiles)
        for key, value in (
            ("certificationVersion", self.certification_version),
            ("certifiedAt", self.certified_at),
            ("notes", self.notes),
        ):
            if value:
                out[key] = value
        return out


def entry_from_dict(payload: dict) -> CameraRegistryEntry:
    return CameraRegistryEntry(
        id=str(payload["id"]),
        manufacturer=str(payload["manufacturer"]),
        model=str(payload["model"]),
        kind=str(payload.get("kind", "camera")),
        firmware=list(payload.get("firmware") or []),
        transports=list(payload.get("transports") or []),
        onvif=bool(payload.get("onvif", False)),
        stream_profiles=list(payload.get("streamProfiles") or []),
        known_issues=list(payload.get("knownIssues") or []),
        recommended_settings=dict(payload.get("recommendedSettings") or {}),
        status=str(payload.get("status", "pending-validation")),
        certification_version=payload.get("certificationVersion"),
        certified_at=payload.get("certifiedAt"),
        evidence=list(payload.get("evidence") or []),
        evidence_class=str(payload.get("evidenceClass", "simulated")),
        updated_at=payload.get("updatedAt"),
        notes=payload.get("notes"),
    )


class CameraRegistry:
    """The permanent record. Loads `profiles/cameras/*.json`; writes back on certification."""

    def __init__(self, directory: Optional[str] = None) -> None:
        # ⛔ `VIP_CAMERA_REGISTRY_DIR` exists because the deployed image cannot be written to (P-9 A6).
        # The container runs as non-root and `/app` is owned by root — deliberately, since gate 0
        # compares the container's `/app` byte-for-byte against `ai/inference` and a runtime that
        # rewrites its own files stops matching the image it was built from. So `--write-registry`
        # inside the deployed container raised `PermissionError` on the first profile it tried to
        # save, which is the exact command a field engineer runs after certifying a real camera.
        #
        # ⚠️ The fix is a writable location, never a writable image. Point this at a mounted volume.
        self.directory = directory or os.environ.get("VIP_CAMERA_REGISTRY_DIR") or REGISTRY_DIR
        self._entries: Dict[str, CameraRegistryEntry] = {}

    def load(self) -> "CameraRegistry":
        self._entries.clear()
        if not os.path.isdir(self.directory):
            return self
        for name in sorted(os.listdir(self.directory)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(self.directory, name), encoding="utf-8") as fh:
                entry = entry_from_dict(json.load(fh))
            if entry.id in self._entries:
                raise RegistryError(f"duplicate registry entry id '{entry.id}'")
            self._entries[entry.id] = entry
        return self

    def add(self, entry: CameraRegistryEntry) -> CameraRegistryEntry:
        self._entries[entry.id] = entry
        return entry

    def get(self, entry_id: str) -> Optional[CameraRegistryEntry]:
        return self._entries.get(entry_id)

    def entries(self, *, status: Optional[str] = None) -> List[CameraRegistryEntry]:
        out = [e for e in self._entries.values() if status is None or e.status == status]
        return sorted(out, key=lambda e: (e.manufacturer.lower(), e.model.lower()))

    def __len__(self) -> int:
        return len(self._entries)

    # --- observation --------------------------------------------------------

    def observe(self, device, *, transports: Sequence[str] = ("rtsp",)) -> CameraRegistryEntry:  # noqa: ANN001
        """Fold an ONVIF-discovered device into the registry **without changing its status**.

        Discovery learns a great deal about a camera and certifies nothing about it. Keeping those
        apart here is what stops a successful `GetDeviceInformation` from being mistaken for a passing
        certification run, which would be the easiest possible way for this registry to start lying.
        """
        entry_id = getattr(device, "registry_id", None) or _slug(
            f"{getattr(device, 'manufacturer', 'unknown')}-{getattr(device, 'model', 'device')}"
        )
        existing = self._entries.get(entry_id)
        firmware = getattr(device, "firmware", None)
        entry = existing or CameraRegistryEntry(
            id=entry_id,
            manufacturer=getattr(device, "manufacturer", None) or "Unknown",
            model=getattr(device, "model", None) or "Unknown",
        )
        if firmware and firmware not in entry.firmware:
            entry.firmware.append(firmware)
        for transport in transports:
            if transport not in entry.transports:
                entry.transports.append(transport)
        entry.onvif = entry.onvif or bool(getattr(device, "onvif_version", None)) or True
        profiles = [p.to_dict() for p in getattr(device, "profiles", []) or []]
        if profiles:
            entry.stream_profiles = profiles
            preferred = next((p for p in profiles if p.get("preferredForAnalysis")), None)
            if preferred:
                entry.recommended_settings["streamProfile"] = preferred.get("name")
                if preferred.get("resolution"):
                    entry.recommended_settings["resolution"] = preferred["resolution"]
        entry.updated_at = _now_iso()
        return self.add(entry)

    def certify(
        self,
        entry_id: str,
        summary: dict,
        *,
        certification_version: str = "1.0.0",
        known_issues: Sequence[str] = (),
        recommended_settings: Optional[dict] = None,
    ) -> CameraRegistryEntry:
        """Apply a `CertificationSummary` to an entry.

        The entry's status becomes the summary's status verbatim. There is no path here that promotes
        a device the summary did not certify — which is exactly why the summary's own `pending-validation`
        rule (no hardware → no certification) is the only rule this whole subsystem needs to enforce.
        """
        entry = self._entries.get(entry_id)
        if entry is None:
            raise RegistryError(f"no registry entry '{entry_id}'")
        status = str(summary.get("status", "pending-validation"))
        evidence_class = str(summary.get("evidenceClass", "simulated"))
        evidence = [str(summary.get("id"))] if summary.get("id") else []
        for key in ("compatibilityId", "capabilityId", "soakId"):
            if summary.get(key):
                evidence.append(str(summary[key]))
        evidence.extend(str(b) for b in summary.get("benchmarkIds") or [])

        # ⛔ Built as a CANDIDATE and validated BEFORE anything is committed (P-9 A6).
        #
        # This used to mutate `entry` in place and re-run the invariants at the end. The invariants
        # fired correctly on a summary claiming `certified` from `simulated` evidence — and left the
        # entry mutated to exactly that. Measured: `save()` then wrote `"status": "certified"` with
        # `"evidenceClass": "simulated"` to `profiles/cameras/*.json`, and the next `load()` refused
        # the whole registry. A caught-and-ignored refusal became a corrupted profile that bricked
        # the registry on the following start.
        #
        # ⚠️ A refusal must leave the world exactly as it found it. Anything else means the guard
        # reports the right answer and causes the damage it was written to prevent.
        candidate = _as_kwargs(entry)
        candidate["status"] = status
        candidate["evidence_class"] = evidence_class
        candidate["evidence"] = sorted(set(evidence)) if status != "pending-validation" else []
        candidate["certification_version"] = certification_version if status == "certified" else None
        candidate["certified_at"] = _now_iso() if status == "certified" else None
        candidate["updated_at"] = _now_iso()

        issues = list(entry.known_issues)
        for issue in known_issues:
            if issue not in issues:
                issues.append(issue)
        # Blockers are the most useful thing a failed run produces; keeping them on the entry means
        # the next engineer reads "needs firmware ≥ 5.7" instead of rediscovering it.
        blockers = [str(b) for b in summary.get("blockers") or []]
        if blockers and status in ("failed", "not-supported"):
            for blocker in blockers:
                if blocker not in issues:
                    issues.append(blocker)
        candidate["known_issues"] = issues
        candidate["recommended_settings"] = {
            **entry.recommended_settings,
            **(recommended_settings or {}),
        }

        # Raises before a single field of the live entry has moved.
        validated = CameraRegistryEntry(**candidate)
        return self.add(validated)

    def promote_from_bundle(
        self,
        bundle: dict,
        *,
        certification_version: str = "1.0.0",
        recommended_settings: Optional[dict] = None,
    ) -> CameraRegistryEntry:
        """⭐ **The only supported way a device's status changes.** Promotion from a bundle, or not
        at all.

        `certify()` accepts a bare summary dict, which is fine for the CLI that just produced one and
        is not a provenance check: a hand-written dict with the right keys is indistinguishable from
        a measured one. This reads the **whole bundle** and refuses anything that does not hang
        together.

        ### What is checked, and why each one is not redundant

        | Check                                              | The forgery it stops                                     |
        | -------------------------------------------------- | -------------------------------------------------------- |
        | the bundle carries a `summary` and a `compatibility` | a summary invented without the run behind it            |
        | the summary's target matches the registry entry     | a bundle for one camera promoting another                |
        | ⭐ the verdict is RECOMPUTED from the bundle's own checks | `"status": "certified"` typed into a JSON file      |
        | the recomputed verdict equals the claimed one       | a bundle whose checks and conclusion disagree            |

        ⚠️ **The recomputation is the load-bearing one.** Every other check can be satisfied by
        someone careful with a text editor; this one cannot, because it derives the answer from the
        checks rather than reading it. A hand-written `certified` with no hardware checks under it
        comes back `pending-validation` and the promotion is refused with both values named.

        ⛔ It is still not a cryptographic signature. Someone determined can write a bundle whose
        checks all claim `hardware`. Closing that needs signed bundles — Track B, and worth it only
        once bundles start arriving from field engineers rather than from this repository.
        """
        if not isinstance(bundle, dict):
            raise RegistryError("a certification bundle must be an object")
        summary = bundle.get("summary")
        compatibility = bundle.get("compatibility")
        if not isinstance(summary, dict):
            raise RegistryError("bundle has no `summary` — nothing to promote from")
        if not isinstance(compatibility, dict):
            raise RegistryError("bundle has no `compatibility` report — its checks cannot be re-read")

        target_id = str((summary.get("target") or {}).get("id") or "")
        if not target_id:
            raise RegistryError("bundle summary names no target")
        if self._entries.get(target_id) is None:
            raise RegistryError(f"bundle targets '{target_id}', which is not a registry entry")

        checks = compatibility.get("checks")
        if not isinstance(checks, list) or not checks:
            raise RegistryError(f"bundle for '{target_id}' carries no checks to derive a verdict from")

        claimed = str(summary.get("status", "pending-validation"))
        derived = verdict_for(checks)
        if derived != claimed:
            raise RegistryError(
                f"bundle for '{target_id}' claims status '{claimed}' but its own checks support "
                f"'{derived}' — refusing to promote"
            )
        return self.certify(
            target_id,
            summary,
            certification_version=certification_version,
            recommended_settings=recommended_settings,
        )

    # --- persistence + reporting -------------------------------------------

    def save(self, directory: Optional[str] = None) -> List[str]:
        target = directory or self.directory
        os.makedirs(target, exist_ok=True)
        written = []
        for entry in self.entries():
            path = os.path.join(target, f"{entry.id}.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(entry.to_dict(), fh, indent=2, sort_keys=True)
                fh.write("\n")
            written.append(path)
        return written

    def matrix(self) -> List[dict]:
        """The official compatibility matrix (Architect AI-5e deliverable 4)."""
        return [
            {
                "device": e.label,
                "kind": e.kind,
                "transports": list(e.transports),
                "onvif": e.onvif,
                "status": e.status,
                "evidenceClass": e.evidence_class,
                "knownIssues": len(e.known_issues),
            }
            for e in self.entries()
        ]

    def summary(self) -> dict:
        by_status = {status: 0 for status in CERTIFICATION_STATUSES}
        for entry in self._entries.values():
            by_status[entry.status] += 1
        return {
            "devices": len(self._entries),
            "byStatus": by_status,
            "evidenceClass": weakest([e.evidence_class for e in self._entries.values()])
            if self._entries
            else "simulated",
        }


def render_matrix(matrix: Sequence[dict]) -> str:
    """The matrix as a table. Deliberately prints `Pending Validation` in full rather than a tick or a
    dash: a symbol invites a reader to interpret it optimistically, and words do not."""
    lines = [
        f"{'device':<34} {'kind':<9} {'transports':<16} {'status':<20} {'evidence':<16}",
        "-" * 99,
    ]
    for row in matrix:
        lines.append(
            f"{row['device'][:34]:<34} {row['kind']:<9} "
            f"{','.join(row['transports'])[:16]:<16} "
            f"{_title(row['status']):<20} {row['evidenceClass']:<16}"
        )
    return "\n".join(lines)


def _title(status: str) -> str:
    return status.replace("-", " ").title()


def _as_kwargs(entry: CameraRegistryEntry) -> dict:
    return {
        "id": entry.id,
        "manufacturer": entry.manufacturer,
        "model": entry.model,
        "kind": entry.kind,
        "firmware": entry.firmware,
        "transports": entry.transports,
        "onvif": entry.onvif,
        "stream_profiles": entry.stream_profiles,
        "known_issues": entry.known_issues,
        "recommended_settings": entry.recommended_settings,
        "status": entry.status,
        "certification_version": entry.certification_version,
        "certified_at": entry.certified_at,
        "evidence": entry.evidence,
        "evidence_class": entry.evidence_class,
        "updated_at": entry.updated_at,
        "notes": entry.notes,
    }


def _slug(value: str) -> str:
    out: List[str] = []
    for ch in value.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "unknown-device"


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
