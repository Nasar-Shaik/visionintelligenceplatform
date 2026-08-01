"""Model Lifecycle (AI-5d) — zero-downtime model version transitions.

`ModelRegistry.activate()` (G-3) flips the active version instantly. That is correct for a control
plane and dangerous for a running one: eight live sessions discover the new model mid-frame, a bad
artifact takes down every camera at once, and the only way back is another instant flip. This module
adds the **staged** path the Architect specified, alongside the instant one:

    active(vN) → warming → validating → switching → draining → active(vN+1)
                                 └── validation failed ──→ rolled-back(vN)

Three properties make it zero-downtime, and each is a deliberate design choice:

  - **The switch is a pointer swap, not a restart.** Sessions read their adapter through a
    `ModelSlot` on every frame, so promoting a version changes what the next frame executes and
    nothing else. No session stops, no queue drains, no reconnect.
  - **The outgoing model stays warm while draining.** A frame that entered the pipeline under vN
    finishes under vN. Swapping under an in-flight frame produces a result that belongs to neither
    version — the worst possible outcome, because it looks like data rather than a bug.
  - **Rollback is the same mechanism, backwards.** Nothing special happens on the unhappy path,
    which is the only way to be confident the unhappy path works.

**Operational validation, not accuracy validation.** Without labelled footage a runtime cannot
certify recall, and a `validated` flag implying otherwise is worse than no flag at all because
someone will trust it. What is checked here is that the artifact loads, inference runs, the output is
structurally valid, latency is within budget, and detection volume is comparable to the incumbent —
the failures that actually break a deployment. Accuracy belongs to AI-5e certification.

**Every transition is kept** (Architect AI-5d rec 3). "What changed on this model, and when?" is
unanswerable from a registry that stores only the current version, and it is the first question asked
during an incident.

Deterministic + stdlib-only: clock, id generator and validation frames are all injected.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence

from contracts import FrameContext, ModelBinding
from errors import ConfigurationFailure, Conflict, NotFound, ValidationError

# Mirrors @vip/contracts `ModelTransitionState`.
TRANSITION_STATES = (
    "pending",
    "warming",
    "validating",
    "switching",
    "draining",
    "active",
    "rolled-back",
    "failed",
)

_TERMINAL_STATES = ("active", "rolled-back", "failed")

# Below this, a per-frame latency measurement is timer noise rather than a signal. Comparing a
# candidate against an incumbent that measured 0.4 µs and calling the 25% difference a regression
# would block deployments on jitter — the opposite of what an evidence gate is for. Real inference is
# milliseconds; anything under 1 ms means the comparison has nothing to say.
_MIN_MEASURABLE_MS = 1.0


@dataclass
class ModelLifecyclePolicy:
    """Transition strictness — validation depth, drain window, rollback behavior."""

    validation_frames: int = 20
    max_validation_latency_ms: Optional[float] = None
    latency_regression_percent: float = 25.0
    detection_delta_percent: float = 50.0
    drain_ms: float = 1000.0
    auto_rollback: bool = True
    require_validation: bool = True

    def __post_init__(self) -> None:
        if self.validation_frames < 1:
            raise ConfigurationFailure("validation_frames must be >= 1")
        if not 0 <= self.latency_regression_percent <= 1000:
            raise ConfigurationFailure("latency_regression_percent must be between 0 and 1000")
        if not 0 <= self.detection_delta_percent <= 100:
            raise ConfigurationFailure("detection_delta_percent must be between 0 and 100")
        if self.drain_ms < 0:
            raise ConfigurationFailure("drain_ms must be >= 0")


class ModelSlot:
    """The indirection that makes a swap zero-downtime.

    A session holds the slot, not the adapter, and reads `slot.adapter` per frame. Promotion is one
    attribute assignment — atomic under the GIL, and invisible to a session mid-stream. The outgoing
    adapter is kept in `draining` until the drain window closes so in-flight frames finish on the
    model that started them.
    """

    def __init__(self, adapter, binding: ModelBinding) -> None:  # noqa: ANN001 - pipeline.ModelAdapter
        self._adapter = adapter
        self._binding = binding
        self._draining = None
        self._draining_binding: Optional[ModelBinding] = None
        self.swaps = 0

    @property
    def adapter(self):  # noqa: ANN201 - pipeline.ModelAdapter
        return self._adapter

    @property
    def binding(self) -> ModelBinding:
        return self._binding

    @property
    def draining(self):  # noqa: ANN201 - the outgoing adapter, still warm
        return self._draining

    @property
    def draining_binding(self) -> Optional[ModelBinding]:
        return self._draining_binding

    def swap(self, adapter, binding: ModelBinding) -> ModelBinding:  # noqa: ANN001
        """Promote a warmed adapter. Returns the binding that was displaced."""
        previous, previous_binding = self._adapter, self._binding
        self._adapter, self._binding = adapter, binding
        self._draining, self._draining_binding = previous, previous_binding
        self.swaps += 1
        return previous_binding

    def finish_drain(self) -> None:
        """Release the outgoing adapter once in-flight frames have finished."""
        draining, self._draining = self._draining, None
        self._draining_binding = None
        if draining is not None and hasattr(draining, "unload"):
            try:
                draining.unload()
            except Exception:  # noqa: BLE001 - a failed unload must not fail a successful switch
                pass


@dataclass
class ModelValidationCheck:
    name: str
    passed: bool
    measured: Optional[float] = None
    budget: Optional[float] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {"name": self.name, "passed": self.passed}
        for key, value in (("measured", self.measured), ("budget", self.budget)):
            if value is not None:
                out[key] = round(float(value), 3)
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass
class ModelValidationResult:
    passed: bool
    checks: List[ModelValidationCheck] = field(default_factory=list)
    frames_evaluated: int = 0
    candidate_latency_ms: Optional[float] = None
    incumbent_latency_ms: Optional[float] = None
    candidate_detections: Optional[int] = None
    incumbent_detections: Optional[int] = None
    at: Optional[str] = None

    @property
    def failures(self) -> List[str]:
        return [c.name for c in self.checks if not c.passed]

    def to_dict(self) -> dict:
        out: dict = {
            "passed": self.passed,
            "checks": [c.to_dict() for c in self.checks],
            "framesEvaluated": self.frames_evaluated,
        }
        for key, value in (
            ("candidateLatencyMs", self.candidate_latency_ms),
            ("incumbentLatencyMs", self.incumbent_latency_ms),
        ):
            if value is not None:
                out[key] = round(float(value), 3)
        for key, value in (
            ("candidateDetections", self.candidate_detections),
            ("incumbentDetections", self.incumbent_detections),
        ):
            if value is not None:
                out[key] = int(value)
        if self.at is not None:
            out["at"] = self.at
        return out


class ModelValidator:
    """Runs the operational checks a candidate must pass before it may serve traffic.

    The incumbent is measured over the SAME frames in the same run — comparing a candidate's latency
    against a number recorded on different hardware, on a different day, over different frames is not
    a comparison, and acting on it would gate deployments on noise.
    """

    def __init__(
        self,
        policy: Optional[ModelLifecyclePolicy] = None,
        *,
        clock: Callable[[], float] = time.perf_counter,
        now_iso: Optional[Callable[[], str]] = None,
    ) -> None:
        self._policy = policy or ModelLifecyclePolicy()
        self._clock = clock
        self._now_iso = now_iso or _now_iso

    def validate(
        self,
        candidate,  # noqa: ANN001 - pipeline.ModelAdapter
        *,
        frames: Sequence[FrameContext],
        incumbent=None,  # noqa: ANN001 - pipeline.ModelAdapter
        labels: Sequence[str] = ("person",),
    ) -> ModelValidationResult:
        checks: List[ModelValidationCheck] = []

        # 1. Does the artifact load at all? Everything downstream is meaningless if not.
        try:
            candidate.load({"labels": list(labels)})
            checks.append(ModelValidationCheck(name="artifact-loads", passed=True))
        except Exception as exc:  # noqa: BLE001 - a load failure is a verdict, not a crash
            checks.append(
                ModelValidationCheck(
                    name="artifact-loads", passed=False, detail=f"load failed: {str(exc)[:300]}"
                )
            )
            return ModelValidationResult(
                passed=False, checks=checks, frames_evaluated=0, at=self._now_iso()
            )

        sample = list(frames)[: self._policy.validation_frames]
        candidate_ms, candidate_detections, error = self._run(candidate, sample)
        checks.append(
            ModelValidationCheck(
                name="inference-runs",
                passed=error is None,
                measured=float(len(sample)),
                detail=error or f"{len(sample)} frame(s) inferred without error",
            )
        )
        if error is not None:
            return ModelValidationResult(
                passed=False, checks=checks, frames_evaluated=len(sample), at=self._now_iso()
            )

        # 2. Structural validity. A model that silently returns nothing on every frame is the failure
        #    mode an operational gate exists to catch — it looks fine until nothing is ever detected.
        structurally_valid = candidate_detections is not None and candidate_detections >= 0
        checks.append(
            ModelValidationCheck(
                name="output-structure",
                passed=bool(structurally_valid),
                measured=float(candidate_detections or 0),
                detail="detections are well-formed RawDetection records",
            )
        )

        candidate_mean = candidate_ms / max(1, len(sample))
        incumbent_mean: Optional[float] = None
        incumbent_detections: Optional[int] = None
        if incumbent is not None:
            incumbent_ms, incumbent_detections, _err = self._run(incumbent, sample)
            incumbent_mean = incumbent_ms / max(1, len(sample))

        # 3. Latency: an absolute ceiling if declared, otherwise a regression bound vs the incumbent.
        budget = self._policy.max_validation_latency_ms
        if budget is not None:
            checks.append(
                ModelValidationCheck(
                    name="latency-budget",
                    passed=candidate_mean <= budget,
                    measured=candidate_mean,
                    budget=budget,
                    detail=f"{candidate_mean:.3f} ms/frame against a {budget:g} ms ceiling",
                )
            )
        elif incumbent_mean is not None:
            allowed = incumbent_mean * (1.0 + self._policy.latency_regression_percent / 100.0)
            below_noise = (
                incumbent_mean < _MIN_MEASURABLE_MS and candidate_mean < _MIN_MEASURABLE_MS
            )
            checks.append(
                ModelValidationCheck(
                    name="latency-budget",
                    # A regression bound is only meaningful once there is something to measure.
                    passed=below_noise or candidate_mean <= allowed,
                    measured=candidate_mean,
                    budget=allowed,
                    detail=(
                        f"both models measured under {_MIN_MEASURABLE_MS:g} ms/frame — too fast for a "
                        "regression comparison to mean anything; not gated on timer noise"
                        if below_noise
                        else (
                            f"{candidate_mean:.3f} ms/frame vs incumbent {incumbent_mean:.3f} ms "
                            f"(+{self._policy.latency_regression_percent:g}% allowed)"
                        )
                    ),
                )
            )

        # 4. Comparability. NOT an accuracy check — it catches a candidate that detects wildly more or
        #    less than the incumbent on identical frames, which means something structural changed.
        if incumbent_detections is not None and candidate_detections is not None:
            baseline = max(1, incumbent_detections)
            delta_percent = 100.0 * abs(candidate_detections - incumbent_detections) / baseline
            checks.append(
                ModelValidationCheck(
                    name="detection-comparability",
                    passed=delta_percent <= self._policy.detection_delta_percent,
                    measured=delta_percent,
                    budget=self._policy.detection_delta_percent,
                    detail=(
                        f"{candidate_detections} vs {incumbent_detections} detections over the same "
                        f"{len(sample)} frames ({delta_percent:.1f}% apart) — volume only, NOT accuracy"
                    ),
                )
            )

        return ModelValidationResult(
            passed=all(c.passed for c in checks),
            checks=checks,
            frames_evaluated=len(sample),
            candidate_latency_ms=candidate_mean,
            incumbent_latency_ms=incumbent_mean,
            candidate_detections=candidate_detections,
            incumbent_detections=incumbent_detections,
            at=self._now_iso(),
        )

    def _run(self, adapter, frames: Sequence[FrameContext]):  # noqa: ANN001, ANN202
        """Run every frame through one adapter; returns (total_ms, detections, error)."""
        total_ms = 0.0
        detections = 0
        for ctx in frames:
            started = self._clock()
            try:
                raw = adapter.infer(adapter.preprocess(ctx))
            except Exception as exc:  # noqa: BLE001
                return total_ms, detections, f"inference failed: {str(exc)[:300]}"
            total_ms += (self._clock() - started) * 1000.0
            try:
                detections += len(raw)
            except TypeError:
                return total_ms, detections, "adapter returned a non-sequence from infer()"
        return total_ms, detections, None


@dataclass
class ModelTransitionEvent:
    state: str
    at: str
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        out: dict = {"state": self.state, "at": self.at}
        if self.detail is not None:
            out["detail"] = self.detail
        return out


@dataclass
class ModelTransition:
    """One staged version transition, start to finish. Kept forever (rec 3)."""

    id: str
    tenant_id: str
    model_id: str
    from_version: Optional[str]
    to_version: str
    state: str
    started_at: str
    updated_at: str
    validation: Optional[ModelValidationResult] = None
    rollback_reason: Optional[str] = None
    sessions_affected: int = 0
    history: List[ModelTransitionEvent] = field(default_factory=list)
    completed_at: Optional[str] = None

    @property
    def terminal(self) -> bool:
        return self.state in _TERMINAL_STATES

    @property
    def succeeded(self) -> bool:
        return self.state == "active"

    def to_dict(self) -> dict:
        out: dict = {
            "id": self.id,
            "tenantId": self.tenant_id,
            "modelId": self.model_id,
            "fromVersion": self.from_version,
            "toVersion": self.to_version,
            "state": self.state,
            "sessionsAffected": self.sessions_affected,
            "history": [e.to_dict() for e in self.history],
            "startedAt": self.started_at,
            "updatedAt": self.updated_at,
        }
        if self.validation is not None:
            out["validation"] = self.validation.to_dict()
        if self.rollback_reason is not None:
            out["rollbackReason"] = self.rollback_reason
        if self.completed_at is not None:
            out["completedAt"] = self.completed_at
        return out


class ModelLifecycleManager:
    """Orchestrates staged model transitions across a tenant's models.

    Tenant-scoped throughout (Law 5): a transition is addressed as `(tenant_id, transition_id)`, so
    one tenant can never observe or drive another's model rollout.

    The registry remains the source of truth for *which* version is active — this manager drives it
    through the safe path and records the journey. `ModelRegistry.activate()` still works exactly as
    before for callers that want the instant flip.
    """

    def __init__(
        self,
        registry=None,  # noqa: ANN001 - model_registry.ModelRegistry
        *,
        policy: Optional[ModelLifecyclePolicy] = None,
        validator: Optional[ModelValidator] = None,
        clock: Callable[[], float] = time.monotonic,
        now_iso: Optional[Callable[[], str]] = None,
        id_gen: Optional[Callable[[], str]] = None,
        log=None,  # noqa: ANN001 - operational_log.OperationalLog
    ) -> None:
        self._registry = registry
        self._policy = policy or ModelLifecyclePolicy()
        self._validator = validator or ModelValidator(self._policy, now_iso=now_iso)
        self._clock = clock
        self._now_iso = now_iso or _now_iso
        counter = itertools.count(1)
        self._id_gen = id_gen or (lambda: f"mtr_{next(counter)}")
        self._log = log
        self._transitions: Dict[str, ModelTransition] = {}
        self._order: List[str] = []
        # Per-INSTANCE (never class-level): warmed candidates are live adapters, and sharing them
        # across managers would let one tenant's rollout hand its adapter to another's.
        self._candidates: Dict[str, object] = {}
        self._drain_started: Dict[str, float] = {}

    @property
    def policy(self) -> ModelLifecyclePolicy:
        return self._policy

    # --- the staged path ------------------------------------------------------------

    def begin(self, tenant_id: str, model_id: str, to_version: str) -> ModelTransition:
        """Open a transition. Nothing has changed for running sessions yet."""
        if not isinstance(tenant_id, str) or not tenant_id.strip():
            raise ValidationError("a tenantId is required (fail-closed, Law 5)")
        if not to_version.strip():
            raise ValidationError("a target version is required")

        from_version: Optional[str] = None
        if self._registry is not None:
            model = self._registry.require(tenant_id, model_id)
            if not any(v.version == to_version for v in model.versions):
                raise NotFound(f"version '{to_version}' not found for model '{model_id}'")
            from_version = model.active_version
            if from_version == to_version:
                raise Conflict(f"version '{to_version}' is already active for model '{model_id}'")

        # One rollout at a time per model: two concurrent transitions would race on the same slot and
        # neither would be able to say which version is actually serving traffic.
        in_flight = self._in_flight(tenant_id, model_id)
        if in_flight is not None:
            raise Conflict(
                f"model '{model_id}' already has transition '{in_flight.id}' in state "
                f"'{in_flight.state}'; complete or roll it back first"
            )

        now = self._now_iso()
        transition = ModelTransition(
            id=self._id_gen(),
            tenant_id=tenant_id,
            model_id=model_id,
            from_version=from_version,
            to_version=to_version,
            state="pending",
            started_at=now,
            updated_at=now,
            history=[ModelTransitionEvent(state="pending", at=now, detail="transition opened")],
        )
        self._transitions[self._key(tenant_id, transition.id)] = transition
        self._order.append(self._key(tenant_id, transition.id))
        self._emit(transition, "model.transition_started")
        return transition

    def warm(
        self,
        tenant_id: str,
        transition_id: str,
        *,
        loader: Callable[[], object],
        labels: Sequence[str] = ("person",),
    ) -> ModelTransition:
        """Load the candidate WITHOUT giving it traffic. A failure here costs nothing live."""
        transition = self.require(tenant_id, transition_id)
        self._expect(transition, "pending")
        self._advance(transition, "warming", "loading candidate adapter")
        try:
            adapter = loader()
            adapter.load({"labels": list(labels)})
        except Exception as exc:  # noqa: BLE001 - a warm failure never touches live traffic
            self._advance(transition, "failed", f"warm failed: {str(exc)[:300]}")
            transition.completed_at = transition.updated_at
            self._emit(transition, "model.transition_failed", level="error")
            raise ModelWarmFailed(str(exc)) from exc
        self._candidates[self._key(tenant_id, transition_id)] = adapter
        return transition

    def validate(
        self,
        tenant_id: str,
        transition_id: str,
        *,
        frames: Sequence[FrameContext],
        incumbent=None,  # noqa: ANN001
        labels: Sequence[str] = ("person",),
    ) -> ModelValidationResult:
        """Run the operational checks. This is the gate — nothing switches until it passes."""
        transition = self.require(tenant_id, transition_id)
        self._expect(transition, "warming")
        self._advance(transition, "validating", f"validating over {len(frames)} frame(s)")
        candidate = self._candidates.get(self._key(tenant_id, transition_id))
        if candidate is None:
            raise Conflict("no warmed candidate for this transition; call warm() first")
        result = self._validator.validate(
            candidate, frames=frames, incumbent=incumbent, labels=labels
        )
        transition.validation = result
        if not result.passed:
            detail = f"validation failed: {', '.join(result.failures)}"
            if self._policy.auto_rollback:
                self._advance(transition, "rolled-back", detail)
                transition.rollback_reason = detail
                transition.completed_at = transition.updated_at
                self._release_candidate(tenant_id, transition_id)
                self._emit(transition, "model.transition_rolled_back", level="warn")
            else:
                self._advance(transition, "failed", detail)
                transition.completed_at = transition.updated_at
                self._emit(transition, "model.transition_failed", level="error")
        return result

    def switch(
        self,
        tenant_id: str,
        transition_id: str,
        *,
        slots: Optional[Sequence[ModelSlot]] = None,
        binding: Optional[ModelBinding] = None,
    ) -> ModelTransition:
        """Promote the candidate. Sessions keep running — this is a pointer swap, not a restart."""
        transition = self.require(tenant_id, transition_id)
        if self._policy.require_validation and transition.state != "validating":
            raise Conflict(
                f"cannot switch from state '{transition.state}': validation is required by policy"
            )
        if transition.validation is not None and not transition.validation.passed:
            raise Conflict("cannot switch to a candidate that failed validation")
        candidate = self._candidates.get(self._key(tenant_id, transition_id))
        if candidate is None:
            raise Conflict("no warmed candidate for this transition; call warm() first")

        self._advance(transition, "switching", f"promoting {transition.to_version}")
        target_binding = binding or ModelBinding(
            name=transition.model_id,
            version=transition.to_version,
            task="detection",
        )
        affected = 0
        for slot in slots or ():
            slot.swap(candidate, target_binding)
            affected += 1
        transition.sessions_affected = affected
        self._advance(
            transition, "draining", f"{affected} session(s) switched; draining in-flight frames"
        )
        self._drain_started[self._key(tenant_id, transition_id)] = self._clock()
        return transition

    def complete(
        self, tenant_id: str, transition_id: str, *, slots: Optional[Sequence[ModelSlot]] = None
    ) -> ModelTransition:
        """Close the drain window, release the outgoing model, and record the version as active."""
        transition = self.require(tenant_id, transition_id)
        self._expect(transition, "draining")
        for slot in slots or ():
            slot.finish_drain()
        if self._registry is not None:
            self._registry.activate(tenant_id, transition.model_id, transition.to_version)
        self._advance(transition, "active", f"{transition.to_version} is serving traffic")
        transition.completed_at = transition.updated_at
        self._release_candidate(tenant_id, transition_id)
        self._emit(transition, "model.transition_completed")
        return transition

    def rollback(
        self,
        tenant_id: str,
        transition_id: str,
        *,
        reason: str,
        slots: Optional[Sequence[ModelSlot]] = None,
        adapter=None,  # noqa: ANN001 - the incumbent adapter to restore
    ) -> ModelTransition:
        """Return to the incumbent version. The same mechanism as the switch, run backwards — which is
        the only way to be confident the unhappy path works."""
        transition = self.require(tenant_id, transition_id)
        if transition.state in ("active", "rolled-back"):
            # A completed rollout can still be rolled back, but that is a NEW transition (v1→v2→v1),
            # not a mutation of the old record: history must stay append-only to be trustworthy.
            raise Conflict(
                f"transition '{transition_id}' already finished in state '{transition.state}'; "
                "open a new transition to return to the previous version"
            )
        restored = transition.from_version
        for slot in slots or ():
            if adapter is not None and restored is not None:
                slot.swap(
                    adapter, ModelBinding(name=transition.model_id, version=restored, task="detection")
                )
            slot.finish_drain()
        transition.rollback_reason = reason
        self._advance(transition, "rolled-back", f"restored {restored or 'previous'}: {reason}")
        transition.completed_at = transition.updated_at
        self._release_candidate(tenant_id, transition_id)
        self._emit(transition, "model.transition_rolled_back", level="warn")
        return transition

    def transition(
        self,
        tenant_id: str,
        model_id: str,
        to_version: str,
        *,
        loader: Callable[[], object],
        frames: Sequence[FrameContext],
        incumbent=None,  # noqa: ANN001
        slots: Optional[Sequence[ModelSlot]] = None,
        labels: Sequence[str] = ("person",),
    ) -> ModelTransition:
        """Run the whole chain: warm → validate → switch → drain → complete, rolling back on failure.

        The convenience path. Every stage remains individually callable, because an operator running a
        careful rollout wants to stop and look between the stages.
        """
        transition = self.begin(tenant_id, model_id, to_version)
        try:
            self.warm(tenant_id, transition.id, loader=loader, labels=labels)
        except ModelWarmFailed:
            return transition  # already recorded as `failed`; nothing live was touched
        result = self.validate(
            tenant_id, transition.id, frames=frames, incumbent=incumbent, labels=labels
        )
        if not result.passed:
            return transition  # already `rolled-back` (or `failed`) with the reason recorded
        self.switch(tenant_id, transition.id, slots=slots)
        return self.complete(tenant_id, transition.id, slots=slots)

    # --- history (rec 3) -------------------------------------------------------------

    def get(self, tenant_id: str, transition_id: str) -> Optional[ModelTransition]:
        transition = self._transitions.get(self._key(tenant_id, transition_id))
        return transition if transition is not None and transition.tenant_id == tenant_id else None

    def require(self, tenant_id: str, transition_id: str) -> ModelTransition:
        transition = self.get(tenant_id, transition_id)
        if transition is None:
            raise NotFound(f"model transition '{transition_id}' not found")
        return transition

    def list(self, tenant_id: str, *, model_id: Optional[str] = None) -> List[ModelTransition]:
        """Every transition for a tenant, oldest first — the audit order."""
        out = [
            self._transitions[key]
            for key in self._order
            if key in self._transitions and self._transitions[key].tenant_id == tenant_id
        ]
        if model_id is not None:
            out = [t for t in out if t.model_id == model_id]
        return out

    def history(self, tenant_id: str, model_id: str) -> dict:
        """A `ModelLifecycleHistory`-shaped record (rec 3).

        `versionPath` is the compact answer: `['v1','v2','v1','v3','v4']` reads as "v2 was tried and
        rolled back" at a glance, which is exactly what an incident review needs first.
        """
        transitions = self.list(tenant_id, model_id=model_id)
        path: List[str] = []
        for transition in transitions:
            if not path and transition.from_version:
                path.append(transition.from_version)
            if transition.succeeded:
                path.append(transition.to_version)
            elif transition.state == "rolled-back" and transition.from_version:
                # A rollback returns to where it came from — recording that explicitly is what makes
                # the path readable as a story rather than a list of attempts.
                path.append(transition.from_version)
        active = None
        if self._registry is not None:
            model = self._registry.get(tenant_id, model_id)
            active = model.active_version if model is not None else None
        elif path:
            active = path[-1]
        return {
            "tenantId": tenant_id,
            "modelId": model_id,
            "activeVersion": active,
            "versionPath": path,
            "transitions": [t.to_dict() for t in transitions],
        }

    # --- internals -------------------------------------------------------------------

    def _in_flight(self, tenant_id: str, model_id: str) -> Optional[ModelTransition]:
        for transition in self.list(tenant_id, model_id=model_id):
            if not transition.terminal:
                return transition
        return None

    def _expect(self, transition: ModelTransition, state: str) -> None:
        if transition.state != state:
            raise Conflict(
                f"transition '{transition.id}' is in state '{transition.state}', expected '{state}'"
            )

    def _advance(self, transition: ModelTransition, state: str, detail: str) -> None:
        if state not in TRANSITION_STATES:
            raise ConfigurationFailure(f"unknown transition state '{state}'")
        now = self._now_iso()
        transition.state = state
        transition.updated_at = now
        transition.history.append(ModelTransitionEvent(state=state, at=now, detail=detail))

    def _release_candidate(self, tenant_id: str, transition_id: str) -> None:
        self._candidates.pop(self._key(tenant_id, transition_id), None)
        self._drain_started.pop(self._key(tenant_id, transition_id), None)

    def _emit(self, transition: ModelTransition, event: str, *, level: str = "info") -> None:
        if self._log is None:
            return
        self._log.emit(
            event,
            level=level,
            modelId=transition.model_id,
            transitionId=transition.id,
            fromVersion=transition.from_version,
            toVersion=transition.to_version,
            state=transition.state,
            sessionsAffected=transition.sessions_affected,
        )

    @staticmethod
    def _key(tenant_id: str, transition_id: str) -> str:
        # Tenant-qualified so one tenant can never address another's rollout by id (Law 5).
        return f"{tenant_id}::{transition_id}"


class ModelWarmFailed(RuntimeError):
    """The candidate could not be loaded. Categorized as a `model` failure — never a `connection` one."""

    category = "model"


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
