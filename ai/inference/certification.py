"""Production certification harness (AI-5e) — the reusable procedure that turns a device into a
report, and a set of reports into a verdict.

**What this module is for.** Everything through AI-5d was proved in simulation. Simulation proves the
architecture; it cannot prove that a Hikvision on a warehouse VLAN streams for 72 hours without the
decoder wedging. AI-5e builds the framework that answers that question, and deliberately stops short
of answering it, because the answer requires hardware nobody has yet.

**The one invariant that makes this trustworthy: evidence class.** Every check records what it ran on
(`simulated` / `recorded-footage` / `hardware`), a report is only as strong as its weakest check, and
`certified` is unreachable without `hardware`. That rule lives in `_status_for()` and is negative-tested,
because a certification framework that can certify itself from its own simulations is worse than having
none — it converts a known unknown into a false assurance that someone will quote to a customer.

The harness drives the REAL runtime (SessionSupervisor → SessionRunner → StreamPipeline) against
whatever `StreamSource` it is given. Nothing in it knows or cares whether that source is simulated, a
recorded MP4 or a camera on a PoE switch — which is exactly why the same procedure can certify all
three, and why running it in CI against a simulated source is a meaningful smoke test of the procedure
itself rather than a self-certification.

Stdlib-only. No new architectural layer: this observes the frozen runtime, it does not extend it.
Mirrors packages/contracts/src/certification/certification.ts.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Sequence

# --- evidence -------------------------------------------------------------------

#: Weakest → strongest. The order is load-bearing: `weakest()` and `_status_for()` both read it.
EVIDENCE_CLASSES = ("simulated", "recorded-footage", "hardware")
_EVIDENCE_RANK: Dict[str, int] = {name: i for i, name in enumerate(EVIDENCE_CLASSES)}

#: Which evidence class a declared source type produces. This mapping is the single place where the
#: platform decides "does this count as real". `file` is `recorded-footage` because a recorded clip is
#: genuine perception evidence but says nothing about a device; everything that opens a live transport
#: is `hardware` because you cannot reach one without one existing.
_SOURCE_EVIDENCE: Dict[str, str] = {
    "simulated": "simulated",
    "file": "recorded-footage",
    "rtsp": "hardware",
    "onvif": "hardware",
    "http": "hardware",
    "usb": "hardware",
    "cloud": "hardware",
    "webrtc": "hardware",
}

CHECK_STATUSES = ("pass", "fail", "warn", "skipped", "not-executed")
CERTIFICATION_STATUSES = (
    "pending-validation",
    "in-validation",
    "certified",
    "failed",
    "not-supported",
)


def evidence_for_source(source_type: str) -> str:
    """The evidence class a source type yields. Unknown types are treated as `simulated` — the
    conservative direction. Guessing upward here would be the one mistake that invalidates everything."""
    return _SOURCE_EVIDENCE.get(str(source_type or "").strip(), "simulated")


def weakest(classes: Iterable[str]) -> str:
    """The weakest class in a set. A report that mixes a hardware connect check with a simulated
    throughput check is a simulated report — the strong check does not launder the weak one."""
    ranks = [_EVIDENCE_RANK.get(c, 0) for c in classes]
    if not ranks:
        return "simulated"
    return EVIDENCE_CLASSES[min(ranks)]


def is_hardware(evidence_class: str) -> bool:
    return evidence_class == "hardware"


# --- checks ---------------------------------------------------------------------


@dataclass(frozen=True)
class Check:
    """One certification check. Frozen: a recorded measurement is history, and history that can be
    edited after the fact is not evidence."""

    name: str
    status: str
    evidence_class: str
    detail: Optional[str] = None
    measured: Optional[float] = None
    expected: Optional[float] = None
    unit: Optional[str] = None
    mandatory: bool = True

    def __post_init__(self) -> None:
        if self.status not in CHECK_STATUSES:
            raise ValueError(f"unknown check status '{self.status}'")
        if self.evidence_class not in EVIDENCE_CLASSES:
            raise ValueError(f"unknown evidence class '{self.evidence_class}'")

    @property
    def blocking(self) -> bool:
        """A mandatory check that did not pass. `warn` does not block; `skipped`/`not-executed` do,
        because "we never measured it" is not evidence that it works."""
        return self.mandatory and self.status != "pass" and self.status != "warn"

    def to_dict(self) -> dict:
        out: dict = {
            "name": self.name,
            "status": self.status,
            "mandatory": self.mandatory,
            "evidenceClass": self.evidence_class,
        }
        if self.detail is not None:
            out["detail"] = self.detail
        if self.measured is not None:
            out["measured"] = round(float(self.measured), 4)
        if self.expected is not None:
            out["expected"] = round(float(self.expected), 4)
        if self.unit is not None:
            out["unit"] = self.unit
        return out


@dataclass(frozen=True)
class CertificationTarget:
    """A row of the certification matrix."""

    id: str
    label: str
    kind: str = "camera"
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None
    serial_number: Optional[str] = None
    transports: Sequence[str] = ()
    capabilities: Optional[dict] = None

    def to_dict(self) -> dict:
        device: dict = {}
        for key, value in (
            ("manufacturer", self.manufacturer),
            ("model", self.model),
            ("firmware", self.firmware),
            ("serialNumber", self.serial_number),
        ):
            if value:
                device[key] = value
        device.setdefault("tags", [])
        out: dict = {
            "id": self.id,
            "label": self.label,
            "device": device,
            "transports": list(self.transports),
            "kind": self.kind,
        }
        if self.capabilities is not None:
            out["capabilities"] = dict(self.capabilities)
        return out


# --- the harness ----------------------------------------------------------------


@dataclass
class CertificationBudget:
    """The thresholds the quantitative checks are judged against. Deliberately separate from
    `PerformanceBudget` (AI-5a): that one governs benchmarks, this one governs certification, and
    conflating them would mean a device could only be certified on the box the baseline was taken on."""

    min_sustained_fps: Optional[float] = None
    max_inference_latency_p95_ms: Optional[float] = None
    max_frame_loss_percent: Optional[float] = None
    max_reconnect_seconds: Optional[float] = None
    max_startup_ms: Optional[float] = None


class CertificationHarness:
    """Runs the standard certification procedure against one target.

    Usage is two-phase on purpose. `observe_session()` collects everything the runtime can measure by
    itself; `record()` accepts measurements only a human can make (pulling a cable, power-cycling a
    DVR). Checks nobody supplied stay `not-executed` and keep blocking, so an incomplete run reads as
    incomplete rather than as a pass with gaps.
    """

    #: Checks the procedure requires. A target that never produces one of these cannot be certified.
    REQUIRED_CHECKS = (
        "connect",
        "stream-acquisition",
        "credential-redaction",
        "frame-accounting",
        "reconnect-recovery",
        "clean-shutdown",
    )

    def __init__(
        self,
        target: CertificationTarget,
        *,
        runtime_version: str = "1.0.0",
        certification_version: str = "1.0.0",
        budget: Optional[CertificationBudget] = None,
        environment: Optional[dict] = None,
        now_iso: Callable[[], str] = None,  # noqa: ANN001 - defaults to wall clock
    ) -> None:
        self.target = target
        self.runtime_version = runtime_version
        self.certification_version = certification_version
        self.budget = budget or CertificationBudget()
        self.environment = environment
        self._now_iso = now_iso or _now_iso
        self._checks: List[Check] = []
        self._selected_profile: Optional[str] = None
        self._notes: List[str] = []

    # --- collection ---------------------------------------------------------

    def record(self, check: Check) -> Check:
        """Add a check. A later check with the same name REPLACES an earlier one — an operator
        supplying a real `reconnect-recovery` measurement should overwrite the `not-executed`
        placeholder, not sit beside it."""
        self._checks = [c for c in self._checks if c.name != check.name]
        self._checks.append(check)
        return check

    @property
    def checks(self) -> List[Check]:
        return list(self._checks)

    def note(self, text: str) -> None:
        self._notes.append(text)

    def observe_session(
        self,
        diagnostics: dict,
        *,
        source_type: Optional[str] = None,
        secret: Optional[str] = None,
        capabilities: Optional[dict] = None,
        requested_fps: Optional[float] = None,
        kpis: Optional[dict] = None,
    ) -> List[Check]:
        """Derive every automatically-measurable check from one session's diagnostics.

        `diagnostics` is `SessionRunner.diagnostics()` — the runtime's own `SessionDiagnostics` view
        (`ingestion` = source tier, `backpressure` = pipeline tier). Reading the runtime's existing
        output rather than instrumenting it is what keeps this observational: certification measures
        the frozen runtime, it does not modify it. `kpis` is an optional `BenchmarkKpis` dict for the
        budgeted throughput/latency checks, which the session view does not carry.
        """
        ingestion = dict(diagnostics.get("ingestion") or {})
        backpressure = dict(diagnostics.get("backpressure") or {})
        measurements = dict(kpis or {})
        declared = source_type or ingestion.get("sourceType") or "simulated"
        ev = evidence_for_source(declared)
        caps = capabilities if capabilities is not None else (self.target.capabilities or {})
        out: List[Check] = []

        # 1. Connect — did the source ever open? `connectedAt` is set the first time it did and is not
        #    cleared on disconnect, so this stays true for a session that connected and later dropped
        #    (which is a reconnect story, not a connectivity failure).
        connected = bool(ingestion.get("connectedAt")) or int(ingestion.get("framesRead") or 0) > 0
        out.append(
            self.record(
                Check(
                    name="connect",
                    status="pass" if connected else "fail",
                    evidence_class=ev,
                    measured=float(ingestion.get("reconnectCount") or 0),
                    unit="reconnects",
                    detail=None if connected else f"the source never opened: {ingestion.get('lastError')}",
                )
            )
        )

        # 2. Stream acquisition — frames actually reached the analyzer. A source that connects and
        #    delivers nothing is the most common real-world failure (wrong profile path, a codec the
        #    decoder refuses), and it is completely invisible to a connectivity check.
        processed = int(backpressure.get("framesProcessed") or 0)
        out.append(
            self.record(
                Check(
                    name="stream-acquisition",
                    status="pass" if processed > 0 else "fail",
                    evidence_class=ev,
                    measured=float(processed),
                    unit="frames",
                    detail=None if processed else "connected but delivered no analyzable frames",
                )
            )
        )

        # 3. Credential redaction — nothing anywhere may echo a secret. Checked against the redacted
        #    URI the runtime reports AND, when the operator supplies the secret, against the whole
        #    diagnostics document.
        out.append(self.record(self._redaction_check(diagnostics, ingestion, secret, ev)))

        # 4. Frame accounting — sampling and loss must remain distinguishable. If they ever collapse
        #    into one number, every SLA conversation with a customer becomes unfalsifiable.
        out.append(self.record(self._accounting_check(backpressure, ev)))

        # 5. Declared capabilities consumed rather than probed (Architect AI-5e deliverable 1).
        out.append(self.record(self._capabilities_check(caps, ev)))

        # 6. Stream-profile selection — the cheapest performance decision in the platform.
        out.append(self.record(self._profile_check(caps, ev)))

        # 7. FPS clamped into the device's declared range.
        if requested_fps is not None:
            out.append(self.record(self._fps_range_check(caps, requested_fps, ev)))

        # 8..10. Budgeted throughput/latency/loss, when a budget was supplied.
        out.extend(self._budget_checks(measurements, backpressure, ev))
        return out

    def not_executed(self, name: str, detail: str, *, mandatory: bool = True) -> Check:
        """Record a check the harness could not perform. Used for the physical steps — a cable pull,
        a power cycle — that only a person standing next to the device can do."""
        return self.record(
            Check(
                name=name,
                status="not-executed",
                evidence_class="simulated",
                detail=detail,
                mandatory=mandatory,
            )
        )

    def seed_manual_checks(self) -> List[Check]:
        """Pre-register every required check that the harness cannot measure on its own, so a report
        produced without them lists them as outstanding instead of omitting them silently."""
        seeded: List[Check] = []
        for name, detail in (
            ("reconnect-recovery", "requires a deliberate link interruption on the physical device"),
            ("clean-shutdown", "requires a full teardown observation on the physical device"),
        ):
            if not any(c.name == name for c in self._checks):
                seeded.append(self.not_executed(name, detail))
        return seeded

    # --- individual checks --------------------------------------------------

    def _redaction_check(self, diagnostics: dict, ingestion: dict, secret: Optional[str], ev: str) -> Check:
        uri = str(ingestion.get("source") or "")
        leaked: List[str] = []
        if "@" in uri and ":" in uri.split("@")[0].split("//")[-1]:
            leaked.append("source uri carries an inline credential")
        if secret:
            # `repr` walks the whole nested document, so a secret hiding in a failure's lastError or
            # a nested config is caught too — a leak in an error string is still a leak.
            if secret in repr(diagnostics):
                leaked.append("a supplied secret appears in the session diagnostics")
        return Check(
            name="credential-redaction",
            status="pass" if not leaked else "fail",
            evidence_class=ev,
            detail="; ".join(leaked) or None,
        )

    def _accounting_check(self, backpressure: dict, ev: str) -> Check:
        """`framesSkipped` (sampling policy) and `framesDropped` (backpressure loss) are different
        facts. AI-5b separated them; certification asserts the separation survived, because a runtime
        that conflates them cannot tell a customer whether it missed anything."""
        has_skipped = "framesSkipped" in backpressure
        has_dropped = "framesDropped" in backpressure
        if has_skipped and has_dropped:
            return Check(
                name="frame-accounting",
                status="pass",
                evidence_class=ev,
                measured=float(backpressure.get("framesDropped") or 0),
                unit="frames-dropped",
                detail=(
                    f"skipped={int(backpressure.get('framesSkipped') or 0)} (sampling) · "
                    f"dropped={int(backpressure.get('framesDropped') or 0)} (backpressure)"
                ),
            )
        missing = [
            name
            for name, present in (("framesSkipped", has_skipped), ("framesDropped", has_dropped))
            if not present
        ]
        return Check(
            name="frame-accounting",
            status="fail",
            evidence_class=ev,
            detail=f"sampling and loss are not separately reported (missing {', '.join(missing)})",
        )

    def _capabilities_check(self, caps: dict, ev: str) -> Check:
        if not caps:
            return Check(
                name="declared-capabilities",
                status="skipped",
                evidence_class=ev,
                mandatory=False,
                detail="no capabilities declared for this target; the runtime used its defaults",
            )
        return Check(
            name="declared-capabilities",
            status="pass",
            evidence_class=ev,
            mandatory=False,
            measured=float(len(caps.get("streamProfiles") or [])),
            unit="profiles",
            detail="capabilities consumed from the declaration; the device was not probed",
        )

    def _profile_check(self, caps: dict, ev: str) -> Check:
        profiles = list(caps.get("streamProfiles") or [])
        if len(profiles) < 2:
            return Check(
                name="stream-profile-selection",
                status="skipped",
                evidence_class=ev,
                mandatory=False,
                detail="device publishes fewer than two profiles; nothing to choose between",
            )
        preferred = [p for p in profiles if p.get("preferredForAnalysis")]
        if not preferred:
            return Check(
                name="stream-profile-selection",
                status="warn",
                evidence_class=ev,
                mandatory=False,
                detail=(
                    "device publishes multiple profiles but none is marked preferredForAnalysis — "
                    "the runtime will analyze the main stream and waste decode budget"
                ),
            )
        self._selected_profile = str(preferred[0].get("name"))
        return Check(
            name="stream-profile-selection",
            status="pass",
            evidence_class=ev,
            mandatory=False,
            detail=f"analyzing '{self._selected_profile}' ({preferred[0].get('resolution', 'unknown')})",
        )

    def _fps_range_check(self, caps: dict, requested: float, ev: str) -> Check:
        rng = caps.get("fpsRange") if isinstance(caps, dict) else None
        if not isinstance(rng, dict):
            return Check(
                name="fps-within-declared-range",
                status="skipped",
                evidence_class=ev,
                mandatory=False,
                detail="device declares no fps range",
            )
        lo, hi = float(rng.get("min", 1)), float(rng.get("max", 120))
        ok = lo <= requested <= hi
        return Check(
            name="fps-within-declared-range",
            status="pass" if ok else "fail",
            evidence_class=ev,
            mandatory=False,
            measured=requested,
            expected=hi,
            unit="fps",
            detail=None if ok else f"requested {requested} fps outside the device range {lo}–{hi}",
        )

    def _budget_checks(self, metrics: dict, backpressure: dict, ev: str) -> List[Check]:
        out: List[Check] = []
        b = self.budget
        if b.min_sustained_fps is not None:
            fps = float(metrics.get("fps") or 0.0)
            out.append(
                self.record(
                    Check(
                        name="sustained-fps",
                        status="pass" if fps >= b.min_sustained_fps else "fail",
                        evidence_class=ev,
                        measured=fps,
                        expected=b.min_sustained_fps,
                        unit="fps",
                    )
                )
            )
        if b.max_inference_latency_p95_ms is not None:
            p95 = float(metrics.get("inferenceLatencyP95Ms") or 0.0)
            out.append(
                self.record(
                    Check(
                        name="inference-latency-p95",
                        status="pass" if p95 <= b.max_inference_latency_p95_ms else "fail",
                        evidence_class=ev,
                        measured=p95,
                        expected=b.max_inference_latency_p95_ms,
                        unit="ms",
                    )
                )
            )
        if b.max_frame_loss_percent is not None:
            loss = float(metrics.get("droppedFramePercent", _loss_percent(backpressure)))
            out.append(
                self.record(
                    Check(
                        name="frame-loss",
                        status="pass" if loss <= b.max_frame_loss_percent else "fail",
                        evidence_class=ev,
                        measured=loss,
                        expected=b.max_frame_loss_percent,
                        unit="%",
                    )
                )
            )
        return out

    # --- reports ------------------------------------------------------------

    def compatibility_report(self, *, report_id: Optional[str] = None) -> dict:
        """Can the runtime ingest from this device — connect, stream, reconnect, redact, shut down.
        Never "does it detect correctly": that is the capability report's question."""
        checks = self.checks
        ev = weakest([c.evidence_class for c in checks]) if checks else "simulated"
        report = {
            "id": report_id or f"compat_{self.target.id}",
            "target": self.target.to_dict(),
            "runtimeVersion": self.runtime_version,
            "checks": [c.to_dict() for c in checks],
            "status": self._status_for(checks, ev),
            "evidenceClass": ev,
            "recordedAt": self._now_iso(),
        }
        if self._selected_profile:
            report["selectedProfile"] = self._selected_profile
        if self.environment:
            report["environment"] = dict(self.environment)
        if self._notes:
            report["notes"] = " · ".join(self._notes)[:2000]
        return report

    def _status_for(self, checks: Sequence[Check], evidence_class: str) -> str:
        """**The rule that makes this framework honest.**

        No hardware evidence → `pending-validation`, whatever the checks say. A perfect run against a
        simulated source proves the procedure works; it proves nothing about a device, and reporting
        it as `certified` would be a lie the platform tells itself first and a customer second.
        """
        if not checks:
            return "pending-validation"
        if not is_hardware(evidence_class):
            return "pending-validation"
        return "failed" if any(c.blocking for c in checks) else "certified"

    def missing_required(self) -> List[str]:
        """Required checks that were never recorded, or recorded as not-executed/skipped."""
        by_name = {c.name: c for c in self._checks}
        out: List[str] = []
        for name in self.REQUIRED_CHECKS:
            check = by_name.get(name)
            if check is None or check.status in ("not-executed", "skipped"):
                out.append(name)
        return out

    def blockers(self, evidence_class: Optional[str] = None) -> List[str]:
        """Everything standing between this target and `certified`. The field that makes a
        `pending-validation` verdict actionable instead of a shrug."""
        checks = self.checks
        ev = evidence_class or (weakest([c.evidence_class for c in checks]) if checks else "simulated")
        out: List[str] = []
        if not is_hardware(ev):
            out.append(
                f"evidence class is '{ev}' — certification requires a run against physical hardware"
            )
        for name in self.missing_required():
            out.append(f"required check '{name}' was not executed")
        for check in checks:
            if check.status == "fail":
                out.append(f"check '{check.name}' failed: {check.detail or 'no detail'}")
        return out

    def summary(
        self,
        *,
        summary_id: Optional[str] = None,
        compatibility_id: Optional[str] = None,
        capability_id: Optional[str] = None,
        soak_id: Optional[str] = None,
        benchmark_ids: Sequence[str] = (),
        deployment_class: Optional[str] = None,
        extra_blockers: Sequence[str] = (),
    ) -> dict:
        checks = self.checks
        ev = weakest([c.evidence_class for c in checks]) if checks else "simulated"
        blockers = self.blockers(ev) + list(extra_blockers)
        passed = sum(1 for c in checks if c.status == "pass")
        failed = sum(1 for c in checks if c.status == "fail")
        status = self._status_for(checks, ev)
        if status == "certified" and blockers:
            # Belt and braces: a summary can carry blockers the compatibility report never saw (a
            # failed soak, a missing benchmark). Any blocker at all means not certified.
            status = "failed" if failed else "pending-validation"
        out = {
            "id": summary_id or f"cert_{self.target.id}",
            "target": self.target.to_dict(),
            "runtimeVersion": self.runtime_version,
            "certificationVersion": self.certification_version,
            "status": status,
            "evidenceClass": ev,
            "blockers": blockers,
            "checksPassed": passed,
            "checksFailed": failed,
            "checksTotal": len(checks),
            "benchmarkIds": list(benchmark_ids),
            "recordedAt": self._now_iso(),
        }
        for key, value in (
            ("compatibilityId", compatibility_id),
            ("capabilityId", capability_id),
            ("soakId", soak_id),
            ("deploymentClass", deployment_class),
        ):
            if value:
                out[key] = value
        if self.environment:
            out["environment"] = dict(self.environment)
        return out


# --- capability observation -----------------------------------------------------


@dataclass
class CapabilityObservation:
    """What one perception capability produced on a target. `maturity` is the level held BEFORE the
    run — the observation is the evidence for changing it, never the change itself."""

    capability_id: str
    maturity: str = "experimental"
    event_type: Optional[str] = None
    detections: int = 0
    behaviors: int = 0
    events: int = 0
    evidence_class: str = "simulated"
    checks: List[Check] = field(default_factory=list)

    @property
    def exercised(self) -> bool:
        return (self.detections + self.behaviors + self.events) > 0

    def to_dict(self) -> dict:
        out = {
            "capabilityId": self.capability_id,
            "maturity": self.maturity,
            "exercised": self.exercised,
            "detections": self.detections,
            "behaviors": self.behaviors,
            "events": self.events,
            "checks": [c.to_dict() for c in self.checks],
            "evidenceClass": self.evidence_class,
        }
        if self.event_type:
            out["eventType"] = self.event_type
        return out


def capability_report(
    target_id: str,
    observations: Sequence[CapabilityObservation],
    *,
    runtime_version: str = "1.0.0",
    report_id: Optional[str] = None,
    now_iso: Callable[[], str] = None,  # noqa: ANN001
    notes: Optional[str] = None,
) -> dict:
    stamp = now_iso or _now_iso
    ev = weakest([o.evidence_class for o in observations]) if observations else "simulated"
    out = {
        "id": report_id or f"cap_{target_id}",
        "targetId": target_id,
        "runtimeVersion": runtime_version,
        "observations": [o.to_dict() for o in observations],
        "evidenceClass": ev,
        "recordedAt": stamp(),
    }
    if notes:
        out["notes"] = notes[:2000]
    return out


class CapabilityAccumulator:
    """Counts what each capability produced, one analysed frame at a time.

    A live session never assembles an `AnalyzeResult` — it deliberately retains nothing per frame, or
    a camera running for a week would grow without bound (AI-5b). So the live certification path
    accumulates counters as frames go past instead of asking for a document that must not exist.
    Attach it as the session's `on_result` sink.
    """

    def __init__(self, evidence_class: str = "simulated") -> None:
        self.evidence_class = evidence_class
        self.frames = 0
        self.detections_by_label: Dict[str, int] = {}
        self.behaviors_by_type: Dict[str, int] = {}
        self.composites_by_type: Dict[str, int] = {}
        self.events_by_type: Dict[str, int] = {}
        self._track_ids: set = set()
        self._behavior_ids: set = set()

    def __call__(self, analysis) -> None:  # noqa: ANN001 - video_analyzer.FrameAnalysis
        self.frames += 1
        for det in getattr(analysis, "detections", []) or []:
            label = str(det.get("label") or "object")
            self.detections_by_label[label] = self.detections_by_label.get(label, 0) + 1
        for track in getattr(analysis, "tracks", []) or []:
            self._track_ids.add(track.get("trackId"))
        for item, bucket in (
            (getattr(analysis, "behaviors", []) or [], self.behaviors_by_type),
            (getattr(analysis, "composites", []) or [], self.composites_by_type),
        ):
            for entry in item:
                # Count each behaviour ONCE, at its first appearance. A 19-second loiter emits a
                # result on every frame; counting those separately would report 190 loiterings.
                key = entry.get("behaviorId")
                if key in self._behavior_ids:
                    continue
                self._behavior_ids.add(key)
                btype = str(entry.get("behaviorType") or "behavior")
                bucket[btype] = bucket.get(btype, 0) + 1
        for event in getattr(analysis, "events", []) or []:
            etype = str(event.get("type") or "event")
            self.events_by_type[etype] = self.events_by_type.get(etype, 0) + 1

    @property
    def tracks(self) -> int:
        return len(self._track_ids)

    def observations(self, maturity: Callable[[str], str] = None) -> List["CapabilityObservation"]:  # noqa: ANN001
        level = maturity or (lambda _cap: "experimental")
        out: List[CapabilityObservation] = []
        for label, count in sorted(self.detections_by_label.items()):
            out.append(
                CapabilityObservation(
                    capability_id=f"detection.{label}",
                    event_type=f"perception.{label}.detected",
                    maturity=level(f"detection.{label}"),
                    detections=count,
                    evidence_class=self.evidence_class,
                )
            )
        if self.tracks:
            out.append(
                CapabilityObservation(
                    capability_id="tracking",
                    maturity=level("tracking"),
                    detections=self.tracks,
                    evidence_class=self.evidence_class,
                )
            )
        for source in (self.behaviors_by_type, self.composites_by_type):
            for btype, count in sorted(source.items()):
                out.append(
                    CapabilityObservation(
                        capability_id=btype,
                        maturity=level(btype),
                        behaviors=count,
                        events=self.events_by_type.get(btype, 0),
                        evidence_class=self.evidence_class,
                    )
                )
        if not out:
            # An empty observation set is itself a finding: the session ran and no capability
            # produced anything. Recording that beats returning an empty list nobody notices.
            out.append(
                CapabilityObservation(
                    capability_id="none-exercised",
                    maturity="experimental",
                    evidence_class=self.evidence_class,
                    checks=[
                        Check(
                            name="capability-exercised",
                            status="fail",
                            evidence_class=self.evidence_class,
                            detail=f"{self.frames} frames analysed and no capability produced output",
                        )
                    ],
                )
            )
        return out


def observations_from_summary(
    summary: dict, *, evidence_class: str, maturity: Callable[[str], str] = None  # noqa: ANN001
) -> List[CapabilityObservation]:
    """Turn an `AnalyzeResult.summary` into per-capability observations. Reads the counters the
    analyzer already produces — no new instrumentation, which is the same discipline AI-5d's health
    monitor follows."""
    level = maturity or (lambda _cap: "experimental")
    out: List[CapabilityObservation] = []
    detections = int(summary.get("detections") or 0)
    if detections or summary.get("model"):
        out.append(
            CapabilityObservation(
                capability_id="detection",
                event_type="perception.object.detected",
                maturity=level("detection"),
                detections=detections,
                evidence_class=evidence_class,
            )
        )
    tracking = summary.get("tracking") or {}
    if summary.get("trackingEnabled"):
        out.append(
            CapabilityObservation(
                capability_id="tracking",
                maturity=level("tracking"),
                detections=int(tracking.get("confirmedTracks") or 0),
                evidence_class=evidence_class,
            )
        )
    behavior = summary.get("behavior") or {}
    for analyzer in behavior.get("analyzers") or []:
        produced = int(analyzer.get("behaviorsProduced") or 0)
        out.append(
            CapabilityObservation(
                capability_id=str(analyzer.get("analyzer")),
                maturity=level(str(analyzer.get("analyzer"))),
                behaviors=produced,
                evidence_class=evidence_class,
            )
        )
    composite = summary.get("composite") or {}
    for analyzer in composite.get("analyzers") or []:
        out.append(
            CapabilityObservation(
                capability_id=str(analyzer.get("analyzer")),
                maturity=level(str(analyzer.get("analyzer"))),
                behaviors=int(analyzer.get("behaviorsProduced") or 0),
                evidence_class=evidence_class,
            )
        )
    return out


# --- the customer validation bundle ---------------------------------------------


def build_bundle(
    summary: dict,
    *,
    runtime_version: str = "1.0.0",
    bundle_id: Optional[str] = None,
    site: Optional[str] = None,
    compatibility: Optional[dict] = None,
    capability: Optional[dict] = None,
    soak: Optional[dict] = None,
    benchmarks: Sequence[dict] = (),
    configuration: Optional[dict] = None,
    health: Optional[dict] = None,
    recovery: Optional[dict] = None,
    logs: Sequence[str] = (),
    environment: Optional[dict] = None,
    notes: Optional[str] = None,
    now_iso: Callable[[], str] = None,  # noqa: ANN001
) -> dict:
    """The one artifact a customer sends back after a pilot (Architect AI-5e deliverable 8).

    `configuration` is passed through `redact_config()` unconditionally. A validation bundle travels
    by email between organisations, and the single worst outcome of this milestone would be a camera
    password making that journey.
    """
    stamp = now_iso or _now_iso
    out: dict = {
        "id": bundle_id or f"bundle_{summary.get('id', 'run')}",
        "bundleVersion": "1.0.0",
        "runtimeVersion": runtime_version,
        "generatedAt": stamp(),
        "summary": summary,
        "benchmarks": list(benchmarks),
        "configuration": redact_config(configuration or {}),
        "logs": [str(line)[:2000] for line in logs],
    }
    for key, value in (
        ("site", site),
        ("compatibility", compatibility),
        ("capability", capability),
        ("soak", soak),
        ("health", health),
        ("recovery", recovery),
        ("environment", environment),
        ("notes", notes),
    ):
        if value:
            out[key] = value
    return out


#: Keys whose values never leave the building. Matched case-insensitively as substrings, so
#: `rtspPassword`, `credential_ref` and `X-Auth-Token` are all caught.
_SECRET_KEY_HINTS = ("password", "secret", "token", "credential", "apikey", "api_key", "auth")


def redact_config(config: dict) -> dict:
    """Deep-redact a configuration document for external distribution. Values under a secret-ish key
    become `***`; URIs are redacted through the same helper the runtime's logs use, so the bundle and
    the logs can never disagree about what a credential looks like."""
    from stream_source import redact_uri  # noqa: WPS433 - local to keep the module import-light

    def _walk(value):  # noqa: ANN001, ANN202
        if isinstance(value, dict):
            out = {}
            for key, inner in value.items():
                if any(hint in str(key).lower() for hint in _SECRET_KEY_HINTS):
                    out[key] = "***"
                else:
                    out[key] = _walk(inner)
            return out
        if isinstance(value, list):
            return [_walk(v) for v in value]
        if isinstance(value, str) and "://" in value:
            return redact_uri(value)
        return value

    return _walk(dict(config))


# --- helpers --------------------------------------------------------------------


def _loss_percent(backpressure: dict) -> float:
    """Backpressure loss as a percentage of what the pipeline was offered. `framesSkipped` is
    deliberately NOT in the denominator: sampling is policy, not loss, and folding it in here would
    quietly re-create the conflation the frame-accounting check exists to prevent."""
    dropped = float(backpressure.get("framesDropped") or 0)
    processed = float(backpressure.get("framesProcessed") or 0)
    total = dropped + processed
    return 0.0 if total <= 0 else round(100.0 * dropped / total, 4)


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
